/**
 * R36-SPAWN.4, R36-SPAWN.5 and R36-SPAWN.6 at evidence class 3: a real `session_spawn` frame to the emitted daemon,
 * and the posture of the process it starts read back from the OS and from what the provider was sent. A real
 * `session_resume` frame is held to the same posture (decision 36.1): a phone resumes untrusted, like it spawns.
 *
 * The fixture is the hostile one: `trust.json` records the project as trusted AND `defaultProjectTrust` is `always`,
 * so only the spawn's own flags stand between the project's extension and a running session. Every negative has its
 * positive control in the same run: a hand-started draht in the same project loads the extension, the in-root
 * `CLAUDE.md` canary reaches the recorded request, the stub provider variable is in the child's environment, and the
 * planted canaries are in the DAEMON's environment.
 *
 * The tripwire is a file the extension's module body writes: with no exec oracle on this platform, a file is the one
 * negative a race cannot hide.
 *
 * Project A's `AGENTS.md` links OUT of its root and project B's links to a file INSIDE it. A's is refused by two
 * independent rules (no-follow and containment) so it cannot show either rule failing alone; B's is refused by
 * no-follow only. A hand-started session has no context root, so it shows no-follow failing for A as well.
 *
 * A resume has no context root either, and this file asserts nothing about the ancestor context files it reads: that
 * is not part of decision 36.1.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { GeistConfig, PermissionRequestFrame } from "@draht/geist-protocol";
import {
	argvOf,
	assertEnvAbsent,
	descendantsOf,
	envOf,
	isZombie,
	type ProcessRow,
	psRows,
	reapPgids,
	uniqueMarker,
} from "./helpers/process-table.js";
import {
	AttachClient,
	type EmittedDaemon,
	shortBase,
	startEmittedDaemon,
	writeRegistry,
} from "./helpers/spawn-daemon.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const BUN = realpathSync(process.execPath);
const CONSTRUCTED_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUIET_MS = 3_000;
const PROMPT = "report on your posture";

const hex = (): string => randomBytes(8).toString("hex");

/** Planted in the DAEMON's environment, none declared to any harness. Names and values are both searched for. */
const CANARIES: Record<string, string> = {
	AWS_SECRET_ACCESS_KEY: `canary-aws-${hex()}`,
	GITHUB_TOKEN: `canary-github-${hex()}`,
	SSH_AUTH_SOCK: `/tmp/canary-agent-${hex()}.sock`,
	[`GEIST_CANARY_${hex()}`]: `canary-geist-${hex()}`,
	ANTHROPIC_API_KEY: `canary-anthropic-${hex()}`,
};
const DECLARED_NAME = `GEIST_DECLARED_${hex()}`;
const DECLARED_VALUE = `declared-${hex()}`;

const USER_CANARY = `canary-user-agents-${hex()}`;
const PARENT_CANARY = `canary-parent-agents-${hex()}`;
const SECRET_CANARY = `canary-outside-secret-${hex()}`;
const IN_ROOT_A_CANARY = `canary-in-root-a-${hex()}`;
const SYSTEM_A_CANARY = `canary-system-md-a-${hex()}`;
const IN_ROOT_B_CANARY = `canary-in-root-b-${hex()}`;
const LINKED_B_CANARY = `canary-linked-in-root-b-${hex()}`;
const SYSTEM_B_CANARY = `canary-system-md-b-${hex()}`;

const marker = uniqueMarker("spp");
const pgids = new Set<number>();
const handStarted: Bun.Subprocess[] = [];

let base: string;
let agentDir: string;
let home: string;
let shimDir: string;
let rootA: string;
let rootB: string;
let tripwireA: string;
let tripwireB: string;
let trustPath: string;
let recordPath: string;
let controlRecordPath: string;
let envDumpPath: string;
let daemon: EmittedDaemon;

interface SpawnedSession {
	id: string;
	pid: number;
}
let sessionA: SpawnedSession | undefined;
let sessionB: SpawnedSession | undefined;

