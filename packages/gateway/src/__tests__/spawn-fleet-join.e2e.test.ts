/**
 * R36-SPAWN.8 — a process `SessionSpawner.launch()` starts joins the fleet as an ordinary session.
 *
 * THE ATTACH HALF IS THE REAL PUBLIC PROTOCOL against the emitted daemon. THE SPAWN HALF IS BOTH AN
 * IN-PROCESS LIBRARY CALL (the journey below) AND A REAL `session_spawn` FRAME sent to that daemon,
 * which is started with `--registry`.
 *
 * Sessions the daemon spawns are detached and outlive it, so `afterAll` reaps their groups by pid.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	FleetFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistConfig,
	type GeistServerFrame,
	ServerFrameSchema,
	type ServerHelloFrame,
	type SessionSpawnedFrame,
} from "@draht/geist-protocol";
import { resolveHarnessLaunch } from "../session/harness-resolver.js";
import { SessionSpawner } from "../session/spawn-primitive.js";
import { assertFrozenRowShape, attachJourney } from "./helpers/attach-journey.js";
import {
	isZombie,
	liveGroupMembers,
	psRows,
	reapPgids,
	rowFor,
	uniqueMarker,
	waitForGroupGone,
} from "./helpers/process-table.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "spawn-fleet-join-e2e-token";
const HARNESS_ID = "draht";
const PROJECT_ID = "fixture";
const PROMPT = "does the fleet see me";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Not `credentialEnv`, which is empty here: the stub is the OPERATOR's declaration about the daemon's own env.
const STUB_PROVIDER_ENV = { DRAHT_STUB_PROVIDER: "1", DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER" };

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];
const pgids = new Set<number>();
/** In the project path, so a launch this run leaked is identifiable and reapable by its argv alone. */
const marker = uniqueMarker("sfj");

let agentDir: string;
let socketDir: string;
let home: string;
let projectRoot: string;
let httpBase: string;
let wsBase: string;
let daemonStderr: { text: string };
let spawner: SessionSpawner;
let sessionId: string;
let launchedPid: number;
let idWasOnTheFleetBeforeLaunch: boolean;

/** A unix socket path over ~104 bytes fails to bind with EINVAL, and `<agentDir>/sockets/<uuid>.sock` spends 50 of them. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return realpathSync(dir);
}

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

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** Raw, because `assertFrozenRowShape` is the whole point and a schema parse strips the extra key it looks for. */
async function fleetRow(id: string): Promise<Record<string, unknown> | undefined> {
	const response = await fetch(`${httpBase}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	if (!response.ok) throw new Error(`GET /fleet answered ${response.status}`);
	const body = (await response.json()) as { sessions?: Record<string, unknown>[] };
	FleetFrameSchema.parse(body);
	return (body.sessions ?? []).find((row) => row.id === id);
}

async function daemonStillAnswers(): Promise<void> {
	const response = await fetch(`${httpBase}/health`);
	expect(response.status).toBe(200);
}

async function askToSpawn(): Promise<{ hello: ServerHelloFrame; answer: SessionSpawnedFrame }> {
	const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(
		`${wsBase}/attach`,
		{ headers: { Authorization: `Bearer ${TOKEN}` } },
	);
	const frames: GeistServerFrame[] = [];
	ws.addEventListener("message", (event: MessageEvent) => {
		frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
	});
	await new Promise<void>((res, rej) => {
		ws.addEventListener("open", () => res());
		ws.addEventListener("error", () => rej(new Error("the daemon refused a socket at /attach")));
	});
	try {
		ws.send(
			JSON.stringify({
				type: "hello",
				protocol: GEIST_PROTOCOL_FAMILY,
				version: GEIST_PROTOCOL_VERSION,
				client: { name: "spawn-fleet-join-e2e", version: "0.0.0" },
			}),
		);
		const hello = (await until(
			() => frames.find((frame) => frame.type === "server_hello"),
			"server_hello",
		)) as ServerHelloFrame;
		ws.send(JSON.stringify({ type: "session_spawn", harnessId: HARNESS_ID, projectId: PROJECT_ID }));
		const answer = (await until(
			() => frames.find((frame) => frame.type === "session_spawned"),
			() => `session_spawned (saw: ${frames.map((frame) => frame.type).join(", ")})`,
			// Past the spawner's 30 s handshake deadline, so a slow child is answered by its typed refusal, not by this timeout.
			45_000,
		)) as SessionSpawnedFrame;
		return { hello, answer };
	} finally {
		try {
			ws.close();
		} catch {}
	}
}

beforeAll(async () => {
	// Built ONLY if absent: a sibling task drives the same output directory, and two concurrent builds contend.
	if (!existsSync(DRAHT_CLI)) {
		const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
		if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
		if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);
	}

	agentDir = tempDir("sfjA-");
	socketDir = join(agentDir, "sockets");
	home = tempDir("sfjH-");
	projectRoot = join(tempDir("sfjP-"), marker);
	mkdirSync(projectRoot);

	const registry: GeistConfig = {
		harness: { default: HARNESS_ID, agents: { [HARNESS_ID]: { cmd: DRAHT_CLI } } },
		projects: { [PROJECT_ID]: { root: projectRoot } },
		approvedRoots: [REPO_ROOT, realpathSync("/tmp")],
	};
	// The loader refuses a registry that is not a 0600 file in a 0700 directory; mkdtemp makes the directory. JSON is valid YAML.
	const registryPath = join(tempDir("sfjR-"), "config.yaml");
	writeFileSync(registryPath, JSON.stringify(registry));
	chmodSync(registryPath, 0o600);

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN, "--registry", registryPath], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			...STUB_PROVIDER_ENV,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(
		() => daemonStderr.text.includes("draht-gateway listening"),
		() => `the daemon to report a bound port (stderr: ${daemonStderr.text})`,
	);
	httpBase = `http://127.0.0.1:${port}`;
	wsBase = `ws://127.0.0.1:${port}`;

	const resolved = resolveHarnessLaunch(HARNESS_ID, PROJECT_ID, { registry: () => registry });

	spawner = new SessionSpawner({ socketDir, agentDir, env: { HOME: home, TMPDIR: home, ...STUB_PROVIDER_ENV } });

	sessionId = randomUUID();
	idWasOnTheFleetBeforeLaunch = (await fleetRow(sessionId)) !== undefined;
	launchedPid = (await spawner.launch({ ...resolved, sessionId })).pid;
	pgids.add(launchedPid);
}, 300_000);

