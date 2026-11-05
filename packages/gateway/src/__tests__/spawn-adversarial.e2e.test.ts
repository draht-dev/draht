/**
 * R36-SPAWN.1, R36-SPAWN.2, R36-SPAWN.3, R36-SPAWN.7, R36-SPAWN.8 — every refusal fixture, the wedged child and the
 * server-side command refusal, against the emitted daemon.
 *
 * Every negative is a tripwire: a refused fixture names an executable that writes a marker as its first act, so "nothing
 * was started" means the marker is absent after a quiet period, the daemon's descendant set is unchanged and /health
 * still answers. Case 1 is the positive control that shows this oracle can see a tripwire fire.
 *
 * The cases share one daemon whose registry file is changed between them, and run in order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { type GeistConfig, loadGeistConfigFile, type SessionSpawnedFrame } from "@draht/geist-protocol";
import {
	describeRows,
	foreignOwnedFileIn,
	isProcessAlive,
	liveGroupMembers,
	psRows,
	reapPgids,
	rowFor,
	uniqueMarker,
} from "./helpers/process-table.js";
import {
	AttachClient,
	DaemonStartError,
	descendantPids,
	type EmittedDaemon,
	jsFixture,
	shortBase,
	shTripwire,
	startEmittedDaemon,
	writeRegistry,
} from "./helpers/spawn-daemon.js";

const RUN = uniqueMarker("adv");
const OUR_UID = process.getuid?.() ?? -1;
const WEDGE_MARKER = `${RUN}-wedge`;
const QUIET_MS = 500;
const CASE_TIMEOUT_MS = 30_000;
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const TRIPWIRE_NAMES = ["control", "smuggled", "project", "cwd", "shim", "inProject", "linked", "writable"] as const;
type TripwireName = (typeof TRIPWIRE_NAMES)[number];
type Firings = Record<TripwireName, string[]>;
interface Tripwire {
	path: string;
	marker: string;
}

const NONE: Firings = {
	control: [],
	smuggled: [],
	project: [],
	cwd: [],
	shim: [],
	inProject: [],
	linked: [],
	writable: [],
};

const pgids = new Set<number>();
const clients: AttachClient[] = [];
const daemons: EmittedDaemon[] = [];
const scratch: string[] = [];

let base: string;
let regDir: string;
let regFile: string;
let pxRoot: string;
let wedgeScript: string;
let pidsFile: string;
let termLog: string;
let linkedCmd: string;
let writableDir: string;
let tripwires: Record<TripwireName, Tripwire>;
let daemon: EmittedDaemon;
let daemonEnv: Record<string, string>;

type ForeignProbe = { usable: true } | { usable: false; reason: string };

/** On CI an unavailable route throws from the helper; that is left to fail case 5 itself, never to skip it. */
function probeForeignOwnedFile(): ForeignProbe {
	const probeDir = shortBase("p36adv-f-");
	try {
		const made = foreignOwnedFileIn(probeDir);
		return "unavailable" in made ? { usable: false, reason: made.unavailable } : { usable: true };
	} catch {
		return { usable: true };
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

const foreignProbe = probeForeignOwnedFile();
if (!foreignProbe.usable) {
	console.warn(`[spawn-adversarial] case 5 (foreign-owner on file) SKIPPED on this host: ${foreignProbe.reason}`);
}
const foreignCase = test.skipIf(!foreignProbe.usable);

async function until<T>(probe: () => T | undefined | false | null, what: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value as T;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(25);
	}
}

function firings(): Firings {
	const seen = { ...NONE };
	for (const name of TRIPWIRE_NAMES) {
		const { marker } = tripwires[name];
		seen[name] = existsSync(marker) ? readFileSync(marker, "utf8").trimEnd().split("\n") : [];
	}
	return seen;
}

function disarm(): void {
	for (const name of TRIPWIRE_NAMES) rmSync(tripwires[name].marker, { force: true });
}

function registryFor(cmd: string): GeistConfig {
	return {
		harness: { default: "draht", agents: { draht: { cmd } } },
		projects: { px: { root: pxRoot } },
		approvedRoots: [base],
	};
}

function clearRegistryDir(): void {
	for (const path of [regDir, `${regDir}-moved`]) {
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path);
		else rmSync(path, { recursive: true, force: true });
	}
}

/** From scratch every time, so a case never inherits the link or the odd mode its predecessor left. */
function installRegistry(cmd: string = tripwires.control.path, mode = 0o600): void {
	clearRegistryDir();
	writeRegistry(regFile, registryFor(cmd), mode);
}