interface RecordedSession {
	id: string;
	path: string;
}
let recordedA: RecordedSession | undefined;
let resumedA: SpawnedSession | undefined;

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string | (() => string),
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value as T;
		if (Date.now() >= deadline)
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${typeof what === "function" ? what() : what}`);
		await Bun.sleep(50);
	}
}

function tripwireSource(tripwire: string): string {
	return [
		`import { appendFileSync } from "node:fs";`,
		`appendFileSync(${JSON.stringify(tripwire)}, "loaded\\n");`,
		"export default function (pi) {",
		`\tpi.on("session_start", () => {`,
		`\t\tappendFileSync(${JSON.stringify(tripwire)}, "session_start\\n");`,
		`\t\tpi.sendUserMessage("tripwire: an unprompted turn");`,
		"\t});",
		"}",
		"",
	].join("\n");
}

function plantProject(root: string, tripwire: string, systemCanary: string): void {
	mkdirSync(join(root, ".draht", "extensions"), { recursive: true });
	writeFileSync(join(root, ".draht", "extensions", "tripwire.ts"), tripwireSource(tripwire));
	writeFileSync(join(root, ".draht", "SYSTEM.md"), `${systemCanary}\n`);
}

function makeFifo(path: string): void {
	const made = Bun.spawnSync(["mkfifo", path]);
	if (!made.success) throw new Error(`mkfifo ${path} exited ${made.exitCode}: ${made.stderr.toString()}`);
}

function readIfPresent(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

function handStartedEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		TMPDIR: home,
		DRAHT_CODING_AGENT_DIR: agentDir,
		DRAHT_STUB_PROVIDER: "1",
	};
}

/**
 * A user starting draht by hand, with the same interpreter, agent directory and stub as the daemon's spawn, and no
 * posture flags. RPC rather than print mode: the tripwire's `sendUserMessage` on `session_start` makes a `-p` prompt fail
 * with "Agent is already processing". Resolves once the first provider request has been recorded; `prompt` sends one,
 * and without it only an extension can cause that request. `session` reopens a recorded session, as a resume does.
 */
async function runHandStarted(
	root: string,
	record: string,
	options: { prompt: boolean; session?: string },
): Promise<void> {
	rmSync(record, { force: true });
	const proc = Bun.spawn(
		[
			BUN,
			DRAHT_CLI,
			"--mode",
			"rpc",
			"--provider",
			"draht-stub",
			"--model",
			"stub-1",
			...(options.session === undefined ? ["--no-session"] : ["--session", options.session]),
		],
		{
			cwd: root,
			env: { ...handStartedEnv(), DRAHT_STUB_RECORD_CONTEXT: record },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	handStarted.push(proc);
	const stdout = { text: "" };
	const stderr = { text: "" };
	collect(proc.stdout as ReadableStream<Uint8Array>, stdout);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	const detail = () => `stdout: ${stdout.text}\nstderr: ${stderr.text}`;
	try {
		proc.stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
		await until(
			() => stdout.text.includes('"id":"ready"'),
			() => `the hand-started session to answer get_state (${detail()})`,
			60_000,
		);
		if (options.prompt) proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);
		await until(
			() => existsSync(record),
			() => `the hand-started session's first provider request (${detail()})`,
			60_000,
		);
	} finally {
		proc.kill("SIGKILL");
		await proc.exited;
	}
}

async function fleetRow(id: string): Promise<{ id: string; pid?: number; cwd: string } | undefined> {
	const response = await fetch(`${daemon.httpBase}/fleet`, { headers: { Authorization: `Bearer ${daemon.token}` } });
	if (response.status !== 200) throw new Error(`GET /fleet answered ${response.status}`);
	const body = (await response.json()) as { sessions?: { id: string; pid?: number; cwd: string }[] };
	return (body.sessions ?? []).find((row) => row.id === id);
}

async function daemonStillAnswers(): Promise<void> {
	const response = await fetch(`${daemon.httpBase}/health`);
	expect(response.status).toBe(200);
}

/** Every process this run started that `--session-id <id>` names, recorded for the teardown before anything is asserted. */
function recordSessionPgids(id: string): ProcessRow[] {
	const rows = descendantsOf(daemon.pid).filter((row) => row.command.includes(`--session-id ${id}`));
	for (const row of rows) pgids.add(row.pid);
	return rows;
}

function sessionFiles(): string[] {
	const sessions = join(agentDir, "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions, { recursive: true, encoding: "utf-8" })
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(sessions, entry));
}