afterAll(() => {
	// Detached, in its own group: killing the daemon does not kill it.
	reapPgids(pgids);
	try {
		Bun.spawnSync(["pkill", "-f", marker]);
	} catch {}
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("a launched session is a fleet member like any other (R36-SPAWN.8)", () => {
	test("launch() returns the pid of a live process in its own group", () => {
		const row = rowFor(launchedPid);
		if (row === undefined) throw new Error(`pid ${launchedPid} is not in ps -A`);
		// `kill(pid, 0)` succeeds on a zombie, so the stat field is the only liveness oracle here.
		expect(isZombie(row)).toBe(false);
		expect(row.pgid).toBe(launchedPid);
		expect(liveGroupMembers(launchedPid).map((member) => member.pid)).toContain(launchedPid);
	});

	test("GET /fleet carries the minted id as a live socket row with exactly the frozen keys", async () => {
		expect(idWasOnTheFleetBeforeLaunch).toBe(false);
		const raw = await until(
			() => fleetRow(sessionId),
			() => `${sessionId} to reach GET /fleet (daemon stderr: ${daemonStderr.text})`,
			60_000,
		);
		assertFrozenRowShape(raw, { where: `GET /fleet row for ${sessionId}`, requirePid: true });
		expect(raw.origin).toBe("socket");
		expect(raw.attachable).toBe(true);
		expect(raw.pid).toBe(launchedPid);
		expect(raw.cwd).toBe(projectRoot);
	}, 90_000);

	test("the renderer journey a discovered session gets completes unchanged over the launched one", async () => {
		const journey = await attachJourney({
			wsBase,
			token: TOKEN,
			sessionId,
			prompt: PROMPT,
			expectOutput: `stub: ${PROMPT}`,
			expectCwd: projectRoot,
		});
		expect(journey.pid).toBe(launchedPid);
		expect(journey.metadata.cwd).toBe(projectRoot);
		expect(journey.closed?.code).toBe(1000);
		await daemonStillAnswers();
	}, 180_000);

	test("the daemon advertises session-spawn and a spawn frame starts a session that joins the fleet", async () => {
		const { hello, answer } = await askToSpawn();
		// The child is detached and outlives the daemon, so its group is recorded before any expect can throw.
		if (answer.sessionId !== undefined) {
			for (const row of psRows()) {
				if (row.command.includes(`--session-id ${answer.sessionId}`)) pgids.add(row.pid);
			}
		}

		expect(hello.capabilities).toContain("session-spawn");
		expect(hello.capabilities).toContain("registry");
		expect(answer.ok).toBe(true);
		expect(answer.code).toBe("spawned");
		const spawnedId = answer.sessionId ?? "";
		expect(spawnedId).toMatch(UUID);
		expect(spawnedId).not.toBe(sessionId);

		const raw = await until(
			() => fleetRow(spawnedId),
			() => `${spawnedId} to reach GET /fleet (daemon stderr: ${daemonStderr.text})`,
			60_000,
		);
		assertFrozenRowShape(raw, { where: `GET /fleet row for ${spawnedId}`, requirePid: true });
		expect(raw.origin).toBe("socket");
		expect(raw.attachable).toBe(true);
		expect(raw.cwd).toBe(projectRoot);
		expect(typeof raw.pid).toBe("number");
		const pid = raw.pid as number;
		pgids.add(pid);

		const row = rowFor(pid);
		if (row === undefined) throw new Error(`pid ${pid} is not in ps -A`);
		expect(isZombie(row)).toBe(false);
		expect(row.pgid).toBe(pid);
		// The pid on the row is the process that frame started, not a bystander that happens to be alive.
		expect(row.command).toContain(`--session-id ${spawnedId}`);
		await daemonStillAnswers();
	}, 150_000);

	test("stop() takes the whole group down and the id stops being a live fleet member", async () => {
		await spawner.stop(launchedPid);
		await waitForGroupGone(launchedPid);

		// Wrapped, never returned bare: an absent row is `undefined`, which `until` reads as "keep waiting".
		const gone = await until(
			async () => {
				const row = await fleetRow(sessionId);
				return row !== undefined && row.origin === "socket" ? false : { row };
			},
			() => `${sessionId} to stop being an attachable socket row`,
			60_000,
		);
		if (gone.row !== undefined) {
			assertFrozenRowShape(gone.row, { where: `GET /fleet row for ${sessionId} after stop`, requirePid: false });
			expect(gone.row.attachable).toBe(false);
			expect(gone.row.pid).toBeUndefined();
		}
		await daemonStillAnswers();
	}, 120_000);
});