async function healthy(target: EmittedDaemon = daemon): Promise<void> {
	expect((await fetch(`${target.httpBase}/health`)).status).toBe(200);
}

async function connect(target: EmittedDaemon = daemon): Promise<AttachClient> {
	const client = await AttachClient.open(target.wsBase, target.token);
	clients.push(client);
	await client.hello();
	return client;
}

/** One frame on a fresh connection, a quiet period, and the checks every case shares: nothing new below the daemon, /health up. */
async function spawnFrame(
	frame: Record<string, unknown>,
	target: EmittedDaemon = daemon,
): Promise<SessionSpawnedFrame> {
	const client = await connect(target);
	const before = descendantPids(target.pid);
	const answer = await client.ask(frame, "session_spawned", 20_000);
	await Bun.sleep(QUIET_MS);
	expect(descendantPids(target.pid)).toEqual(before);
	await healthy(target);
	return answer;
}

function spawnOf(harnessId: string, projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "session_spawn", harnessId, projectId, ...extra };
}

function expectAnswer(answer: SessionSpawnedFrame, code: SessionSpawnedFrame["code"], clause: string): void {
	expect(answer.ok).toBe(false);
	expect(answer.sessionId).toBeUndefined();
	expect(answer.code).toBe(code);
	expect(answer.message).toContain(clause);
}

function expectNothingFired(): void {
	expect(firings()).toEqual(NONE);
}

/** The control harness ran exactly once and no other tripwire fired; returns the line the control wrote. */
function expectOnlyControlRan(): string {
	const fired = firings();
	expect(fired.control).toHaveLength(1);
	expect({ ...fired, control: [] as string[] }).toEqual(NONE);
	return fired.control[0] ?? "";
}

/** `spawn_failed` is the answer for a harness that ran and exited without a socket, so the control's own marker is the proof it ran. */
async function expectControlRuns(): Promise<void> {
	const answer = await spawnFrame(spawnOf("draht", "px"));

	expectAnswer(answer, "spawn_failed", "the spawned session exited before publishing its socket: exit code 0");
	const line = expectOnlyControlRan();
	expect(line).toStartWith(`${tripwires.control.path} --session-id `);
	expect(line).toEndWith(` --context-root ${pxRoot}`);
}

function firstTermAt(): number | undefined {
	if (!existsSync(termLog)) return undefined;
	const first = readFileSync(termLog, "utf8").split("\n")[0];
	return first === undefined || first === "" ? undefined : Number(first);
}

/** The child's own TERM timestamp against the kernel's first sight of its group empty; zombies do not count as members. */
async function watchGroupDeath(pgid: number): Promise<{ termAt: number; deathAt: number }> {
	const noTermBy = Date.now() + 100_000;
	for (;;) {
		const termAt = firstTermAt();
		if (termAt === undefined) {
			if (Date.now() > noTermBy) throw new Error("the wedge child never logged a SIGTERM");
			await Bun.sleep(100);
			continue;
		}
		const alive = liveGroupMembers(pgid);
		if (alive.length === 0) return { termAt, deathAt: Date.now() };
		if (Date.now() > termAt + 10_000) {
			throw new Error(`process group ${pgid} still held ${describeRows(alive)} 10 s after the SIGTERM`);
		}
		await Bun.sleep(20);
	}
}

function readPids(): { child: number; grandchild: number } | undefined {
	return existsSync(pidsFile) ? JSON.parse(readFileSync(pidsFile, "utf8")) : undefined;
}