/**
 * A recorded session of `root` that the daemon's history index will list: the emitted binary run once in print mode and
 * left to exit. `--no-approve` keeps the project's extension from starting a turn inside the seed run.
 */
async function seedRecordedSession(root: string): Promise<RecordedSession> {
	const before = new Set(sessionFiles());
	const stderr = { text: "" };
	const proc = Bun.spawn(
		[BUN, DRAHT_CLI, "--provider", "draht-stub", "--model", "stub-1", "--no-approve", "-p", "seed this session"],
		{ cwd: root, env: handStartedEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	handStarted.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`the seed run exited ${code}: ${stderr.text}`);

	const path = sessionFiles().find((candidate) => !before.has(candidate));
	if (path === undefined)
		throw new Error(`the seed run wrote no session file under ${agentDir} (stderr: ${stderr.text})`);
	const header = JSON.parse(readFileSync(path, "utf-8").split("\n")[0] ?? "") as { id: string; cwd: string };
	expect(header.cwd).toBe(root);
	return { id: header.id, path };
}

/** Every process this run started that `--session <path>` names, recorded for the teardown before anything is asserted. */
function recordResumedPgids(path: string): ProcessRow[] {
	const rows = descendantsOf(daemon.pid).filter((row) => row.command.includes(`--session ${path}`));
	for (const row of rows) pgids.add(row.pid);
	return rows;
}

async function spawnInto(projectId: string, root: string): Promise<SpawnedSession> {
	const phone = await AttachClient.open(daemon.wsBase, daemon.token);
	try {
		const hello = await phone.hello("spawn-posture");
		expect(hello.capabilities).toContain("session-spawn");
		const answer = await phone.ask(
			{ type: "session_spawn", harnessId: "draht", projectId },
			"session_spawned",
			45_000,
		);
		if (answer.sessionId !== undefined) recordSessionPgids(answer.sessionId);
		expect(answer, `daemon stderr: ${daemon.stderr.text}`).toMatchObject({ ok: true, code: "spawned" });
		const id = answer.sessionId ?? "";
		expect(id).toMatch(UUID);

		const row = await until(() => fleetRow(id), `${id} to reach GET /fleet`);
		const kernel = recordSessionPgids(id);
		expect(kernel).toHaveLength(1);
		const [child] = kernel;
		expect(isZombie(child)).toBe(false);
		expect(row.pid).toBe(child.pid);
		expect(row.cwd).toBe(root);
		return { id, pid: child.pid };
	} finally {
		phone.close();
	}
}

async function resumeFromPhone(recorded: RecordedSession, root: string): Promise<SpawnedSession> {
	const phone = await AttachClient.open(daemon.wsBase, daemon.token);
	try {
		const hello = await phone.hello("spawn-posture-resume");
		expect(hello.capabilities).toContain("session-resume");
		const answer = await phone.ask({ type: "session_resume", sessionId: recorded.id }, "session_resumed", 60_000);
		recordResumedPgids(recorded.path);
		expect(answer, `daemon stderr: ${daemon.stderr.text}`).toMatchObject({
			ok: true,
			code: "resumed",
			sessionId: recorded.id,
		});

		const kernel = recordResumedPgids(recorded.path);
		expect(kernel).toHaveLength(1);
		const [child] = kernel;
		expect(isZombie(child)).toBe(false);
		const row = await until(async () => {
			const found = await fleetRow(recorded.id);
			return found?.pid === undefined ? undefined : found;
		}, `${recorded.id} to reach GET /fleet as a live session`);
		expect(row.pid).toBe(child.pid);
		expect(row.cwd).toBe(root);
		return { id: recorded.id, pid: child.pid };
	} finally {
		phone.close();
	}
}

/** Attach, send the prompt, and hand back the connection with every frame the session sent since. */
async function promptSession(session: SpawnedSession): Promise<AttachClient> {
	const renderer = await AttachClient.open(daemon.wsBase, daemon.token);
	await renderer.hello("spawn-posture-renderer");
	renderer.send({ type: "attach", sessionId: session.id, clientId: "posture", mode: "read-write" });
	await renderer.waitFor(
		(frame) => frame.type === "session_metadata" && frame.sessionId === session.id,
		`session_metadata for ${session.id}`,
	);
	renderer.send({ type: "input", data: PROMPT, clientId: "posture" });
	return renderer;
}

async function awaitAsk(renderer: AttachClient): Promise<PermissionRequestFrame> {
	const frame = await renderer.waitFor(
		(candidate) => candidate.type === "permission_request",
		"the session's ask",
		90_000,
	);
	if (frame.type !== "permission_request") throw new Error(`expected permission_request, got ${frame.type}`);
	return frame;
}

function requireSession(session: SpawnedSession | undefined, earlier: string): SpawnedSession {
	if (session === undefined)
		throw new Error(`this test follows "${earlier}", which did not leave a session to examine`);
	return session;
}

beforeAll(async () => {
	if (!existsSync(DRAHT_CLI)) {
		const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
		if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
		if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);
	}

	base = shortBase("spp-");
	agentDir = join(base, "agent");
	home = join(base, "home");
	shimDir = join(base, "shim");
	const parentDir = join(base, "parent");
	const outsideDir = join(base, "outside");
	rootA = join(parentDir, `${marker}-a`);
	rootB = join(parentDir, `${marker}-b`);
	tripwireA = join(base, "tripwire-a.txt");
	tripwireB = join(base, "tripwire-b.txt");
	trustPath = join(agentDir, "trust.json");
	recordPath = join(base, "recorded-system-prompt.txt");
	controlRecordPath = join(base, "control-system-prompt.txt");
	envDumpPath = join(base, "grandchild-env.json");
	for (const dir of [agentDir, home, shimDir, parentDir, outsideDir]) mkdirSync(dir, { recursive: true });

	writeFileSync(join(agentDir, "AGENTS.md"), `${USER_CANARY}\n`);
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always" })}\n`);
	writeFileSync(join(parentDir, "AGENTS.md"), `${PARENT_CANARY}\n`);
	const secret = join(outsideDir, "secret.md");
	writeFileSync(secret, `${SECRET_CANARY}\n`);

	plantProject(rootA, tripwireA, SYSTEM_A_CANARY);
	symlinkSync(secret, join(rootA, "AGENTS.md"));
	writeFileSync(join(rootA, "CLAUDE.md"), `${IN_ROOT_A_CANARY}\n`);
	makeFifo(join(rootA, "AGENTS.override.md"));

	// B's AGENTS.md points INSIDE its own root, so only the no-follow rule refuses it: the containment rule that
	// refuses A's would still hide the symlink if no-follow were lost.
	plantProject(rootB, tripwireB, SYSTEM_B_CANARY);
	mkdirSync(join(rootB, "notes"));
	writeFileSync(join(rootB, "notes", "linked.md"), `${LINKED_B_CANARY}\n`);
	symlinkSync(join(rootB, "notes", "linked.md"), join(rootB, "AGENTS.md"));
	writeFileSync(join(rootB, "CLAUDE.md"), `${IN_ROOT_B_CANARY}\n`);

	// A is trusted; B is recorded as refused until a model-written file says otherwise.
	writeFileSync(trustPath, `${JSON.stringify({ [rootA]: true, [rootB]: false }, null, 2)}\n`);

	const registry: GeistConfig = {
		harness: { default: "draht", agents: { draht: { cmd: DRAHT_CLI, credentialEnv: [DECLARED_NAME] } } },
		projects: { pa: { root: rootA }, pb: { root: rootB } },
		approvedRoots: [REPO_ROOT, base],
	};
	const registryPath = join(base, "reg", "config.yaml");
	writeRegistry(registryPath, registry);

	// What the model's tool call does, in the one shell the bash tool has on every platform: grant both projects, then
	// become a long-lived bun that dumps its own environment. `exec` keeps the bun a direct child of the session.
	const grant = JSON.stringify({ [rootA]: true, [rootB]: true });
	const grandchild = [
		`const fs = require("node:fs");`,
		`const dump = ${JSON.stringify(envDumpPath)};`,
		`fs.writeFileSync(dump + ".tmp", JSON.stringify({ pid: process.pid, env: process.env }));`,
		`fs.renameSync(dump + ".tmp", dump);`,
		`setInterval(function () {}, 1000);`,
	].join(" ");
	const command = `printf '%s' '${grant}' > '${trustPath}'; exec '${BUN}' -e '${grandchild}' '${marker}'`;
	if ([grant, trustPath, BUN, grandchild, marker].some((piece) => piece.includes("'"))) {
		throw new Error(`the scripted command would not survive its quoting: ${command}`);
	}

	daemon = await startEmittedDaemon({
		registry: registryPath,
		cwd: base,
		env: {
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			// Deliberate: the daemon passes its mode on, and in `ask` the scripted call waits for an answer instead of running.
			DRAHT_PERMISSION_MODE: "ask",
			DRAHT_STUB_PROVIDER: "1",
			DRAHT_STUB_RECORD_CONTEXT: recordPath,
			DRAHT_STUB_TOOL_CALLS: JSON.stringify([
				{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] },
			]),
			DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER,DRAHT_STUB_TOOL_CALLS,DRAHT_STUB_RECORD_CONTEXT",
			[DECLARED_NAME]: DECLARED_VALUE,
			...CANARIES,
		},
	});
}, 120_000);

