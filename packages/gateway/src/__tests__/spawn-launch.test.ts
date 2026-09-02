// R36-SPAWN.1 — `SessionSpawner.launch()`: the argv the daemon builds, the cwd it runs in, the
// credentials it narrows, and the post-spawn block it shares with `resume()`. Class 2: real children,
// real sockets, no daemon and no wire. `launch()` has no production caller yet; wave 4 wires it.

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnArgv } from "../session/spawn-argv.js";
import {
	DECLARED_CREDENTIAL_ENV,
	type ResolvedExecutable,
	type SessionLaunchRequest,
	SessionSpawner,
	SpawnRefusedError,
} from "../session/spawn-primitive.js";
import {
	isProcessAlive,
	reapPgids,
	rowFor,
	uniqueMarker,
	waitForGroupGone,
	waitForProcessesGone,
} from "./helpers/process-table.js";

const SPAWN_PRIMITIVE = join(import.meta.dir, "../session/spawn-primitive.ts");

const dirs: string[] = [];
const pgids = new Set<number>();

afterAll(() => {
	reapPgids(pgids);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Directly under /tmp with a short name: a unix socket path over ~104 bytes fails to bind with EINVAL. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	dirs.push(dir);
	return dir;
}

const SESSION_ID = "spl-session";

/** Reports what it was given, then claims the lock and the socket the poll is waiting for. */
const BINDS_AND_REPORTS = `#!/bin/sh
printf '%s\\n' "$0" "$@" > DIR/argv.tmp && mv DIR/argv.tmp DIR/argv
env > DIR/env.tmp && mv DIR/env.tmp DIR/env
pwd > DIR/cwd.tmp && mv DIR/cwd.tmp DIR/cwd
sleep 3600 &
{ echo "$$"; echo "$!"; } > DIR/pids.tmp && mv DIR/pids.tmp DIR/pids
echo "$$" > DIR/SID.lock.tmp && mv DIR/SID.lock.tmp DIR/SID.lock
: > DIR/SID.sock
wait
`;

const SILENT_AND_BINDS_NOTHING = `#!/bin/sh
echo "$$" > DIR/pids.tmp && mv DIR/pids.tmp DIR/pids
exec sleep 3600
`;

const REFUSES_LOUDLY = `#!/bin/sh
echo "draht stub: no harness by that name" >&2
exit 3
`;

interface Harness {
	spawner: SessionSpawner;
	dir: string;
	projectRoot: string;
	leadingArgs: string[];
	request: SessionLaunchRequest;
}

function harness(
	script: string,
	options: Partial<ConstructorParameters<typeof SessionSpawner>[0]> = {},
	credentialEnv: readonly string[] = [],
): Harness {
	const dir = tempDir("spl-");
	const projectRoot = tempDir("splp-");
	const scriptPath = join(dir, "child.sh");
	writeFileSync(scriptPath, script.replaceAll("DIR", dir).replaceAll("SID", SESSION_ID), { mode: 0o755 });
	// A marker nothing else on this box carries, so a leaked row is identifiable in `ps`.
	const leadingArgs = [scriptPath, uniqueMarker("spl")];
	const spawner = new SessionSpawner({ socketDir: dir, agentDir: dir, ...options });
	return {
		spawner,
		dir,
		projectRoot,
		leadingArgs,
		request: { sessionId: SESSION_ID, executable: "/bin/sh", leadingArgs, projectRoot, credentialEnv },
	};
}

async function refusalOf(pending: Promise<unknown>): Promise<SpawnRefusedError> {
	try {
		await pending;
	} catch (error) {
		if (error instanceof SpawnRefusedError) return error;
		throw error;
	}
	throw new Error("expected a SpawnRefusedError, and the call resolved");
}

function lines(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").slice(0, -1);
}

function childEnv(dir: string): Map<string, string> {
	const env = new Map<string, string>();
	for (const line of lines(join(dir, "env"))) {
		const at = line.indexOf("=");
		if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
	}
	return env;
}

/** The leader and the grandchild {@link BINDS_AND_REPORTS} forked, once the launch has returned. */
function reportedPids(dir: string): [number, number] {
	return lines(join(dir, "pids")).map(Number) as [number, number];
}

/** A refusal can beat the child to its own pid file, so this waits rather than reading straight through. */
async function reportedPidsWhenWritten(dir: string, timeoutMs = 20_000): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(join(dir, "pids"))) {
			const pids = lines(join(dir, "pids")).map(Number);
			if (pids.length > 0 && pids.every((pid) => Number.isInteger(pid) && pid > 1)) return pids;
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${dir}/pids`);
}

test("a launch returns the pid of the child that claimed the lock and the socket", async () => {
	const { spawner, dir, request } = harness(BINDS_AND_REPORTS);
	const { pid } = await spawner.launch(request);
	pgids.add(pid);

	expect(reportedPids(dir)[0]).toBe(pid);
	expect(readFileSync(join(dir, `${SESSION_ID}.lock`), "utf8").trim()).toBe(String(pid));
	expect(existsSync(join(dir, `${SESSION_ID}.sock`))).toBe(true);
}, 120_000);

test("the argv the child actually received is buildSpawnArgv's, element for element", async () => {
	const { spawner, dir, projectRoot, leadingArgs, request } = harness(BINDS_AND_REPORTS);
	const { pid } = await spawner.launch(request);
	pgids.add(pid);

	expect(lines(join(dir, "argv"))).toEqual(buildSpawnArgv({ sessionId: SESSION_ID, projectRoot, leadingArgs }));
}, 120_000);

test("the child runs in the project root, not in the daemon's own directory", async () => {
	const { spawner, dir, projectRoot, request } = harness(BINDS_AND_REPORTS);
	const { pid } = await spawner.launch(request);
	pgids.add(pid);

	expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(realpathSync(projectRoot));
}, 120_000);

test("a child that never binds is refused `timeout`, is named as the spawned session, and is left dead", async () => {
	const { spawner, dir, request } = harness(SILENT_AND_BINDS_NOTHING, {
		handshakeDeadlineMs: 1_500,
		stopDeadlineMs: 300,
	});
	const refused = await refusalOf(spawner.launch(request));

	expect(refused.code).toBe("timeout");
	expect(refused.message).toBe("the spawned session did not publish its socket within 1500 ms and never said a word");

	const [leader] = (await reportedPidsWhenWritten(dir)) as [number];
	await waitForProcessesGone([leader]);
	// `isProcessAlive` reads `stat=` from `ps -A`: `kill(pid, 0)` succeeds on a zombie.
	expect(isProcessAlive(leader)).toBe(false);
}, 120_000);

test("a child that exits immediately is refused `spawn_failed` and its stderr is quoted", async () => {
	const { spawner, request } = harness(REFUSES_LOUDLY, { stopDeadlineMs: 300 });
	const refused = await refusalOf(spawner.launch(request));

	expect(refused.code).toBe("spawn_failed");
	expect(refused.message).toContain("the spawned session exited before publishing its socket");
	expect(refused.message).toContain("draht stub: no harness by that name");
}, 120_000);

test("`credentialEnv: []` crosses no credential at all, while the base environment still crosses", async () => {
	const { spawner, dir, request } = harness(BINDS_AND_REPORTS, {
		env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-anthropic", OPENAI_API_KEY: "sk-openai" },
	});
	const { pid } = await spawner.launch(request);
	pgids.add(pid);
	const env = childEnv(dir);

	expect(env.has("ANTHROPIC_API_KEY")).toBe(false);
	expect(env.has("OPENAI_API_KEY")).toBe(false);
	// The positive control: without it a `buildChildEnvironment` returning nothing would pass.
	expect(env.get("HOME")).toBe("/tmp");
	expect(env.get("PATH")).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
}, 120_000);

test("a populated `credentialEnv` crosses exactly the names it declares and no others", async () => {
	const { spawner, dir, request } = harness(
		BINDS_AND_REPORTS,
		{ env: { HOME: "/tmp", ANTHROPIC_API_KEY: "sk-anthropic", OPENAI_API_KEY: "sk-openai" } },
		["ANTHROPIC_API_KEY"],
	);
	const { pid } = await spawner.launch(request);
	pgids.add(pid);
	const env = childEnv(dir);

	expect(env.get("ANTHROPIC_API_KEY")).toBe("sk-anthropic");
	expect(env.has("OPENAI_API_KEY")).toBe(false);
}, 120_000);

test("the blocklist beats a registry that declares a loader variable", async () => {
	const { spawner, dir, request } = harness(
		BINDS_AND_REPORTS,
		{ env: { HOME: "/tmp", LD_PRELOAD: "/tmp/evil.so", ANTHROPIC_API_KEY: "sk-anthropic" } },
		["LD_PRELOAD", "ANTHROPIC_API_KEY"],
	);
	const { pid } = await spawner.launch(request);
	pgids.add(pid);
	const env = childEnv(dir);

	expect(env.has("LD_PRELOAD")).toBe(false);
	expect(env.get("ANTHROPIC_API_KEY")).toBe("sk-anthropic");
}, 120_000);

test("a resume declares no credentialEnv and still receives every declared credential", async () => {
	const declared = Object.fromEntries(DECLARED_CREDENTIAL_ENV.map((name) => [name, `value-of-${name}`]));
	const { dir, projectRoot, leadingArgs } = harness(BINDS_AND_REPORTS);
	const spawner = new SessionSpawner({
		socketDir: dir,
		agentDir: dir,
		env: { HOME: "/tmp", ...declared },
		resolveExecutable: (): ResolvedExecutable => ({
			executable: "/bin/sh",
			leadingArgs,
			target: leadingArgs[0] as string,
		}),
	});
	const { pid } = await spawner.resume({ id: SESSION_ID, path: join(projectRoot, "s.jsonl"), cwd: projectRoot });
	pgids.add(pid);
	const env = childEnv(dir);

	for (const name of DECLARED_CREDENTIAL_ENV) expect(env.get(name)).toBe(`value-of-${name}`);
}, 120_000);

test("stop() on a launched child reaches its whole group, grandchild included", async () => {
	const { spawner, dir, request } = harness(BINDS_AND_REPORTS, { stopDeadlineMs: 500 });
	const { pid } = await spawner.launch(request);
	pgids.add(pid);
	const [leader, grandchild] = reportedPids(dir);

	expect(leader).toBe(pid);
	expect(rowFor(leader)?.pgid).toBe(leader);
	expect(isProcessAlive(grandchild)).toBe(true);

	await spawner.stop(pid);
	await waitForGroupGone(leader);
	expect(isProcessAlive(grandchild)).toBe(false);
}, 120_000);

test("a launch whose executable cannot be spawned is refused with what the failed spawn reported", async () => {
	const { spawner, dir, request } = harness(SILENT_AND_BINDS_NOTHING);
	const refused = await refusalOf(spawner.launch({ ...request, executable: join(dir, "not-a-program") }));

	// The `error` event carries this and arrives asynchronously; a listener attached any later than the
	// line after `spawn` is an uncaught exception that takes the daemon down instead.
	expect(refused.code).toBe("spawn_failed");
	expect(refused.message).toContain("ENOENT");
}, 120_000);

test("a socket this launch's own child did not bind is `already_live`, not success", async () => {
	const { spawner, dir, request } = harness(SILENT_AND_BINDS_NOTHING, { stopDeadlineMs: 300 });
	const foreign = spawn("/bin/sh", ["-c", "exec sleep 60"], { stdio: "ignore" });
	const foreignPid = foreign.pid as number;
	writeFileSync(join(dir, `${SESSION_ID}.lock`), `${foreignPid}\n`);
	writeFileSync(join(dir, `${SESSION_ID}.sock`), "");

	const refused = await refusalOf(spawner.launch(request));
	expect(refused.code).toBe("already_live");
	expect(refused.message).toContain(`PID ${foreignPid}`);
	foreign.kill("SIGKILL");
}, 120_000);

test("a launch into a project root that no longer exists is refused before any process exists", async () => {
	const { spawner, request, projectRoot } = harness(BINDS_AND_REPORTS);
	rmSync(projectRoot, { recursive: true, force: true });
	const refused = await refusalOf(spawner.launch(request));

	expect(refused.code).toBe("cwd_missing");
	expect(existsSync(join(request.projectRoot, "..", "argv"))).toBe(false);
}, 120_000);

test("a launch into a project the operator marked untrusted is refused, `--no-approve` notwithstanding", async () => {
	const { spawner, dir, request, projectRoot } = harness(BINDS_AND_REPORTS);
	writeFileSync(join(dir, "trust.json"), JSON.stringify({ [realpathSync(projectRoot)]: false }));
	const refused = await refusalOf(spawner.launch(request));

	expect(refused.code).toBe("refused");
	expect(refused.message).toContain(projectRoot);
	expect(existsSync(join(dir, "argv"))).toBe(false);
}, 120_000);

/** In a process of its OWN: the defect is a daemon that cannot exit, which nothing in-process can observe. */
const EXIT_PROBE = `import { writeFileSync } from "node:fs";
import { SessionSpawner } from "SPAWN_PRIMITIVE";

const [socketDir, scriptPath, projectRoot, tripwire] = process.argv.slice(2);
const { pid } = await new SessionSpawner({ socketDir, agentDir: socketDir }).launch({
	sessionId: "SID",
	executable: "/bin/sh",
	leadingArgs: [scriptPath],
	projectRoot,
	credentialEnv: [],
});
writeFileSync(tripwire, String(pid));
`;

test("a released child leaves the daemon able to exit, pipes and all", async () => {
	const { dir, projectRoot, leadingArgs } = harness(BINDS_AND_REPORTS);
	const probePath = join(dir, "probe.ts");
	writeFileSync(probePath, EXIT_PROBE.replace("SPAWN_PRIMITIVE", SPAWN_PRIMITIVE).replace("SID", SESSION_ID));
	const tripwire = join(dir, "tripwire");
	const probe = spawn(process.execPath, [probePath, dir, leadingArgs[0] as string, projectRoot, tripwire], {
		detached: true,
		stdio: "ignore",
	});
	const probePid = probe.pid as number;
	pgids.add(probePid);

	const exited = await Promise.race([
		new Promise<boolean>((done) => probe.once("exit", () => done(true))),
		Bun.sleep(30_000).then(() => false),
	]);
	expect(exited, "the probe never exited: a ref'd handle survived #release").toBe(true);
	pgids.add(Number(readFileSync(tripwire, "utf8")));
}, 120_000);

test("the post-spawn block exists once in spawn-primitive.ts, not once per origin", () => {
	// The two lines whose duplication IS the defect, and the two the open posture decisions pin.
	const source = readFileSync(SPAWN_PRIMITIVE, "utf8");
	for (const anchor of ['stdio: ["pipe", "ignore", "pipe"]', "detached: this.#detached"]) {
		expect(source.split(anchor).length - 1, `${anchor} is not where this test thinks it is`).toBe(1);
	}
});
