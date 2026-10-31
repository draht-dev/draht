/**
 * R36-SPAWN.8, R36-SPAWN.1, R36-SPAWN.2 — one acceptance script over two origins, and the kernel's view of a spawn.
 *
 * Wholly the emitted artefacts: the daemon is `src/cli.ts` run as a process with `--registry`, the session is the built
 * `packages/coding-agent/dist/cli.js`, and every frame is a real one on `/attach`. A claim about a process is read from
 * the OS (`ps`, `/proc`), never from the daemon's own bookkeeping.
 *
 * Sessions the daemon spawns are detached and outlive it, so `afterAll` reaps their groups by pid and, as a net, by the
 * marker this run put in every project path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { FleetFrameSchema, type SessionSpawnedFrame } from "@draht/geist-protocol";
import {
	type AttachJourneyResult,
	assertFrozenRowShape,
	attachJourney,
	FROZEN_ROW_KEYS,
} from "./helpers/attach-journey.js";
import {
	argvOf,
	assertEnvAbsent,
	cwdOf,
	describeRows,
	envOf,
	exeOf,
	isZombie,
	type ProcessRow,
	psRows,
	reapPgids,
	rowFor,
	uniqueMarker,
} from "./helpers/process-table.js";
import {
	AttachClient,
	descendantPids,
	type EmittedDaemon,
	shortBase,
	shTripwire,
	startEmittedDaemon,
	writeRegistry,
} from "./helpers/spawn-daemon.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI_BUILT = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROMPT = "does the fleet see me";
const QUIET_MS = 500;
type Origin = "discovered" | "spawned";
const ORIGINS: Origin[] = ["discovered", "spawned"];

const TRIPWIRE_NAMES = ["shimDraht", "shimNode", "drahtBin", "codex"] as const;
type TripwireName = (typeof TRIPWIRE_NAMES)[number];
interface Tripwire {
	path: string;
	marker: string;
}

interface SessionRef {
	id: string;
	pid: number;
}

const runMarker = uniqueMarker("w5op");
const pgids = new Set<number>();
const clients: AttachClient[] = [];
/** Recorded the moment each is created: a start that then fails must still leave nothing behind. */
const handStarted: Bun.Subprocess[] = [];
const journeys = new Map<Origin, AttachJourneyResult>();

let base: string;
let drahtCli: string;
let shimDir: string;
let daemonCwd: string;
let spRoot: string;
let dpRoot: string;
let tripwires: Record<TripwireName, Tripwire>;
let daemon: EmittedDaemon;
let discovered: SessionRef;
let spawned: SessionRef | undefined;

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string | (() => string),
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value as T;
		if (Date.now() >= deadline) {
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${typeof what === "function" ? what() : what}`);
		}
		await Bun.sleep(50);
	}
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

/** Raw, because `assertFrozenRowShape` looks for a key a schema parse would already have stripped. */
async function fleetRows(): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${daemon.httpBase}/fleet`, { headers: { Authorization: `Bearer ${daemon.token}` } });
	if (!response.ok) throw new Error(`GET /fleet answered ${response.status}`);
	const body = (await response.json()) as { sessions?: Record<string, unknown>[] };
	FleetFrameSchema.parse(body);
	return body.sessions ?? [];
}

async function daemonStillAnswers(): Promise<void> {
	expect((await fetch(`${daemon.httpBase}/health`)).status).toBe(200);
}

async function connect(): Promise<AttachClient> {
	const client = await AttachClient.open(daemon.wsBase, daemon.token);
	clients.push(client);
	return client;
}

function askToSpawn(client: AttachClient, harnessId: string, projectId: string): Promise<SessionSpawnedFrame> {
	// Past the spawner's 30000 ms handshake deadline, so a slow child is answered by its typed refusal, not by this timeout.
	return client.ask({ type: "session_spawn", harnessId, projectId }, "session_spawned", 45_000);
}

/** The processes started with this id in their argv, from `ps -A`. A spawn is detached, so its pid is recorded the moment it exists. */
function processesOf(sessionId: string): ProcessRow[] {
	return psRows().filter((row) => row.command.includes(`--session-id ${sessionId}`));
}

function trackSession(sessionId: string): ProcessRow[] {
	const rows = processesOf(sessionId);
	for (const row of rows) pgids.add(row.pid);
	return rows;
}

function recordSession(sessionId: string): number {
	const rows = trackSession(sessionId);
	const [row] = rows;
	if (rows.length !== 1 || row === undefined) {
		throw new Error(`expected one process started with --session-id ${sessionId}, ps shows ${describeRows(rows)}`);
	}
	return row.pid;
}