afterAll(async () => {
	reapPgids(pgids);
	try {
		Bun.spawnSync(["pkill", "-f", marker]);
	} catch {}
	for (const proc of handStarted) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	if (daemon) {
		try {
			await daemon.dispose();
		} catch {
			try {
				process.kill(daemon.pid, "SIGKILL");
			} catch {}
		}
	}
	try {
		// Spawned sessions are detached, so the daemon going away leaves them. Anything still carrying this run's marker is a leak.
		await until(
			() => psRows().every((row) => isZombie(row) || !row.command.includes(marker)),
			`no live process to carry ${marker}`,
			10_000,
		);
	} finally {
		if (base) rmSync(base, { recursive: true, force: true });
	}
}, 60_000);

describe("a session spawned through the daemon into a project that is trusted on disk", () => {
	test("positive control: a draht started by hand in that project loads its extension, SYSTEM.md and parent context", async () => {
		rmSync(tripwireA, { force: true });

		await runHandStarted(rootA, controlRecordPath, { prompt: false });

		const calls = readIfPresent(tripwireA);
		expect(calls, "the extension did not load in a hand-started session").toBeDefined();
		expect(calls).toContain("loaded");
		expect(calls).toContain("session_start");
		const recorded = readFileSync(controlRecordPath, "utf-8");
		expect(recorded.includes(SECRET_CANARY), "AGENTS.md, a symlink out of the root, was followed").toBe(false);
		expect(recorded).toContain(IN_ROOT_A_CANARY);
		expect(recorded).toContain(USER_CANARY);
		expect(recorded).toContain(SYSTEM_A_CANARY);
		expect(recorded).toContain(PARENT_CANARY);
		rmSync(tripwireA, { force: true });
	}, 120_000);

	test("a draht started by hand in B, which trust.json records as refused, does not load B's extension", async () => {
		rmSync(tripwireB, { force: true });

		await runHandStarted(rootB, controlRecordPath, { prompt: true });

		expect(existsSync(tripwireB), "B's extension loaded although trust.json refuses B").toBe(false);
		expect(readFileSync(controlRecordPath, "utf-8").includes(SYSTEM_B_CANARY), "B's SYSTEM.md was loaded").toBe(
			false,
		);
	}, 120_000);

	test("session_spawn is answered spawned with the fifo in the root, and no extension loads and no provider is called before a prompt", async () => {
		expect(lstatSync(join(rootA, "AGENTS.override.md")).isFIFO()).toBe(true);
		rmSync(recordPath, { force: true });
		rmSync(tripwireA, { force: true });

		sessionA = await spawnInto("pa", rootA);
		await Bun.sleep(QUIET_MS);

		expect(existsSync(tripwireA), "the project's extension ran in the spawned session").toBe(false);
		expect(existsSync(recordPath), "a provider request was made with no prompt sent").toBe(false);
		await daemonStillAnswers();
	}, 120_000);

	test("prompted, with the ask approved, the first provider request holds the in-root and user context and none of the rest", async () => {
		const session = requireSession(sessionA, "session_spawn is answered spawned");

		const renderer = await promptSession(session);
		try {
			const ask = await awaitAsk(renderer);
			expect(ask.toolName).toBe("bash");
			expect(ask.options.map((option) => option.id)).toContain("approve");
			renderer.send({
				type: "permission_response",
				clientId: "posture",
				requestId: ask.requestId,
				optionId: "approve",
			});
			await until(() => existsSync(envDumpPath), "the approved command to start its long-lived process", 90_000);
		} finally {
			renderer.close();
		}

		const recorded = readFileSync(recordPath, "utf-8");
		expect(recorded.includes(SECRET_CANARY), "AGENTS.md, a symlink out of the root, reached the provider").toBe(
			false,
		);
		expect(recorded.includes(PARENT_CANARY), "the parent directory's AGENTS.md reached the provider").toBe(false);
		expect(recorded.includes(SYSTEM_A_CANARY), "the project's SYSTEM.md reached the provider").toBe(false);
		expect(recorded).toContain(IN_ROOT_A_CANARY);
		expect(recorded).toContain(USER_CANARY);
		expect(existsSync(tripwireA), "the project's extension ran in the spawned session").toBe(false);
	}, 180_000);

	test("the child and the grandchild it started carry none of the daemon's canaries, by name or by value", async () => {
		const session = requireSession(sessionA, "prompted, with the ask approved");

		const daemonEnv = envOf(daemon.pid);
		if (!daemonEnv.visible) throw new Error(daemonEnv.reason);
		for (const [name, value] of Object.entries(CANARIES)) expect(daemonEnv.env.get(name)).toBe(value);
		expect(daemonEnv.env.get("PATH")).toContain(shimDir);

		const childEnv = assertEnvAbsent(session.pid, CANARIES, { name: "DRAHT_STUB_PROVIDER", value: "1" });
		expect(childEnv.get("PATH")).toBe(CONSTRUCTED_PATH);
		expect(childEnv.get("DRAHT_PERMISSION_MODE")).toBe("ask");
		expect(childEnv.get("DRAHT_CODING_AGENT_DIR")).toBe(agentDir);
		expect(childEnv.get(DECLARED_NAME)).toBe(DECLARED_VALUE);

		const grandchildren = descendantsOf(session.pid).filter((row) => row.command.includes(marker) && !isZombie(row));
		for (const row of grandchildren) pgids.add(row.pid);
		expect(grandchildren).toHaveLength(1);
		const [grandchild] = grandchildren;
		const grandchildEnv = assertEnvAbsent(grandchild.pid, CANARIES, { name: "DRAHT_STUB_PROVIDER", value: "1" });
		expect(grandchildEnv.get(DECLARED_NAME)).toBe(DECLARED_VALUE);
		expect(grandchildEnv.get("PATH")).toBe(`${join(agentDir, "bin")}:${CONSTRUCTED_PATH}`);
		expect(grandchildEnv.get("PATH")).not.toContain(shimDir);

		const dumped = JSON.parse(readFileSync(envDumpPath, "utf-8")) as { pid: number; env: Record<string, string> };
		expect(dumped.pid).toBe(grandchild.pid);
		expect(dumped.env.DRAHT_STUB_PROVIDER).toBe("1");
		for (const [name, value] of grandchildEnv) expect(dumped.env[name]).toBe(value);
		for (const name of Object.keys(CANARIES)) expect(dumped.env[name]).toBeUndefined();
		for (const value of Object.values(CANARIES)) expect(JSON.stringify(dumped.env)).not.toContain(value);
	}, 60_000);

	test("the grant a model wrote and a renderer approved is on disk, and is real for a draht started by hand in B", async () => {
		requireSession(sessionA, "prompted, with the ask approved");

		const onDisk = JSON.parse(readFileSync(trustPath, "utf-8")) as Record<string, unknown>;
		expect(onDisk).toEqual({ [rootA]: true, [rootB]: true });
		rmSync(tripwireB, { force: true });

		await runHandStarted(rootB, controlRecordPath, { prompt: false });

		const calls = readIfPresent(tripwireB);
		expect(calls, "the grant did not make a hand-started session load B's extension").toBeDefined();
		expect(calls).toContain("loaded");
		expect(readFileSync(controlRecordPath, "utf-8")).toContain(SYSTEM_B_CANARY);
		rmSync(tripwireB, { force: true });
	}, 120_000);

	test("the next phone spawn into B ignores that grant: no extension loads and no provider is called before a prompt", async () => {
		requireSession(sessionA, "prompted, with the ask approved");
		expect((JSON.parse(readFileSync(trustPath, "utf-8")) as Record<string, unknown>)[rootB]).toBe(true);
		rmSync(recordPath, { force: true });
		rmSync(tripwireB, { force: true });

		sessionB = await spawnInto("pb", rootB);
		await Bun.sleep(QUIET_MS);

		expect(existsSync(tripwireB), "the granted project's extension ran in the spawned session").toBe(false);
		expect(existsSync(recordPath), "a provider request was made with no prompt sent").toBe(false);
		await daemonStillAnswers();
	}, 120_000);

	test("prompted with its ask left unanswered, B's first provider request lacks its SYSTEM.md and its in-root symlink", async () => {
		const session = requireSession(sessionB, "the next phone spawn into B ignores that grant");

		const renderer = await promptSession(session);
		try {
			const ask = await awaitAsk(renderer);
			expect(ask.toolName).toBe("bash");
		} finally {
			renderer.close();
		}

		const recorded = readFileSync(recordPath, "utf-8");
		expect(recorded.includes(LINKED_B_CANARY), "AGENTS.md, a symlink inside the root, was followed").toBe(false);
		expect(recorded.includes(SYSTEM_B_CANARY), "the granted project's SYSTEM.md reached the provider").toBe(false);
		expect(recorded.includes(PARENT_CANARY), "the parent directory's AGENTS.md reached the provider").toBe(false);
		expect(recorded).toContain(IN_ROOT_B_CANARY);
		expect(recorded).toContain(USER_CANARY);
		expect(existsSync(tripwireB), "the granted project's extension ran in the spawned session").toBe(false);
	}, 180_000);
});