beforeAll(async () => {
	// The ownership walk refuses a group-writable directory, and a runner with umask 002 would make every fixture one.
	const umask = process.umask(0o022);
	try {
		base = shortBase("p36adv-");
		scratch.push(base);
		const home = join(base, "home");
		const agentDir = join(base, "agent");
		const shimDir = join(base, "shim");
		const binDir = join(base, "bin");
		const realDir = join(base, "real");
		const markersDir = join(base, "markers");
		writableDir = join(base, "wdir");
		pxRoot = join(base, "px");
		regDir = join(base, "reg");
		regFile = join(regDir, "config.yaml");
		for (const dir of [
			home,
			agentDir,
			shimDir,
			binDir,
			realDir,
			writableDir,
			markersDir,
			join(pxRoot, "node_modules", ".bin"),
		]) {
			mkdirSync(dir, { recursive: true });
		}

		const at = (name: TripwireName, path: string): Tripwire => ({
			path: shTripwire(path, join(markersDir, name)),
			marker: join(markersDir, name),
		});
		tripwires = {
			control: at("control", join(binDir, "draht-control")),
			smuggled: at("smuggled", join(binDir, "smuggled")),
			project: at("project", join(binDir, "project-declared")),
			cwd: at("cwd", join(pxRoot, "draht")),
			shim: at("shim", join(shimDir, "draht")),
			inProject: at("inProject", join(pxRoot, "node_modules", ".bin", "draht")),
			linked: at("linked", join(realDir, "draht-linked")),
			writable: at("writable", join(writableDir, "draht-writable")),
		};
		symlinkSync(realDir, join(base, "linkdir"));
		linkedCmd = join(base, "linkdir", "draht-linked");
		chmodSync(writableDir, 0o775);

		// Each tripwire is shown to fire under the PATH a spawned child gets, then disarmed: without this an absent marker proves nothing.
		for (const name of TRIPWIRE_NAMES) {
			const { path, marker } = tripwires[name];
			const run = Bun.spawnSync(["/usr/bin/env", "-i", `PATH=${CHILD_PATH}`, path, "arm"]);
			if (run.exitCode !== 0) throw new Error(`tripwire ${name} exited ${run.exitCode}: ${run.stderr.toString()}`);
			if (readFileSync(marker, "utf8") !== `${path} arm\n`)
				throw new Error(`tripwire ${name} did not write its marker`);
			rmSync(marker);
		}

		// What the project would declare if anything read it: both files are ones the loader itself accepts.
		const projectConfig: GeistConfig = {
			harness: {
				default: "draht",
				agents: { draht: { cmd: tripwires.project.path }, pwned: { cmd: tripwires.project.path } },
			},
			projects: { px: { root: pxRoot } },
			approvedRoots: [base],
		};
		for (const file of [join(pxRoot, "geist.yaml"), join(pxRoot, ".geist", "config.yaml")]) {
			writeRegistry(file, projectConfig);
			if (loadGeistConfigFile(file).harness.agents.pwned === undefined)
				throw new Error(`${file} does not declare pwned`);
		}

		pidsFile = join(binDir, "wedge-pids.json");
		termLog = join(binDir, "wedge-term.log");
		const grandchild = jsFixture(
			join(binDir, "wedge-grandchild.js"),
			'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
		);
		wedgeScript = jsFixture(
			join(binDir, "wedge.js"),
			[
				'import { appendFileSync, renameSync, writeFileSync } from "node:fs";',
				`process.on("SIGTERM", () => appendFileSync(${JSON.stringify(termLog)}, Date.now() + "\\n"));`,
				`const grandchild = Bun.spawn([process.execPath, ${JSON.stringify(grandchild)}, ${JSON.stringify(WEDGE_MARKER)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
				`writeFileSync(${JSON.stringify(`${pidsFile}.tmp`)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
				`renameSync(${JSON.stringify(`${pidsFile}.tmp`)}, ${JSON.stringify(pidsFile)});`,
				'console.error("wedged: ignoring SIGTERM, never binding a socket");',
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);

		installRegistry();
		daemonEnv = {
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
		};
		daemon = await startEmittedDaemon({ registry: regFile, cwd: pxRoot, env: daemonEnv });
		daemons.push(daemon);
	} finally {
		process.umask(umask);
	}
}, 120_000);

beforeEach(() => {
	if (tripwires !== undefined) disarm();
});

afterAll(async () => {
	reapPgids(pgids);
	for (const client of clients) client.close();
	for (const running of daemons) {
		try {
			await running.dispose();
		} catch {
			try {
				process.kill(running.pid, "SIGKILL");
			} catch {}
		}
	}
	// Sessions are detached and outlive their daemon; whatever carries this run's marker is ours to remove.
	for (const row of psRows()) {
		if (row.pid === process.pid || !row.command.includes(RUN)) continue;
		try {
			process.kill(row.pid, "SIGKILL");
		} catch {}
	}
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	rmSync(join(realpathSync("/tmp"), `${RUN}.yaml`), { force: true });
});

describe("a refused registry, a hostile harness path and a smuggled command, through session_spawn (R36-SPAWN.1-3, R36-SPAWN.8)", () => {
	test(
		"01 control: a valid registry runs its harness, so the tripwire oracle is shown to see a launch",
		async () => {
			await expectControlRuns();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"02 a 0644 registry file is refused on its mode, naming the file, and nothing runs",
		async () => {
			installRegistry(tripwires.control.path, 0o644);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`Refused geist registry (mode on file ${regFile}): mode 0644 is accessible to group or other`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"03 a registry file replaced by a symlink to a valid 0600 file is refused as a symlink on the file",
		async () => {
			installRegistry();
			const real = join(regDir, "real.yaml");
			writeRegistry(real, registryFor(tripwires.control.path));
			unlinkSync(regFile);
			symlinkSync(real, regFile);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`Refused geist registry (symlink on file ${regFile}): symbolic links are refused, never resolved`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"04 the registry's directory renamed away and replaced by a symlink to it is refused as a symlink on the parent",
		async () => {
			installRegistry();
			renameSync(regDir, `${regDir}-moved`);
			symlinkSync(`${regDir}-moved`, regDir);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`Refused geist registry (symlink on parent ${regDir}): symbolic links are refused, never resolved`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	foreignCase(
		"05 a registry file owned by another uid is refused as a foreign owner on the file",
		async () => {
			installRegistry();
			const made = foreignOwnedFileIn(regDir);
			if ("unavailable" in made) throw new Error(`no foreign-owned file could be made: ${made.unavailable}`);
			expect(lstatSync(made.path).uid).not.toBe(OUR_UID);
			renameSync(made.path, regFile);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`Refused geist registry (foreign-owner on file ${regFile}): owned by uid ${lstatSync(regFile).uid}, not by this user (uid ${OUR_UID})`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"06 a bare command name in the registry is refused as not absolute, with a draht on PATH and one in the daemon's cwd",
		async () => {
			installRegistry("draht");

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				"cmd must be an absolute path (a bare command name would be resolved through PATH)",
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"07 a harness inside a declared project root is refused as that project's own file",
		async () => {
			installRegistry(tripwires.inProject.path);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`the "draht" harness executable is inside project "px" (${pxRoot}); a project's own files cannot be the harness`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"08 a harness reached through a symlinked directory is refused as a symlink on the path",
		async () => {
			installRegistry(linkedCmd);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(
				answer,
				"refused",
				`symlink on the path to the "draht" harness executable: ${join(base, "linkdir")}`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"09 a harness in a group-writable directory is refused as writable by others",
		async () => {
			installRegistry(tripwires.writable.path);

			const answer = await spawnFrame(spawnOf("draht", "px"));

			expectAnswer(answer, "refused", `writable by others: ${writableDir}`);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"10 a harness only the project's own config declares is unknown, absent from the registry list, and never run",
		async () => {
			installRegistry();

			const answer = await spawnFrame(spawnOf("pwned", "px"));

			expectAnswer(answer, "unknown_harness", 'no harness "pwned" is declared in the registry');
			expectNothingFired();
			const client = await connect();
			const listed = await client.ask({ type: "registry_resync" }, "registry");
			expect(listed.harnesses).toEqual([{ id: "draht", isDefault: true }]);
			expect(listed.projects).toEqual([{ id: "px", name: "px", root: pxRoot }]);
			expect(client.rawOf("registry")).not.toContain("pwned");
			expect(client.rawOf("registry")).not.toContain(tripwires.project.path);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"11 a command smuggled beside known ids is inert: the registered harness runs and the smuggled one never does",
		async () => {
			installRegistry();

			const answer = await spawnFrame(spawnOf("draht", "px", { command: ["/bin/sh", tripwires.smuggled.path] }));

			expectAnswer(answer, "spawn_failed", "the spawned session exited before publishing its socket: exit code 0");
			expect(expectOnlyControlRan()).not.toContain(tripwires.smuggled.path);
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"12 a command smuggled beside an unknown harness is answered unknown_harness and never runs",
		async () => {
			installRegistry();

			const answer = await spawnFrame(spawnOf("nope", "px", { command: ["/bin/sh", tripwires.smuggled.path] }));

			expectAnswer(answer, "unknown_harness", 'no harness "nope" is declared in the registry');
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"13 POST /sessions with a command is refused 400 by the emitted daemon, while the same route without one answers 201",
		async () => {
			installRegistry();
			const before = descendantPids(daemon.pid);
			const request = (body: unknown): Promise<Response> =>
				fetch(`${daemon.httpBase}/sessions`, {
					method: "POST",
					headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});

			const control = await request({});
			const refused = await request({ command: ["/bin/sh", tripwires.smuggled.path] });

			expect(control.status).toBe(201);
			expect(refused.status).toBe(400);
			expect(((await refused.json()) as { error?: string }).error).toContain(
				"command is not accepted: POST /sessions does not spawn caller-supplied commands.",
			);
			await Bun.sleep(QUIET_MS);
			expectNothingFired();
			expect(descendantPids(daemon.pid)).toEqual(before);
			await healthy();
		},
		CASE_TIMEOUT_MS,
	);

	test("14 a child that ignores SIGTERM is timed out after 30000 ms and killed with its grandchild about 2 s after the TERM, while the daemon keeps answering", async () => {
		installRegistry(wedgeScript);
		const first = await connect();
		const before = descendantPids(daemon.pid);
		const sentAt = Date.now();
		const pending = first.ask(spawnOf("draht", "px"), "session_spawned", 90_000);
		pending.catch(() => {});

		const pids = await until(readPids, "the wedge child to publish its pids", 20_000);
		pgids.add(pids.child);
		const rows = psRows();
		expect(isProcessAlive(pids.child, rows)).toBe(true);
		expect(isProcessAlive(pids.grandchild, rows)).toBe(true);
		expect(rowFor(pids.child, rows)?.pgid).toBe(pids.child);
		expect(rowFor(pids.grandchild, rows)?.pgid).toBe(pids.child);
		expect(rowFor(pids.child, rows)?.ppid).toBe(daemon.pid);
		expect(rows.filter((row) => row.command.includes(WEDGE_MARKER)).map((row) => row.pid)).toEqual([pids.grandchild]);
		expect(descendantPids(daemon.pid)).toEqual([...before, pids.child, pids.grandchild].sort((a, b) => a - b));
		const watch = watchGroupDeath(pids.child);
		watch.catch(() => {});

		await healthy();
		const other = await connect();
		const fleet = await other.ask({ type: "fleet_resync" }, "fleet", 10_000);
		expect(fleet.sessions).toBeArray();
		const doubled = await other.ask(spawnOf("draht", "px"), "session_spawned", 10_000);
		expectAnswer(
			doubled,
			"refused",
			"a spawn for this project and harness is already in flight; wait for it to finish before asking again",
		);

		const answer = await pending;
		const elapsed = Date.now() - sentAt;
		expectAnswer(answer, "timeout", "the spawned session did not publish its socket within 30000 ms");
		expect(elapsed).toBeGreaterThanOrEqual(29_000);
		expect(elapsed).toBeLessThanOrEqual(45_000);
		const { termAt, deathAt } = await watch;
		expect(deathAt - termAt).toBeGreaterThanOrEqual(1800);
		expect(deathAt - termAt).toBeLessThanOrEqual(2900);
		expect(readFileSync(termLog, "utf8").trimEnd().split("\n")).toHaveLength(1);
		expect(liveGroupMembers(pids.child)).toEqual([]);
		expect(psRows().filter((row) => row.command.includes(RUN))).toEqual([]);
		await Bun.sleep(QUIET_MS);
		expect(descendantPids(daemon.pid)).toEqual(before);
		await healthy();
		expectNothingFired();
	}, 180_000);

	test(
		"15 restoring the control registry runs the harness again: every load re-reads, nothing was kept from a refused state",
		async () => {
			installRegistry();

			await expectControlRuns();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"16 a registry file directly under the root-owned /tmp is refused as a foreign owner on the parent, by a second daemon",
		async () => {
			const tmp = realpathSync("/tmp");
			const registry = join(tmp, `${RUN}.yaml`);
			writeRegistry(registry, registryFor(tripwires.control.path));
			expect(statSync(registry).mode & 0o777).toBe(0o600);
			expect(statSync(registry).uid).toBe(OUR_UID);
			const agentDir = join(base, "agent-b");
			mkdirSync(agentDir, { recursive: true });
			const second = await startEmittedDaemon({
				registry,
				cwd: pxRoot,
				env: { ...daemonEnv, DRAHT_CODING_AGENT_DIR: agentDir },
			});
			daemons.push(second);

			const answer = await spawnFrame(spawnOf("draht", "px"), second);

			expectAnswer(
				answer,
				"refused",
				`Refused geist registry (foreign-owner on parent ${tmp}): owned by uid ${statSync(tmp).uid}, not by this user (uid ${OUR_UID})`,
			);
			expectNothingFired();
		},
		CASE_TIMEOUT_MS,
	);

	test(
		"17 a daemon started with a relative --registry exits non-zero and names the flag",
		async () => {
			const failure = await startEmittedDaemon({ registry: "rel/x.yaml", cwd: pxRoot, env: daemonEnv }).then(
				(started) => {
					daemons.push(started);
					return undefined;
				},
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(DaemonStartError);
			const refused = failure as DaemonStartError;
			expect(refused.exitCode).not.toBeNull();
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain("--registry must be an absolute path, got: rel/x.yaml");
		},
		CASE_TIMEOUT_MS,
	);
});