function requireSpawned(): SessionRef {
	if (spawned === undefined) throw new Error("the session_spawn test produced no session; see its failure first");
	return spawned;
}

function firings(): Record<TripwireName, string[]> {
	const seen = {} as Record<TripwireName, string[]>;
	for (const name of TRIPWIRE_NAMES) {
		const { marker } = tripwires[name];
		seen[name] = existsSync(marker) ? readFileSync(marker, "utf8").trimEnd().split("\n") : [];
	}
	return seen;
}

function expectNoTripwireFired(): void {
	expect(firings()).toEqual({ shimDraht: [], shimNode: [], drahtBin: [], codex: [] });
}

/** The session a person started by hand: `node`, the runner's PATH, its own parent, and a project the registry never heard of. */
async function startDiscoveredSession(env: Record<string, string>): Promise<SessionRef> {
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", drahtCli, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd: dpRoot,
			env: { PATH: process.env.PATH ?? "", ...env, DRAHT_STUB_PROVIDER: "1" },
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	handStarted.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	const row = await until(
		async () => {
			if (proc.exitCode !== null) {
				throw new Error(`the hand-started draht exited ${proc.exitCode} before joining the fleet: ${stderr.text}`);
			}
			return (await fleetRows()).find((candidate) => candidate.cwd === dpRoot);
		},
		() => `the hand-started session in ${dpRoot} to reach GET /fleet (its stderr: ${stderr.text})`,
		60_000,
	);
	if (typeof row.id !== "string") throw new Error(`the fleet row for ${dpRoot} carries no id: ${JSON.stringify(row)}`);
	return { id: row.id, pid: proc.pid };
}

beforeAll(async () => {
	// Built only if absent: the orchestrator builds once, and a second build running beside it contends for dist/.
	if (!existsSync(DRAHT_CLI_BUILT)) {
		const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
		if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
		if (!existsSync(DRAHT_CLI_BUILT)) throw new Error(`draht build produced no ${DRAHT_CLI_BUILT}`);
	}
	drahtCli = realpathSync(DRAHT_CLI_BUILT);

	base = shortBase("w5op-");
	const home = join(base, "home");
	const agentDir = join(base, "agent");
	shimDir = join(base, "shim");
	const binDir = join(base, "bin");
	const markersDir = join(base, "markers");
	daemonCwd = join(base, "daemon-cwd");
	// The marker sits in the project path, so a leaked session is identifiable and reapable by its argv alone.
	const projectsDir = join(base, runMarker);
	spRoot = join(projectsDir, "sp");
	dpRoot = join(projectsDir, "dp");
	for (const dir of [home, agentDir, shimDir, binDir, markersDir, daemonCwd, spRoot, dpRoot]) {
		mkdirSync(dir, { recursive: true });
	}

	const tripwireAt = (name: TripwireName, path: string): Tripwire => {
		const marker = join(markersDir, name);
		shTripwire(path, marker);
		return { path, marker };
	};
	tripwires = {
		shimDraht: tripwireAt("shimDraht", join(shimDir, "draht")),
		shimNode: tripwireAt("shimNode", join(shimDir, "node")),
		drahtBin: tripwireAt("drahtBin", join(binDir, "draht-bin")),
		codex: tripwireAt("codex", join(binDir, "codex")),
	};

	// Positive control for every "marker absent" below: each tripwire is shown to write its marker under the PATH a
	// spawned child gets, and then disarmed.
	for (const name of TRIPWIRE_NAMES) {
		const { path, marker } = tripwires[name];
		const run = Bun.spawnSync([
			"/usr/bin/env",
			"-i",
			"PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			path,
			"arm",
		]);
		if (run.exitCode !== 0) throw new Error(`tripwire ${name} exited ${run.exitCode}: ${run.stderr.toString()}`);
		if (readFileSync(marker, "utf8") !== `${path} arm\n`)
			throw new Error(`tripwire ${name} did not write its marker`);
		rmSync(marker);
	}

	const registry = join(base, "reg", "config.yaml");
	writeRegistry(registry, {
		harness: { default: "draht", agents: { draht: { cmd: drahtCli }, codex: { cmd: tripwires.codex.path } } },
		projects: { sp: { root: spRoot, name: "Spawn Project" } },
		approvedRoots: [REPO_ROOT, base],
	});

	daemon = await startEmittedDaemon({
		registry,
		cwd: daemonCwd,
		env: {
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			DRAHT_BIN: tripwires.drahtBin.path,
			DRAHT_STUB_PROVIDER: "1",
			DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER",
		},
	});

	discovered = await startDiscoveredSession({ HOME: home, TMPDIR: home, DRAHT_CODING_AGENT_DIR: agentDir });
}, 300_000);