describe("a session resumed through the daemon into a project that is trusted on disk", () => {
	test("positive control: a draht reopening a recorded session of that project by hand loads its extension and SYSTEM.md", async () => {
		expect((JSON.parse(readFileSync(trustPath, "utf-8")) as Record<string, unknown>)[rootA]).toBe(true);
		recordedA = await seedRecordedSession(rootA);
		rmSync(tripwireA, { force: true });

		await runHandStarted(rootA, controlRecordPath, { prompt: false, session: recordedA.path });

		const calls = readIfPresent(tripwireA);
		expect(calls, "the extension did not load when a recorded session was reopened by hand").toBeDefined();
		expect(calls).toContain("loaded");
		expect(calls).toContain("session_start");
		expect(readFileSync(controlRecordPath, "utf-8")).toContain(SYSTEM_A_CANARY);
		rmSync(tripwireA, { force: true });
	}, 180_000);

	test("session_resume is answered resumed with --no-approve on the process's argv, and no extension loads and no provider is called before a prompt", async () => {
		if (recordedA === undefined)
			throw new Error("this test follows the positive control, which left no recorded session");
		rmSync(recordPath, { force: true });
		rmSync(tripwireA, { force: true });

		resumedA = await resumeFromPhone(recordedA, rootA);
		await Bun.sleep(QUIET_MS);

		expect(existsSync(tripwireA), "the project's extension ran in the resumed session").toBe(false);
		expect(existsSync(recordPath), "a provider request was made with no prompt sent").toBe(false);
		expect(argvOf(resumedA.pid)).toEqual([
			BUN,
			DRAHT_CLI,
			"--session",
			recordedA.path,
			"--attachable",
			"--mode",
			"rpc",
			"--no-approve",
		]);
		await daemonStillAnswers();
	}, 180_000);

	test("prompted with its ask left unanswered, the resumed session's first provider request lacks the project's SYSTEM.md", async () => {
		const session = requireSession(resumedA, "session_resume is answered resumed");

		const renderer = await promptSession(session);
		try {
			const ask = await awaitAsk(renderer);
			expect(ask.toolName).toBe("bash");
		} finally {
			renderer.close();
		}

		const recorded = readFileSync(recordPath, "utf-8");
		expect(
			recorded.includes(SYSTEM_A_CANARY),
			"the project's SYSTEM.md reached the provider of a resumed session",
		).toBe(false);
		expect(recorded.includes(SECRET_CANARY), "AGENTS.md, a symlink out of the root, reached the provider").toBe(
			false,
		);
		expect(recorded).toContain(IN_ROOT_A_CANARY);
		expect(recorded).toContain(USER_CANARY);
		expect(existsSync(tripwireA), "the project's extension ran in the resumed session").toBe(false);
	}, 180_000);
});