afterAll(async () => {
	// Detached, in their own groups: stopping the daemon does not stop them.
	reapPgids(pgids);
	for (const proc of handStarted) {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	try {
		Bun.spawnSync(["pkill", "-f", runMarker]);
	} catch {}
	for (const client of clients) client.close();
	try {
		await daemon?.dispose();
	} catch {
		try {
			process.kill(daemon.pid, "SIGKILL");
		} catch {}
	}
	if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

describe("the registry the daemon offers (R36-SPAWN.1, R36-SPAWN.2)", () => {
	test("session-spawn and registry are advertised, and the list holds the spawnable harness and the project, no executable path", async () => {
		const client = await connect();
		const hello = await client.hello();
		expect(hello.capabilities).toContain("session-spawn");
		expect(hello.capabilities).toContain("registry");

		const listed = await client.ask({ type: "registry_resync" }, "registry");

		expect(listed.harnesses).toEqual([{ id: "draht", isDefault: true }]);
		expect(listed.projects).toEqual([{ id: "sp", name: "Spawn Project", root: spRoot }]);
		const text = client.rawOf("registry");
		expect(text).not.toContain(drahtCli);
		expect(text).not.toContain(tripwires.codex.path);
		await daemonStillAnswers();
	}, 30_000);
});

describe("a session_spawn frame, as the kernel sees what it started (R36-SPAWN.1, R36-SPAWN.2)", () => {
	test("session_spawn {draht, sp} is answered spawned with a minted uuid, and that id is the one process, on GET /fleet", async () => {
		const client = await connect();
		await client.hello();

		const answer = await askToSpawn(client, "draht", "sp");

		expect(answer.code).toBe("spawned");
		expect(answer.ok).toBe(true);
		const id = answer.sessionId ?? "";
		expect(id).toMatch(UUID);
		const pid = recordSession(id);
		spawned = { id, pid };

		const row = await until(
			async () => (await fleetRows()).find((candidate) => candidate.id === id),
			() => `${id} to reach GET /fleet (daemon stderr: ${daemon.stderr.text})`,
			60_000,
		);
		assertFrozenRowShape(row, { where: `GET /fleet row for ${id}`, requirePid: true });
		expect(row.pid).toBe(pid);
		expect(row.cwd).toBe(spRoot);
		await daemonStillAnswers();
	}, 150_000);

	test("the kernel shows it alive, leading its own group, as a child of the daemon", async () => {
		const { pid } = requireSpawned();

		const row = rowFor(pid);
		if (row === undefined) throw new Error(`pid ${pid} is not in ps -A`);
		expect(isZombie(row)).toBe(false);
		expect(row.pgid).toBe(pid);
		expect(row.ppid).toBe(daemon.pid);

		// The control: the hand-started session has this runner for a parent, so `ppid = daemon` tells the origins apart.
		const byHand = rowFor(discovered.pid);
		if (byHand === undefined) throw new Error(`pid ${discovered.pid} is not in ps -A`);
		expect(byHand.ppid).toBe(process.pid);
		expect(byHand.ppid).not.toBe(daemon.pid);
		await daemonStillAnswers();
	});

	test("it runs the registered cli.js under the daemon's own runtime, with the argv the daemon builds, in the project root", async () => {
		const { id, pid } = requireSpawned();

		expect(exeOf(pid)).toBe(realpathSync(process.execPath));
		expect(argvOf(pid)).toEqual([
			realpathSync(process.execPath),
			drahtCli,
			"--session-id",
			id,
			"--attachable",
			"--mode",
			"rpc",
			"--no-approve",
			"--context-root",
			spRoot,
		]);
		expect(cwdOf(daemon.pid)).toBe(daemonCwd);
		expect(cwdOf(pid)).toBe(spRoot);
		await daemonStillAnswers();
	});

	test("its PATH is the constructed one, not the daemon's and not the shim's, and the resume seam did not cross", async () => {
		const { pid } = requireSpawned();

		const daemonEnv = envOf(daemon.pid);
		if (!daemonEnv.visible) throw new Error(`the daemon's environment is not visible: ${daemonEnv.reason}`);
		expect(daemonEnv.env.get("PATH")?.startsWith(`${shimDir}:`)).toBe(true);

		const env = assertEnvAbsent(
			pid,
			{ DRAHT_BIN: tripwires.drahtBin.path },
			{ name: "DRAHT_STUB_PROVIDER", value: "1" },
		);
		expect(env.get("PATH")).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
		const seen = envOf(pid);
		expect(seen.raw).not.toContain(shimDir);
		await daemonStillAnswers();
	});

	test("no tripwire fired: not the shims, not DRAHT_BIN, not the unspawnable harness", async () => {
		expectNoTripwireFired();
		await daemonStillAnswers();
	});
});

describe("the identical acceptance script over a discovered and a spawned session (R36-SPAWN.8)", () => {
	const ACCEPTANCE = (sessionId: string) =>
		attachJourney({
			wsBase: daemon.wsBase,
			token: daemon.token,
			sessionId,
			prompt: PROMPT,
			expectOutput: `stub: ${PROMPT}`,
		});

	test.each(ORIGINS)(
		"completes over the %s session",
		async (origin) => {
			const id = origin === "discovered" ? discovered.id : requireSpawned().id;

			const result = await ACCEPTANCE(id);
			journeys.set(origin, result);

			expect(id).toMatch(UUID);
			expect(Object.keys(result.rawRow).sort()).toEqual([...FROZEN_ROW_KEYS].sort());
			expect(Object.keys(result.rawSnapshotRow).sort()).toEqual([...FROZEN_ROW_KEYS].sort());
			expect(result.row).toMatchObject({ id, origin: "socket", attachable: true });
			expect(result.closed?.code).toBe(1000);
			await daemonStillAnswers();
		},
		180_000,
	);

	test("the two origins agree on row shape, row state and session_metadata shape", () => {
		const byHand = journeys.get("discovered");
		const launched = journeys.get("spawned");
		if (byHand === undefined || launched === undefined) {
			throw new Error("both journeys must have completed; see their failures first");
		}

		expect(Object.keys(launched.rawRow).sort()).toEqual(Object.keys(byHand.rawRow).sort());
		expect(Object.keys(launched.rawSnapshotRow).sort()).toEqual(Object.keys(byHand.rawSnapshotRow).sort());
		for (const field of ["origin", "attachable", "resumable"] as const) {
			expect(launched.rawRow[field], field).toEqual(byHand.rawRow[field]);
		}
		expect(Object.keys(launched.metadata).sort()).toEqual(Object.keys(byHand.metadata).sort());
		expect(byHand.metadata.cwd).toBe(dpRoot);
		expect(launched.metadata.cwd).toBe(spRoot);
	});
});

describe("what a spawn must not do (R36-SPAWN.1, R36-SPAWN.2)", () => {
	test("a declared harness that is not spawnable is unknown_harness within 5 s, and its executable never runs", async () => {
		const client = await connect();
		await client.hello();
		const before = descendantPids(daemon.pid);

		const startedAt = Date.now();
		const answer = await askToSpawn(client, "codex", "sp");
		const elapsed = Date.now() - startedAt;
		await Bun.sleep(QUIET_MS);

		expect(answer.code).toBe("unknown_harness");
		expect(answer.ok).toBe(false);
		expect(answer.message).toContain("is declared but not spawnable");
		expect(answer.sessionId).toBeUndefined();
		expect(elapsed).toBeLessThan(5_000);
		expect(firings().codex).toEqual([]);
		expect(descendantPids(daemon.pid)).toEqual(before);
		await daemonStillAnswers();
	}, 30_000);

	test("two connections asking for one pair 100 ms apart start exactly one process", async () => {
		const first = await connect();
		const second = await connect();
		await first.hello();
		await second.hello();
		const before = descendantPids(daemon.pid);

		const winner = askToSpawn(first, "draht", "sp");
		winner.catch(() => {});
		await Bun.sleep(100);
		const loser = await askToSpawn(second, "draht", "sp");
		const started = await winner;
		await Bun.sleep(QUIET_MS);
		// Before any assertion can throw: a second session this test did not expect is still a detached process to reap.
		for (const answer of [started, loser]) {
			if (answer.sessionId !== undefined) trackSession(answer.sessionId);
		}

		expect(started.code).toBe("spawned");
		expect(loser.code).toBe("refused");
		expect(loser.ok).toBe(false);
		expect(loser.message).toContain("a spawn for this project and harness is already in flight");
		expect(loser.sessionId).toBeUndefined();
		expect(started.sessionId).toMatch(UUID);
		const pid = recordSession(started.sessionId ?? "");
		const added = descendantPids(daemon.pid).filter((candidate) => !before.includes(candidate));
		expect(added).toEqual([pid]);
		await daemonStillAnswers();
	}, 150_000);

	test("nothing but the spawned sessions is a child of the daemon, and no tripwire ever fired", async () => {
		const ours = [...pgids].sort((a, b) => a - b);
		const children = psRows()
			.filter((row) => row.ppid === daemon.pid)
			.map((row) => row.pid)
			.sort((a, b) => a - b);

		expect(children).toEqual(ours);
		expectNoTripwireFired();
		await daemonStillAnswers();
	}, 30_000);
});
