/**
 * R35-ALWAYS.9 — `session_resume` over the public protocol, behind ONE hardened
 * spawn primitive.
 *
 * CLASS 3. Two kinds of real process, neither of them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`), used three
 *     ways — to SEED session files that then exit, to hold one live anchor
 *     session, and, crucially, as the thing the DAEMON itself spawns when a
 *     `session_resume` frame arrives;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`).
 *
 * Everything asserted crosses the wire: `fetch` for `GET /fleet` and
 * `GET /history`, a real `WebSocket` for `/attach`. Nothing here constructs
 * `SessionResumer`, `SessionSpawner`, `AttachBridge` or `createServer` — a
 * package-level test that did could pass while the shipped daemon answered
 * `unknown_type` to the only frame this requirement is about.
 *
 * ## What the requirement said, and what is implemented instead
 *
 * R35-ALWAYS.9 says "through the existing `--resume` path". That path is
 * unimplementable as named and the plan overrides it: `--resume` takes no value
 * and opens a full-screen TUI picker, and a bare cross-project session id
 * reaches an interactive fork prompt that EOF-answers "no" and exits 0 — a
 * success code for having started nothing. The daemon uses
 * `--session <absolute .jsonl path> --attachable --mode rpc`, resolved
 * daemon-side from its own history index. This file proves the outcome the
 * requirement wanted (a history session becomes live and joins the fleet with no
 * client reconnect), not the mechanism it named.
 *
 * ## One deviation from the plan's assertion list, stated rather than hidden
 *
 * The plan asks for a `fleet_delta appeared` for the resumed id. On the shipped
 * daemon it is a `changed`, and that is correct rather than a miss: since
 * R35-ALWAYS.7 the fleet ALREADY CARRIES the session as an `origin: "history"`
 * row, so the observer's diff sees an id it knows whose body moved — which is
 * `changed` by construction (`FleetObserver.tick`). `appeared` would require the
 * row to have been absent, i.e. for history merging to have not happened. What
 * the requirement is actually about is asserted directly and is stronger than
 * the frame's kind: THE SAME ID, on THE SAME CONNECTION, WITHOUT RECONNECTING,
 * flips to `origin: "socket"`, `attachable: true`, with a live pid.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
	type AttachableSession,
	FleetFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
	type ServerHelloFrame,
} from "@draht/geist-protocol";
// The ONLY imports of the subject code in this file, and both are pure
// predicates: `assertSafeExecutablePath` is a `stat` walk over a path and
// `buildChildEnvironment` is a map from one environment to another. Neither
// constructs `SessionSpawner`, `SessionResumer`, `AttachBridge` or
// `createServer` — everything about the DAEMON is still asserted across the
// wire. They are called directly because the properties they carry (which
// directory layouts are refused; which names cross) are not reachable from a
// happy-path resume at all: a spawn that succeeds walks exactly one safe path
// and forwards exactly one declared name.
import { assertSafeExecutablePath, buildChildEnvironment, SpawnRefusedError } from "../session/spawn-primitive.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "session-resume-e2e-token";

/** The capability a renderer declares in `attach` to be sent `fleet_delta`. */
const FLEET_DELTA = "fleet-delta";
/** The capability a DAEMON declares in `server_hello` when it can resume. */
const SESSION_RESUME = "session-resume";

/**
 * The `PATH` the spawn primitive gives a resumed session when no operator
 * declared one. Written out rather than imported: this file asserts what the
 * SHIPPED daemon does, and importing the constant it is built from would make
 * the assertion agree with a rename that broke every real deployment.
 */
const EXPECTED_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * How long a resumed session gets to publish its socket before it is torn down.
 *
 * Written out for the same reason `EXPECTED_CHILD_PATH` is: this is the number a
 * real deployment lives with, and importing the constant would make the
 * assertion agree with any value the constant is later given — including a value
 * that means "no deadline". The test below measures the wall clock as well as
 * reading the message, so raising the constant fails on both.
 */
const EXPECTED_RESUME_DEADLINE_MS = 30_000;

/**
 * ZERO WIDTH SPACE — a code point `safeText` forbids on the wire.
 *
 * Planted in a directory NAME, because the only attacker-influenceable string
 * that reaches `session_resumed.message` is the cwd a refusal quotes.
 */
const ZWSP = "\u200b";

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. Every
 * directory this test makes therefore lives directly under /tmp with a short name.
 */
function shortTempDir(prefix: string): string {
	return mkdtempSync(`/tmp/${prefix}`);
}

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];
/**
 * argv markers this run planted in processes it does not own the handle for.
 *
 * A test that fails BEFORE it has learned a pid would otherwise leak the process
 * — and the next run of this file would then see a stranger's argv in `ps` and
 * fail an assertion about its own. Both halves are fixed: the marker carries this
 * run's pid so it can only ever match this run, and `afterAll` sweeps it.
 */
const markers: string[] = [];
/** Pids the DAEMON spawned. They are detached, so afterAll must reap them by hand. */
const resumedPids: number[] = [];

function tempDir(prefix: string): string {
	const dir = shortTempDir(prefix);
	cleanup.push(dir);
	return dir;
}

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string | (() => string),
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(50);
	}
	// Evaluated AT FAILURE, so a diagnostic that accumulates (a child's stderr)
	// reports what it holds when the wait gave up rather than what it held when
	// the wait started, which is nothing.
	throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
}

function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

function sockets(socketDir: string): string[] {
	try {
		return readdirSync(socketDir).filter((entry) => entry.endsWith(".sock"));
	} catch {
		return [];
	}
}

/** Claim a free loopback port: the CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** Whether a pid still names a process this uid can signal. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run `attempt` and return the {@link SpawnRefusedError} it raised.
 *
 * A plain `expect(...).toThrow()` would be satisfied by a `TypeError` from a
 * check that had been deleted badly, and would say nothing about WHICH check
 * fired — which is the whole content of the three cases below.
 */
function refusal(attempt: () => void): SpawnRefusedError {
	try {
		attempt();
	} catch (error) {
		if (error instanceof SpawnRefusedError) return error;
		throw error;
	}
	throw new Error("expected a SpawnRefusedError, and the call returned normally");
}

/** Every `*.jsonl` session file this agent directory holds, absolute. */
function sessionFiles(dir: string): string[] {
	const root = join(dir, "sessions");
	const out: string[] = [];
	// Absent until the first session is written, which is the state the first
	// seed run starts from.
	if (!existsSync(root)) return out;
	for (const slug of readdirSync(root, { withFileTypes: true })) {
		if (!slug.isDirectory()) continue;
		for (const name of readdirSync(join(root, slug.name))) {
			if (name.endsWith(".jsonl")) out.push(join(root, slug.name, name));
		}
	}
	return out;
}

interface Seeded {
	id: string;
	cwd: string;
	path: string;
}

/**
 * Run the emitted binary once, non-interactively, and let it exit.
 *
 * The point is the SIDE EFFECT: a real session JSONL, written by the real binary,
 * whose header is what the daemon's history index will later resolve an id
 * against. Print mode exits on its own, which is what makes the row history
 * rather than a live socket.
 */
async function seedSession(agentDir: string, home: string, prefix: string, at?: string): Promise<Seeded> {
	// `at` exists for one case: a session whose recorded cwd must contain a
	// specific byte (see ZWSP). Everything else gets a fresh throwaway directory.
	const cwd = realpathSync(at ?? tempDir(prefix));
	const before = new Set(sessionFiles(agentDir).map((path) => path));
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--provider", "draht-stub", "--model", "stub-1", "-p", "seed this session"],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`seed run exited ${code}: ${stderr.text}`);

	const path = await until(
		() => sessionFiles(agentDir).find((candidate) => !before.has(candidate)),
		`the seed run to write a session file (stderr: ${stderr.text})`,
	);
	const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]) as { id: string; cwd: string };
	return { id: header.id, cwd: header.cwd, path };
}

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	stderr: { text: string };
}

/**
 * One live attachable session, started by this test rather than by the daemon.
 *
 * It exists for one reason: `fleet_delta` is only streamed to a connection that
 * has ATTACHED (that is where a renderer declares the capability), and the
 * connection that resumes a HISTORY session has, by definition, no live session
 * of its own to attach to. So the delta-observing renderer attaches here. That
 * is not a workaround — it is the real shape of the feature: a phone watching one
 * session resumes another from the same socket.
 */
async function startAnchorSession(agentDir: string, home: string): Promise<DrahtSession> {
	const cwd = realpathSync(tempDir("srA-"));
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);

	const socketDir = join(agentDir, "sockets");
	const before = new Set(sockets(socketDir));
	const id = await until(() => {
		if (proc.exitCode !== null) {
			throw new Error(`draht exited ${proc.exitCode} before publishing a socket.\nstderr:\n${stderr.text}`);
		}
		return sockets(socketDir).find((entry) => !before.has(entry));
	}, `the anchor session to publish its socket (stderr: ${stderr.text})`);
	return { proc, id: id.slice(0, -".sock".length), cwd, stderr };
}

/** One renderer, driven exactly as a phone would drive it. */
class Renderer {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			// Re-validated on arrival: nothing the daemon emits is trusted here any
			// more than a renderer's bytes are trusted there. A `session_resumed`
			// with a code outside the enum, or a message carrying a raw control
			// character out of an errno string, fails this parse.
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	/** `base` defaults to the shared daemon; the deadline test runs a second one. */
	static async open(base: string = wsBase): Promise<Renderer> {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${base}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		const renderer = new Renderer(ws);
		await new Promise<void>((res, rej) => {
			ws.addEventListener("open", () => res());
			ws.addEventListener("error", () => rej(new Error("websocket refused")));
		});
		return renderer;
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	async handshake(): Promise<ServerHelloFrame> {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "session-resume-e2e", version: "0.0.0" },
		});
		await this.waitFor((frame) => frame.type === "fleet", "the fleet frame");
		return this.frames.find((frame) => frame.type === "server_hello") as ServerHelloFrame;
	}

	async attach(sessionId: string, clientId: string, capabilities?: string[]): Promise<void> {
		this.send({
			type: "attach",
			sessionId,
			clientId,
			mode: "read-write",
			...(capabilities === undefined ? {} : { capabilities }),
		});
		await this.waitFor((frame) => frame.type === "session_metadata", `session_metadata for ${sessionId}`);
	}

	/**
	 * `what` accepts a thunk as well as a string so a caller can defer reading
	 * something that is still being written — the trap-child tests describe
	 * themselves with the stub's stderr, and reading that eagerly at call time
	 * captures an empty buffer, which is the opposite of useful in the failure
	 * message it exists for.
	 */
	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string | (() => string),
		timeoutMs = 30_000,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			() => `${typeof what === "function" ? what() : what} (saw: ${this.frames.map((f) => f.type).join(", ")})`,
			timeoutMs,
		);
	}

	/** Every version of `id` this connection has been told about, in order. */
	rowsFor(id: string): AttachableSession[] {
		const out: AttachableSession[] = [];
		for (const frame of this.frames) {
			if (frame.type === "fleet") {
				const row = frame.sessions.find((session) => session.id === id);
				if (row) out.push(row);
			} else if (frame.type === "fleet_delta") {
				for (const change of frame.changes) {
					if (change.kind !== "disappeared" && change.session.id === id) out.push(change.session);
				}
			}
		}
		return out;
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

let agentDir: string;
let home: string;
let shimDir: string;
/** Written by the PATH-shadowed `draht` shim. Must never exist. */
let shimMarker: string;
/** Written by the resumed session's own `env`, through an approved tool call. */
let childEnvFile: string;
let wsBase: string;
let httpBase: string;
let anchor: DrahtSession;
let seeded: Seeded;
let orphan: Seeded;
/** A session whose project the operator has explicitly marked untrusted. */
let untrusted: Seeded;
/** A session whose recorded cwd carries a code point the wire forbids. */
let unspeakable: Seeded;
let daemonStderr: { text: string };

/** Environment names planted in the DAEMON's environment that must not cross. */
const CANARIES: Record<string, string> = {
	// An arbitrary name nothing declares.
	GATEWAY_CANARY_ALPHA: "canary-alpha-must-not-cross",
	// A real-world secret an operator's shell really does carry.
	AWS_SECRET_ACCESS_KEY: "canary-aws-secret-must-not-cross",
	SSH_AUTH_SOCK: "/tmp/canary-agent-must-not-cross",
	// Both are declared in DRAHT_RESUME_ENV_ALLOW below AND blocklisted, so this
	// asserts the blocklist BEATS the declaration rather than merely that
	// undeclared names are dropped. These are the ones that would matter: they
	// change what code the child loads before its first line runs.
	//
	// `DYLD_INSERT_LIBRARIES` itself is deliberately NOT used, and the reason is
	// worth recording: setting it in the DAEMON's environment kills the daemon —
	// measured, `dyld[...]: terminating because inserted dylib ... could not be
	// loaded`. That is the hazard demonstrating itself. `DYLD_LIBRARY_PATH` and
	// `LD_PRELOAD` are the same class of variable, are matched by the same
	// `DYLD_`/`LD_` prefix rules, and are inert on this host.
	DYLD_LIBRARY_PATH: "/tmp/canary-inject-must-not-cross",
	LD_PRELOAD: "/tmp/canary-preload-must-not-cross.so",
};

async function fleetBody(): Promise<{ sessions: AttachableSession[] }> {
	const response = await fetch(`${httpBase}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	return FleetFrameSchema.parse(await response.json());
}

/**
 * The daemon is still answering.
 *
 * Asserted after EVERY refusal, and it is not padding. `spawn` reports a failure
 * it could not detect synchronously as an asynchronous `error` EVENT, and an
 * `error` event with no listener is an uncaught exception that takes the whole
 * daemon down — a resume for one moved project would have refused every request
 * from every device until somebody restarted it. That is a defect this file
 * ACTUALLY CAUGHT, during mutation testing, as `ConnectionRefused` on the next
 * request after a failed spawn. A refusal path must leave the daemon exactly as
 * it found it.
 */
async function daemonStillAnswers(): Promise<void> {
	const response = await fetch(`${httpBase}/health`);
	expect(response.status).toBe(200);
}

beforeAll(async () => {
	// Built unconditionally: the artifact under test is emitted, not committed, so
	// "it already exists" says nothing about whether it matches this source tree.
	const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("srG-");
	home = tempDir("srH-");
	shimDir = tempDir("srS-");
	shimMarker = join(shimDir, "shim-was-reached.txt");
	childEnvFile = join(shimDir, "resumed-child-env.txt");

	// THE TRAP. A `draht` on the daemon's PATH, ahead of everything else, that
	// records the fact it was run. Any bare-name spawn anywhere in the daemon —
	// the one this change deleted, or a new one — resolves to this and leaves a
	// marker. Nothing in this file ever expects that marker to exist.
	const shim = join(shimDir, "draht");
	writeFileSync(shim, `#!/bin/sh\necho reached > ${shimMarker}\nexit 0\n`, { mode: 0o755 });

	seeded = await seedSession(agentDir, home, "srP-");
	orphan = await seedSession(agentDir, home, "srO-");
	// The recorded cwd now names a directory that does not exist. Renamed rather
	// than deleted so the failure is "gone", not "gone and unlinkable".
	renameSync(orphan.cwd, `${orphan.cwd}-moved-away`);
	cleanup.push(`${orphan.cwd}-moved-away`);

	// The project the trust test marks untrusted. A session of its own, so that
	// writing one `trust.json` key cannot reach any other test's cwd.
	untrusted = await seedSession(agentDir, home, "srU-");

	// A session whose cwd NAME contains U+200B, then moved away so that resuming
	// it refuses `cwd_missing` and quotes that name back over the wire. This is
	// the only path by which a byte nobody sanitised reaches
	// `session_resumed.message`, which `safeText` would reject.
	const unspeakableParent = realpathSync(tempDir("srN-"));
	const unspeakableCwd = join(unspeakableParent, `pro${ZWSP}ject`);
	mkdirSync(unspeakableCwd);
	unspeakable = await seedSession(agentDir, home, "srN-", unspeakableCwd);
	renameSync(unspeakable.cwd, `${unspeakable.cwd}-moved-away`);

	anchor = await startAnchorSession(agentDir, home);

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	// Built from scratch rather than inherited: this repo's shell exports
	// DRAHT_PERMISSION_MODE=auto, and a permission-answering test run under it
	// passes while proving nothing.
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: {
			// The shim first, so a bare `draht` lookup CAN succeed. A test that made
			// it impossible would prove nothing about whether one was attempted.
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			HOME: home,
			TMPDIR: home,
			DRAHT_CODING_AGENT_DIR: agentDir,
			// Declared, and therefore expected to cross. The stub provider is how a
			// resumed session answers with no API key, and the scripted tool call is
			// how it is made to report its own environment.
			DRAHT_STUB_PROVIDER: "1",
			DRAHT_STUB_TOOL_CALLS: JSON.stringify([
				{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command: `env > ${childEnvFile}` } }] },
			]),
			DRAHT_RESUME_ENV_ALLOW: "DRAHT_STUB_PROVIDER,DRAHT_STUB_TOOL_CALLS,DYLD_LIBRARY_PATH,LD_PRELOAD",
			...CANARIES,
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
}, 300_000);

afterAll(() => {
	// Anything still carrying one of this run's argv markers, whatever went wrong.
	for (const marker of markers) {
		try {
			Bun.spawnSync(["pkill", "-f", marker]);
		} catch {
			// No pkill, or nothing matched.
		}
	}
	// The resumed sessions are DETACHED — their own process group, deliberately,
	// so a teardown can reach a whole tree. That also means killing the daemon
	// does not kill them, so they are reaped here by hand.
	for (const pid of resumedPids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("a recorded session, before anything resumes it", () => {
	test("is on the wire as origin:history, attachable:false, resumable:true — and GET /history knows it", async () => {
		const body = await fleetBody();
		const row = body.sessions.find((session) => session.id === seeded.id);
		expect(row).toBeDefined();
		expect(row?.origin).toBe("history");
		expect(row?.attachable).toBe(false);
		expect(row?.resumable).toBe(true);
		// A history row has no process, so it must not claim one.
		expect(row?.pid).toBeUndefined();

		const history = (await (
			await fetch(`${httpBase}/history`, { headers: { Authorization: `Bearer ${TOKEN}` } })
		).json()) as { sessions: { id: string; path: string }[] };
		const recorded = history.sessions.find((session) => session.id === seeded.id);
		expect(recorded?.path).toBe(seeded.path);
	});

	test("the daemon advertises `session-resume` in server_hello, so a renderer knows it may ask", async () => {
		const renderer = await Renderer.open();
		const hello = await renderer.handshake();
		expect(hello.capabilities).toContain(SESSION_RESUME);
		expect(hello.capabilities).toContain(FLEET_DELTA);
		renderer.close();
	});
});

describe("session_resume (R35-ALWAYS.9)", () => {
	/** The renderer every assertion below shares. Opened ONCE, on purpose. */
	let phone: Renderer;
	let resumedPid = 0;

	test("an id nobody recorded is refused not_found, and spawns NOTHING", async () => {
		phone = await Renderer.open();
		await phone.handshake();
		// Attached to the ANCHOR — a session it is watching — which is what arms
		// the `fleet_delta` stream for the resume below.
		await phone.attach(anchor.id, "phone", [FLEET_DELTA]);

		const before = sockets(join(agentDir, "sockets")).length;
		phone.send({ type: "session_resume", sessionId: "00000000-0000-4000-8000-000000000000" });
		const answer = await phone.waitFor((frame) => frame.type === "session_resumed", "the refusal");
		expect(answer).toMatchObject({
			type: "session_resumed",
			sessionId: "00000000-0000-4000-8000-000000000000",
			ok: false,
			code: "not_found",
		});
		// Nothing started, and in particular nothing resolved `draht` off PATH.
		await Bun.sleep(500);
		expect(sockets(join(agentDir, "sockets")).length).toBe(before);
		expect(existsSync(shimMarker)).toBe(false);
		expect(phone.closed).toBeNull();
		await daemonStillAnswers();
	}, 60_000);

	test("a recorded session becomes live on the SAME connection, with no reconnect", async () => {
		expect(phone.closed).toBeNull();
		const framesBefore = phone.frames.length;
		// Nothing holds this id's socket NAME yet. Recorded here so the last
		// assertion in this test is a state CHANGE rather than a fact that was
		// already true before anything was asked to resume.
		const socketPath = join(agentDir, "sockets", `${seeded.id}.sock`);
		expect(existsSync(socketPath)).toBe(false);

		phone.send({ type: "session_resume", sessionId: seeded.id });

		const answer = await phone.waitFor(
			(frame) => frame.type === "session_resumed" && frame.sessionId === seeded.id,
			`session_resumed for ${seeded.id} (daemon stderr: ${daemonStderr.text})`,
			120_000,
		);
		expect(answer).toMatchObject({ type: "session_resumed", ok: true, code: "resumed" });

		// ── THE LOAD-BEARING ONE ─────────────────────────────────────────────────
		// The same id, on the same socket, flips to a live row with a real pid —
		// carried by a fleet frame this connection received AFTER it asked, with no
		// close, no re-open, no second handshake and no second attach.
		const live = await until(
			() => phone.rowsFor(seeded.id).find((row) => row.origin === "socket"),
			`the resumed session to reach this connection's fleet stream (daemon stderr: ${daemonStderr.text})`,
			60_000,
		);
		expect(live.attachable).toBe(true);
		expect(live.cwd).toBe(seeded.cwd);
		expect(typeof live.pid).toBe("number");
		expect(live.pid).toBeGreaterThan(0);
		resumedPid = live.pid as number;
		resumedPids.push(resumedPid);

		// The connection was never re-opened: this renderer was constructed once,
		// its close listener never fired, and it kept receiving frames throughout.
		expect(phone.closed).toBeNull();
		expect(phone.frames.length).toBeGreaterThan(framesBefore);

		// And the id is genuinely the same one, not a new session that looks like
		// it: a draht process binds `<its own session id>.sock`, so this NAME
		// appearing — false one line before the resume was asked for, true now — is
		// the recorded id surviving the reopen.
		//
		// This replaces a read of the seed file's FIRST LINE. That assertion could
		// not fail: the line was written by the SEED run, before any resume
		// existed, so it was already true before the resume, true if the resume
		// never happened, and true if the resumed process had opened a different
		// file entirely.
		expect(existsSync(socketPath)).toBe(true);
	}, 180_000);

	test("the resumed process was launched from an ABSOLUTE path, never a PATH lookup", () => {
		// The trap was armed before the daemon started and is still unsprung.
		expect(existsSync(shimMarker)).toBe(false);

		// And the child's own argv names the canonical absolute CLI. `ps` is the
		// only view of another process's argv this platform offers, and it is the
		// point: what is asserted is what the kernel actually exec'd.
		const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(resumedPid)]);
		const command = ps.stdout.toString();
		expect(command).toContain(DRAHT_CLI);
		expect(command).toContain("--attachable");
		expect(command).toContain("--mode rpc");
		// Named by an absolute .jsonl path, which is what keeps it out of the fork
		// prompt a bare id would have hit.
		expect(command).toContain(seeded.path);
		// argv array, never a shell.
		expect(command).not.toContain("sh -c");
	});

	test("the resumed session answers a prompt, and its environment carries only what was declared", async () => {
		const resumedPhone = await Renderer.open();
		await resumedPhone.handshake();
		await resumedPhone.attach(seeded.id, "resumed-phone");

		resumedPhone.send({ type: "input", data: "report your environment", clientId: "resumed-phone" });

		// A REAL permission ask, raised by the resumed process, relayed over the
		// same wire — which is only possible because this is a genuine attachable
		// session and not a shell someone started.
		const askFrame = await resumedPhone.waitFor(
			(frame) => frame.type === "permission_request",
			"the resumed session's permission ask",
			120_000,
		);
		// Narrowed rather than cast: the frame was re-validated against
		// `ServerFrameSchema` on arrival, so this is the union's own discriminant.
		if (askFrame.type !== "permission_request") throw new Error(`expected permission_request, got ${askFrame.type}`);
		const ask = askFrame;
		expect(ask.toolName).toBe("bash");
		resumedPhone.send({
			type: "permission_response",
			clientId: "resumed-phone",
			requestId: ask.requestId,
			optionId: "approve",
		});

		await until(() => existsSync(childEnvFile), "the resumed session's environment dump", 120_000);
		const child = Object.fromEntries(
			readFileSync(childEnvFile, "utf8")
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		) as Record<string, string>;

		// ── NEGATIVE: nothing the daemon happened to be carrying crossed ─────────
		for (const [name, value] of Object.entries(CANARIES)) {
			expect(child[name]).toBeUndefined();
			expect(readFileSync(childEnvFile, "utf8")).not.toContain(value);
		}

		// ── POSITIVE: what was declared did cross, and PATH was CONSTRUCTED ──────
		expect(child.DRAHT_STUB_PROVIDER).toBe("1");
		expect(child.DRAHT_CODING_AGENT_DIR).toBe(agentDir);
		// The tail is the absolute trusted PATH the primitive constructs, NOT the
		// daemon's — which begins with the shim directory and does not appear here
		// at all. draht itself prepends `<agent dir>/bin`, where it keeps the
		// packages it manages, which is the session's own doing after it started
		// and is asserted rather than stripped.
		expect(child.PATH?.endsWith(EXPECTED_CHILD_PATH)).toBe(true);
		expect(child.PATH).toBe(`${join(agentDir, "bin")}:${EXPECTED_CHILD_PATH}`);
		expect(child.PATH).not.toContain(shimDir);

		resumedPhone.close();
	}, 240_000);

	test("a second resume of a now-live id is already_live, a SUCCESS, and starts no second process", async () => {
		const before = await fleetBody();
		const beforeRow = before.sessions.find((session) => session.id === seeded.id);
		expect(beforeRow?.pid).toBe(resumedPid);

		phone.send({ type: "session_resume", sessionId: seeded.id });
		const answer = await until(
			() =>
				phone.frames.find(
					(frame) =>
						frame.type === "session_resumed" && frame.sessionId === seeded.id && frame.code === "already_live",
				),
			"the already_live answer",
			60_000,
		);
		// A SUCCESS: the caller asked for this session to be reachable and it is.
		expect(answer).toMatchObject({ ok: true, code: "already_live" });

		// Nothing new started: the pid is the one that was already there, and the
		// socket count did not move.
		await Bun.sleep(1_000);
		const after = await fleetBody();
		expect(after.sessions.find((session) => session.id === seeded.id)?.pid).toBe(resumedPid);
		expect(after.sessions.filter((session) => session.origin === "socket").length).toBe(
			before.sessions.filter((session) => session.origin === "socket").length,
		);
		expect(existsSync(shimMarker)).toBe(false);
	}, 90_000);

	test("a session whose directory was renamed away is cwd_missing, and leaves no orphan behind", async () => {
		const socketDir = join(agentDir, "sockets");
		const before = sockets(socketDir).length;

		phone.send({ type: "session_resume", sessionId: orphan.id });
		const answer = await phone.waitFor(
			(frame) => frame.type === "session_resumed" && frame.sessionId === orphan.id,
			"the cwd_missing refusal",
			60_000,
		);
		expect(answer).toMatchObject({ ok: false, code: "cwd_missing" });
		// The refusal names the directory, which is the only actionable fact.
		expect(String((answer as { message: string }).message)).toContain(orphan.cwd);

		// No process was started at all — the check happens BEFORE the spawn, so
		// there is never a dead child to reason about, let alone an orphan.
		await Bun.sleep(1_000);
		expect(sockets(socketDir).length).toBe(before);
		expect(existsSync(join(socketDir, `${orphan.id}.sock`))).toBe(false);
		const ps = Bun.spawnSync(["ps", "-Ao", "command="]);
		expect(ps.stdout.toString()).not.toContain(orphan.path);
		expect(existsSync(shimMarker)).toBe(false);
		await daemonStillAnswers();
	}, 90_000);
});

describe("project trust is honoured before anything is spawned (R36-SPAWN.5)", () => {
	test("a project the operator explicitly marked untrusted is REFUSED, and no process starts", async () => {
		const trustPath = join(agentDir, "trust.json");
		const socketDir = join(agentDir, "sockets");
		const before = sockets(socketDir).length;

		// The operator's own decision file, written the way the operator's own draht
		// writes it. BOTH spellings of the key are recorded — the path as the
		// session header carries it and its `realpath` — so what this test asserts
		// is the CONTRACT ("a project marked untrusted is not re-entered") rather
		// than one particular normalisation of the lookup key.
		writeFileSync(trustPath, JSON.stringify({ [untrusted.cwd]: false, [realpathSync(untrusted.cwd)]: false }));
		const renderer = await Renderer.open();
		try {
			await renderer.handshake();
			renderer.send({ type: "session_resume", sessionId: untrusted.id });
			const answer = await renderer.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === untrusted.id,
				`the trust refusal (daemon stderr: ${daemonStderr.text})`,
				60_000,
			);
			// A REFUSAL, not a `not_found` and not a success: the id resolves, the
			// directory exists, and the daemon declines to enter it anyway.
			expect(answer).toMatchObject({ ok: false, code: "refused" });
			// It names the directory, which is the only actionable fact — the
			// operator has to know which decision is stopping this.
			expect(String((answer as { message: string }).message)).toContain(untrusted.cwd);

			// Nothing was started. Not "started and killed" — the gate is checked
			// before the spawn, so there is no socket, no new process, and the
			// PATH-shadowing shim is still unsprung.
			await Bun.sleep(1_000);
			expect(sockets(socketDir).length).toBe(before);
			expect(existsSync(join(socketDir, `${untrusted.id}.sock`))).toBe(false);
			const ps = Bun.spawnSync(["ps", "-Ao", "command="]);
			expect(ps.stdout.toString()).not.toContain(untrusted.path);
			expect(existsSync(shimMarker)).toBe(false);
			await daemonStillAnswers();
		} finally {
			// Removed whatever happened: every later test in this file resumes
			// sessions whose projects must stay undecided.
			rmSync(trustPath, { force: true });
			renderer.close();
			// And if the gate ever stops refusing, this test WILL have started a
			// real session. Reaped rather than leaked into the next run.
			try {
				const stray = (await fleetBody()).sessions.find((row) => row.id === untrusted.id && row.pid);
				if (stray?.pid !== undefined) resumedPids.push(stray.pid);
			} catch {
				// The daemon is gone; the assertion that failed says why.
			}
		}
	}, 90_000);

	test("with the decision removed, the SAME project is no longer refused", async () => {
		// The other half of the gate, and the reason the first half is not simply
		// "resume never works". ONLY AN EXPLICIT `false` REFUSES: "no decision
		// recorded" is the ordinary state of every project the operator has never
		// been asked about, and a gate that failed closed there would silently
		// disable resume for the whole machine the first time `trust.json` went
		// missing. Same id, same directory, one file deleted.
		expect(existsSync(join(agentDir, "trust.json"))).toBe(false);
		const renderer = await Renderer.open();
		try {
			await renderer.handshake();
			renderer.send({ type: "session_resume", sessionId: untrusted.id });
			const answer = await renderer.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === untrusted.id,
				`the second answer for ${untrusted.id} (daemon stderr: ${daemonStderr.text})`,
				120_000,
			);
			expect(answer).toMatchObject({ code: "resumed", ok: true });
			const live = await until(
				() => fleetBody().then((body) => body.sessions.find((row) => row.id === untrusted.id && row.pid)),
				"the un-refused session to reach the fleet",
				60_000,
			);
			resumedPids.push(live.pid as number);
		} finally {
			renderer.close();
		}
	}, 180_000);
});

describe("the deadline, the process-GROUP teardown, and one resume at a time (R36-SPAWN.7)", () => {
	test("a child that traps TERM and never binds is killed WITH ITS GRANDCHILD at the deadline, and a second resume is refused while it runs", async () => {
		const trapAgentDir = tempDir("srTa-");
		const trapHome = tempDir("srTh-");
		// Its own agent directory, so the 30 s of a child that never binds cannot
		// perturb the fleet the rest of this file is asserting against.
		const stuck = await seedSession(trapAgentDir, trapHome, "srTp-");

		const stubDir = tempDir("srTb-");
		const pidFile = join(stubDir, "pids.txt");
		const stub = join(stubDir, "draht-trap");
		// Unique to this run. The `ps` assertion below is about THIS grandchild, and
		// a name shared with a previous run's leftovers would make it a claim about
		// the machine rather than about this teardown.
		const marker = `srTrapGrandchild-${process.pid}-${Date.now()}`;
		markers.push(marker);
		// THE TRAP CHILD. It is what `DRAHT_BIN` names, so it is what the daemon
		// `exec`s, and it does three things the real binary never does: it IGNORES
		// SIGTERM, it starts a GRANDCHILD, and it never publishes `<id>.sock`.
		// A `sleep` alone would prove nothing — it dies to the TERM and the KILL is
		// never exercised.
		writeFileSync(
			stub,
			[
				"#!/bin/sh",
				"trap '' TERM",
				`sh -c 'while :; do sleep 1; done' ${marker} &`,
				`echo "$$" > ${pidFile}.tmp`,
				`echo "$!" >> ${pidFile}.tmp`,
				// Renamed into place, so a reader never sees one line of two.
				`mv ${pidFile}.tmp ${pidFile}`,
				"while :; do sleep 1; done",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);

		const port = freeLoopbackPort();
		const trapStderr = { text: "" };
		const trapDaemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
			env: {
				// The shim stays first, so this daemon could still resolve a bare
				// `draht` off PATH if anything tried to.
				PATH: `${shimDir}:${process.env.PATH ?? ""}`,
				HOME: trapHome,
				TMPDIR: trapHome,
				DRAHT_CODING_AGENT_DIR: trapAgentDir,
				// The operator declaration the primitive resolves instead of PATH.
				DRAHT_BIN: stub,
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		children.push(trapDaemon);
		collect(trapDaemon.stderr as ReadableStream<Uint8Array>, trapStderr);
		await until(
			() => trapStderr.text.includes("draht-gateway listening"),
			() => `the trap daemon to report a bound port (stderr: ${trapStderr.text})`,
		);

		const trapPhone = await Renderer.open(`ws://127.0.0.1:${port}`);
		await trapPhone.handshake();

		const bogus = "00000000-0000-4000-8000-0000000000ff";
		const started = Date.now();
		trapPhone.send({ type: "session_resume", sessionId: stuck.id });
		// SAME CONNECTION, IMMEDIATELY. The first resume owns a process for the next
		// thirty seconds; a client that could have N of these in flight could turn
		// one socket into an unbounded number of processes. `bogus` is an id that
		// would otherwise answer `not_found`, so a `refused` here can only be the
		// in-flight guard — it is decided before the id is ever looked up.
		trapPhone.send({ type: "session_resume", sessionId: bogus });

		// Learned FIRST, before any assertion: an `expect` that throws here would
		// otherwise leave two spinning shells with nobody holding their pids.
		const recorded = await until(
			() => (existsSync(pidFile) ? readFileSync(pidFile, "utf8") : undefined),
			() => `the trap child to record its pids (stderr: ${trapStderr.text})`,
			60_000,
		);
		const pids = recorded
			.split("\n")
			.map((line) => Number(line.trim()))
			.filter((value) => Number.isInteger(value) && value > 0);
		// Reaped by afterAll whatever this test concludes.
		resumedPids.push(...pids);
		expect(pids.length).toBe(2);
		const [childPid, grandchildPid] = pids as [number, number];
		// The trap is running, and so is what IT started.
		expect(alive(childPid)).toBe(true);
		expect(alive(grandchildPid)).toBe(true);

		const guard = await trapPhone.waitFor(
			(frame) => frame.type === "session_resumed" && frame.sessionId === bogus,
			`the second concurrent resume to be answered (stderr: ${trapStderr.text})`,
			30_000,
		);
		expect(guard).toMatchObject({ ok: false, code: "refused" });
		expect(String((guard as { message: string }).message)).toContain("in flight");

		// ── THE DEADLINE ─────────────────────────────────────────────────────────
		const answer = await trapPhone.waitFor(
			(frame) => frame.type === "session_resumed" && frame.sessionId === stuck.id,
			() => `the resume deadline to elapse (stderr: ${trapStderr.text})`,
			120_000,
		);
		const elapsed = Date.now() - started;
		expect(answer).toMatchObject({ ok: false, code: "timeout" });
		expect(String((answer as { message: string }).message)).toContain(`${EXPECTED_RESUME_DEADLINE_MS} ms`);
		// Measured, not read: the message is a string the daemon composes, and the
		// number in it is only a claim. A deadline raised past any human's patience
		// fails the upper bound; one lowered to nothing fails the lower.
		expect(elapsed).toBeGreaterThan(EXPECTED_RESUME_DEADLINE_MS - 5_000);
		expect(elapsed).toBeLessThan(EXPECTED_RESUME_DEADLINE_MS + 60_000);

		// ── THE TEARDOWN, AND THAT IT REACHED THE WHOLE GROUP ────────────────────
		// The grandchild is the assertion that matters. Signalling the one pid the
		// daemon holds would leave it running — and a draht session's grandchildren
		// are its tools. It is only reachable at all because the child was spawned
		// DETACHED, into its own process group.
		await until(
			() => !alive(childPid) && !alive(grandchildPid),
			() => `the trap child's whole process group to be reaped (stderr: ${trapStderr.text})`,
			30_000,
		);
		// Belt and braces against pid reuse: the grandchild carried a name nothing
		// else on this machine has.
		const ps = Bun.spawnSync(["ps", "-Ao", "command="]);
		expect(ps.stdout.toString()).not.toContain(marker);

		// Nothing joined the fleet, nothing resolved `draht` off PATH, and the
		// daemon that just killed a process group is still answering.
		expect(existsSync(join(trapAgentDir, "sockets", `${stuck.id}.sock`))).toBe(false);
		expect(existsSync(shimMarker)).toBe(false);
		expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
		expect(trapPhone.closed).toBeNull();

		trapPhone.close();
		trapDaemon.kill("SIGKILL");
	}, 300_000);
});

describe("what a refusal is allowed to put on the wire", () => {
	test("a cwd carrying a forbidden code point is neutralized instead of taking the connection down", async () => {
		// `session_resumed.message` is `safeText(512)`, and the message a
		// `cwd_missing` composes QUOTES A FILESYSTEM PATH. A path is not the
		// daemon's own prose: whoever could create the directory chose those bytes.
		// Un-neutralized, this frame fails its own schema on the way out — which is
		// a throw inside the receive path, i.e. the whole connection, over a
		// directory name.
		const renderer = await Renderer.open();
		try {
			await renderer.handshake();
			renderer.send({ type: "session_resume", sessionId: unspeakable.id });
			const answer = await renderer.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === unspeakable.id,
				`the refusal quoting an unspeakable path (daemon stderr: ${daemonStderr.text})`,
				60_000,
			);
			expect(answer).toMatchObject({ ok: false, code: "cwd_missing" });
			const message = String((answer as { message: string }).message);
			// The code point did not cross...
			expect(message).not.toContain(ZWSP);
			// ...and the path is still legible, with a space where it was — a
			// refusal that named nothing would be useless.
			expect(message).toContain(unspeakable.cwd.replace(ZWSP, " "));
			// The frame parsed against `ServerFrameSchema` on arrival (that is what
			// put it in `frames` at all) and the connection is still up.
			expect(renderer.closed).toBeNull();
			await daemonStillAnswers();
		} finally {
			renderer.close();
		}
	}, 90_000);
});

describe("the executable-path walk, called directly (R36-SPAWN.2)", () => {
	const uid = process.getuid?.() ?? 0;

	// These four cases are not reachable from a resume that succeeds: a successful
	// spawn walks exactly one path, and it is a safe one. The walk is the reason
	// "an absolute path" means anything at all — without it, an absolute path
	// through a directory a second user can rename is a PATH lookup with extra
	// steps — so it is exercised on layouts built for the purpose.

	test("a component another user can write is refused", () => {
		const root = realpathSync(tempDir("srPw-"));
		const nested = join(root, "bin");
		mkdirSync(nested);
		// `mkdir`'s mode argument is masked by the umask; this is not.
		chmodSync(nested, 0o777);
		const program = join(nested, "draht");
		writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		const error = refusal(() => assertSafeExecutablePath(program, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("writable by others");
		// The offending COMPONENT is named, not the leaf: that is what has to be
		// fixed, and it is not obvious from the path alone.
		expect(error.message).toContain(nested);
	});

	test("a directory where a program should be is refused", () => {
		const root = realpathSync(tempDir("srPd-"));
		const error = refusal(() => assertSafeExecutablePath(root, uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("not a regular file");
		expect(error.message).toContain(root);
	});

	test("a symlinked component is refused", () => {
		const root = realpathSync(tempDir("srPs-"));
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(root, "link");
		symlinkSync(real, link);
		const program = join(real, "draht");
		writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

		// The leaf is a perfectly good regular file we own. What is wrong is one
		// directory ON THE WAY to it, which is exactly the substitution the walk
		// exists to notice.
		const error = refusal(() => assertSafeExecutablePath(join(link, "draht"), uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("symlink on the path");
		expect(error.message).toContain(link);
	});

	test("a relative path is refused before anything is stat'd", () => {
		const error = refusal(() => assertSafeExecutablePath("packages/coding-agent/dist/cli.js", uid));
		expect(error.code).toBe("refused");
		expect(error.message).toContain("not an absolute path");
	});

	test("and the real emitted CLI passes, so this is a filter and not a wall", () => {
		// Without this, "refuse everything" would satisfy the four cases above and
		// break every deployment.
		expect(() => assertSafeExecutablePath(realpathSync(DRAHT_CLI), uid)).not.toThrow();
	});
});

describe("the child environment, built rather than inherited (R36-SPAWN.4)", () => {
	test("a declared credential crosses, an undeclared name does not, and a code-loading name is refused even when declared", () => {
		// The e2e assertion above proves the NEGATIVE end to end — nothing the
		// daemon carried crossed. It cannot prove the positive for the credential
		// table, because a session answering through the stub provider needs no
		// credential at all: emptying that table entirely changes nothing any
		// resumed session does. So the table is asserted where it is decided.
		const built = buildChildEnvironment({
			env: {
				// In the built-in credential table.
				ANTHROPIC_API_KEY: "declared-credential-must-cross",
				OPENAI_API_KEY: "declared-credential-must-cross-too",
				// In no table at all.
				GATEWAY_CANARY_ALPHA: "undeclared-must-not-cross",
				// Declared by the operator, and one of them changes what code the
				// child loads before its first line runs.
				DRAHT_RESUME_ENV_ALLOW: "OPERATOR_DECLARED_EXTRA,DYLD_LIBRARY_PATH",
				OPERATOR_DECLARED_EXTRA: "operator-declared-must-cross",
				DYLD_LIBRARY_PATH: "/tmp/inject-must-not-cross",
				// The daemon's own PATH, which is never copied.
				PATH: "/somewhere/an/operator/happened/to/start/this/from",
			},
			agentDir: "/tmp/some-agent-dir",
			cwd: "/tmp/some-cwd",
		});

		expect(built.ANTHROPIC_API_KEY).toBe("declared-credential-must-cross");
		expect(built.OPENAI_API_KEY).toBe("declared-credential-must-cross-too");
		expect(built.OPERATOR_DECLARED_EXTRA).toBe("operator-declared-must-cross");
		expect(built.GATEWAY_CANARY_ALPHA).toBeUndefined();
		// The blocklist BEATS the operator's declaration.
		expect(built.DYLD_LIBRARY_PATH).toBeUndefined();
		// Constructed, never copied.
		expect(built.PATH).toBe(EXPECTED_CHILD_PATH);
		expect(built.DRAHT_CODING_AGENT_DIR).toBe("/tmp/some-agent-dir");
	});
});

describe("the interactive question a daemon could never answer", () => {
	test("a bare cross-project id with no terminal EXITS 1 and says why, instead of exiting 0 having done nothing", async () => {
		// THE FAILURE MODE THIS CLOSES. `resolveSessionPath` forks on the SHAPE of
		// its argument: a bare id found in ANOTHER project reaches
		// `promptConfirm("Fork this session into current directory?")`, which built
		// a readline interface with no TTY check. With stdin at /dev/null the
		// question was printed, EOF answered it "no", and the process printed
		// "Aborted." and EXITED 0 — a success code for having started nothing, and
		// indistinguishable from success to any programmatic caller, this daemon
		// included. It is the single most likely way a naive resume implementation
		// reports success for a session that never ran.
		//
		// Run from a directory that is NOT the session's, which is what makes the
		// id "cross-project" and reaches the prompt at all.
		const proc = Bun.spawn(["node", DRAHT_CLI, "--session", seeded.id, "-p", "hi"], {
			cwd: shimDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(proc);
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr as ReadableStream).text()]);
		expect(code).toBe(1);
		expect(stderr).toContain("needs an answer and stdin is not a terminal");
		// And it names the way out, which is exactly the argv the daemon uses.
		expect(stderr).toContain("absolute .jsonl path");
	}, 120_000);
});

describe("the exec surface this change closed (R36-SPAWN.1)", () => {
	test("POST /sessions/:id/input no longer reaches a bare ['draht','start'] PATH lookup", async () => {
		const created = await fetch(`${httpBase}/sessions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string };

		const input = await fetch(`${httpBase}/sessions/${session.id}/input`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello\n" }),
		});
		// Refused, not silently satisfied: a caller that believed it had typed into
		// something is worse off than one that was told there is nothing to type into.
		expect(input.status).toBe(409);
		expect(String(((await input.json()) as { error: string }).error)).toContain("never a process");

		// THE ASSERTION THIS TEST EXISTS FOR: the shim was never reached, so no
		// bare-name spawn happened. It was reachable — it is first on the daemon's
		// PATH — and it was not reached.
		await Bun.sleep(1_000);
		expect(existsSync(shimMarker)).toBe(false);
	}, 60_000);
});

/**
 * Every live process whose argv names `sessionPath` as an attachable session.
 *
 * `ps` and not the fleet, and not a pid the daemon reported: the whole question
 * is whether the DAEMON'S BOOKKEEPING agrees with the kernel, so the kernel is
 * asked directly. `-ww` defeats the width truncation that would otherwise cut a
 * long `/private/tmp/...` session path out of the very column being matched.
 */
function drahtProcessesFor(sessionPath: string): number[] {
	const ps = Bun.spawnSync(["ps", "-Awwo", "pid=,command="]);
	const pids: number[] = [];
	for (const line of ps.stdout.toString().split("\n")) {
		if (!line.includes(sessionPath) || !line.includes("--attachable")) continue;
		const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
		if (Number.isInteger(pid) && pid > 0) pids.push(pid);
	}
	return pids;
}

describe("two connections, one id — the double-spawn race", () => {
	/**
	 * THE DEFECT THIS REPRODUCES, measured on the shipped daemon before the fix:
	 * connection A sends `session_resume` for id X, connection B sends the same
	 * 200 ms later, BOTH are answered `{ok: true, code: "resumed"}`, and `ps`
	 * shows TWO live draht processes on one session JSONL and one socket path.
	 *
	 * Both halves lived in this task's own code. `AttachBridge.#resumeInFlight` is
	 * per CONNECTION, so two connections held two independent copies of it and it
	 * bounded nothing across phones, tabs, or devices sharing a token. And the
	 * spawner treated "`<socketDir>/<id>.sock` exists" as ITS OWN success without
	 * checking whether its own child put it there, so the loser saw the winner's
	 * socket, returned the loser's pid, and reported `resumed` for a child that
	 * started nothing and then died.
	 *
	 * The `already_live` short-circuit cannot help: for the 3–6 s a resume spends
	 * reaching its bind, the id is in neither `liveIds()` nor the socket
	 * directory, so "not live" at t=0 says nothing at t=4 s.
	 *
	 * WHY IT SAMPLES rather than checking once. The overlap is bounded by how
	 * fast the loser dies, and today it dies fast — `--attachable` is passed
	 * explicitly, so its bind failure is fatal and it exits within about a
	 * second. A single `ps` a second late sees one process and proves nothing.
	 * The reviewer measured two at t+0 and one from t+1; this samples every
	 * 200 ms across the whole window and asserts on the MAXIMUM.
	 */
	test("only ONE process is ever started, and the loser is told something true", async () => {
		const race = await seedSession(agentDir, home, "srRc-");
		const phoneA = await Renderer.open();
		const phoneB = await Renderer.open();
		// Two SEPARATE connections on purpose. One connection sending twice is
		// stopped by the bridge's per-socket bound and would pass against the
		// broken daemon.
		expect(drahtProcessesFor(race.path)).toEqual([]);

		const samples: number[][] = [];
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				samples.push(drahtProcessesFor(race.path));
				await Bun.sleep(200);
			}
		})();

		try {
			await phoneA.handshake();
			await phoneB.handshake();

			phoneA.send({ type: "session_resume", sessionId: race.id });
			await Bun.sleep(200);
			phoneB.send({ type: "session_resume", sessionId: race.id });

			const answerA = await phoneA.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === race.id,
				`A's answer for ${race.id} (daemon stderr: ${daemonStderr.text})`,
				180_000,
			);
			const answerB = await phoneB.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === race.id,
				`B's answer for ${race.id} (daemon stderr: ${daemonStderr.text})`,
				180_000,
			);
			// Kept sampling past both answers: a loser released rather than torn
			// down outlives the frame that reported it.
			await Bun.sleep(3_000);
			sampling = false;
			await sampler;

			// ── THE LOAD-BEARING ASSERTION ───────────────────────────────────────
			// Two processes appending to one session JSONL, on one socket path, is
			// the hazard. It is asserted on the peak of the whole window, and on the
			// number of DISTINCT pids ever seen — which catches a second child that
			// started and died between two samples of the first.
			const peak = Math.max(0, ...samples.map((sample) => sample.length));
			const everSeen = new Set(samples.flat());
			expect({ peak, distinct: everSeen.size }).toEqual({ peak: 1, distinct: 1 });

			// Exactly one caller caused a spawn, and it is the one that was told so.
			const answers = [answerA, answerB] as { ok: boolean; code: string; message: string }[];
			expect(answers.filter((answer) => answer.code === "resumed")).toHaveLength(1);

			// ── AND THE LOSER GOT SOMETHING IT CAN ACT ON ────────────────────────
			// Not `resumed`: a client told `resumed` for a pid that was never the
			// session cannot recover. Not `already_live` either — that would send it
			// to attach to a socket that does not exist yet. `refused`, naming the
			// reason, whose recovery is to wait and ask again.
			const loser = answers.find((answer) => answer.code !== "resumed") as (typeof answers)[number];
			expect(loser.ok).toBe(false);
			expect(loser.code).toBe("refused");
			expect(loser.message).toContain("in flight");
			// And it came from the DAEMON-WIDE guard, not from the bridge's
			// per-socket one — which cannot fire here, because these are two
			// different sockets.
			expect(loser.message).not.toContain("on this connection");

			for (const pid of everSeen) resumedPids.push(pid);
			expect(existsSync(shimMarker)).toBe(false);
			await daemonStillAnswers();
		} finally {
			sampling = false;
			await sampler;
			phoneA.close();
			phoneB.close();
		}
	}, 300_000);
});

describe("a socket this daemon's own child did not bind", () => {
	/**
	 * THE SECOND HALF OF THE RACE, isolated so it can be asserted without one.
	 *
	 * `SessionSpawner.resume` used to poll `existsSync(<socketDir>/<id>.sock)` and
	 * call the first hit its own success — so ANY socket at that name, whoever
	 * put it there, made it return `{pid: <its own child>}` and the daemon answer
	 * `resumed` for a child that had bound nothing. Arranged deterministically
	 * here rather than by racing: a real Unix socket bound by THIS TEST, plus the
	 * `<id>.lock` that is the only artifact naming who a session id belongs to.
	 *
	 * The lock names PID 1. That is not decoration — it is what keeps the pair out
	 * of `listAttachableSessions`, whose `pidOwnership` classifies a pid that is
	 * alive but not ours as `foreign` and therefore neither lists it nor reaps it.
	 * A lock naming a pid of OURS would have been listed as live, the resume would
	 * have short-circuited `already_live` at the `liveIds()` gate, and this test
	 * would have passed against the broken spawner without ever reaching it.
	 */
	test("does not count as the spawn's success — the resume answers already_live, not resumed", async () => {
		const debris = await seedSession(agentDir, home, "srDb-");
		const socketDir = join(agentDir, "sockets");
		const socketPath = join(socketDir, `${debris.id}.sock`);
		const lockPath = join(socketDir, `${debris.id}.lock`);

		const server = createServer();
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(socketPath, () => done());
		});
		// The published lock shape: pid, cwd, ISO creation time, start ticks.
		writeFileSync(lockPath, `1\n${debris.cwd}\n${new Date().toISOString()}\n${Date.now()}\n`, { mode: 0o600 });

		const renderer = await Renderer.open();
		try {
			await renderer.handshake();
			// Not already live, as far as every door the resumer looks through is
			// concerned — which is what makes this reach the spawn at all.
			const fleet = await fleetBody();
			expect(fleet.sessions.find((row) => row.id === debris.id)?.origin).not.toBe("socket");

			renderer.send({ type: "session_resume", sessionId: debris.id });
			const answer = await renderer.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === debris.id,
				`the answer for ${debris.id} (daemon stderr: ${daemonStderr.text})`,
				120_000,
			);
			// `already_live`, and emphatically NOT `resumed`: the id belongs to
			// somebody else, this daemon's child bound nothing, and the caller's
			// actual want — a reachable session — is satisfied by the other one.
			expect(answer).toMatchObject({ code: "already_live" });

			// And the child it started was torn down rather than released to append
			// to the same session JSONL as whatever owns the lock.
			await Bun.sleep(3_000);
			expect(drahtProcessesFor(debris.path)).toEqual([]);
			await daemonStillAnswers();
		} finally {
			renderer.close();
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(lockPath, { force: true });
			rmSync(socketPath, { force: true });
		}
	}, 180_000);
});

describe("the trust lookup key, against the store it mirrors", () => {
	/**
	 * `ProjectTrustStore` keys `trust.json` by `canonicalizePath(resolvePath(cwd))`
	 * — and `canonicalizePath` IS `realpathSync`. The gateway's mirror of that
	 * lookup used `normalize(resolvePath(cwd))` and no `realpath`, so a recorded
	 * cwd that was not already its own realpath MISSED the operator's explicit
	 * `false` and the resume walked into a project the operator had said no to.
	 *
	 * The file's other trust test deliberately records BOTH spellings, so it
	 * asserts the contract rather than a normalisation and passes either way.
	 * This one records ONLY the canonical key — the only spelling the operator's
	 * own draht ever writes — against a session whose header names the directory
	 * through a symlink.
	 *
	 * THE HEADER IS REWRITTEN THROUGH A NEW INODE, on purpose. `seedSession`
	 * `realpath`s its cwd before it spawns and the kernel's `getcwd` would
	 * canonicalise it anyway, so a non-canonical recorded cwd cannot be produced
	 * by running the binary; and `HistoryIndex` memoises headers per file keyed on
	 * INODE and never invalidates, so an in-place edit would be invisible to a
	 * daemon that had already enumerated the file. Unlink-then-write gives a new
	 * inode and moves the directory mtime, which is exactly what both cache levels
	 * key on.
	 */
	test("an explicit `false` recorded canonically refuses a cwd recorded through a symlink", async () => {
		const real = realpathSync(tempDir("srSy-"));
		const seededThere = await seedSession(agentDir, home, "srSy2-", real);
		const link = `/tmp/srSl-${Date.now().toString(36)}`;
		symlinkSync(real, link);
		cleanup.push(link);

		const lines = readFileSync(seededThere.path, "utf8").split("\n");
		const header = JSON.parse(lines[0]) as Record<string, unknown>;
		header.cwd = link;
		lines[0] = JSON.stringify(header);
		rmSync(seededThere.path);
		writeFileSync(seededThere.path, lines.join("\n"));

		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, JSON.stringify({ [real]: false }));

		const renderer = await Renderer.open();
		try {
			await renderer.handshake();
			// The daemon really is resolving the rewritten header, not a memo of the
			// old one: the cwd it reports for this id is the symlink spelling.
			const fleet = await fleetBody();
			expect(fleet.sessions.find((row) => row.id === seededThere.id)?.cwd).toBe(link);

			renderer.send({ type: "session_resume", sessionId: seededThere.id });
			const answer = await renderer.waitFor(
				(frame) => frame.type === "session_resumed" && frame.sessionId === seededThere.id,
				`the trust refusal for ${seededThere.id} (daemon stderr: ${daemonStderr.text})`,
				120_000,
			);
			expect(answer).toMatchObject({ ok: false, code: "refused" });
			expect(String((answer as { message: string }).message)).toContain(link);

			// Refused BEFORE the spawn, so there is no process and no socket — not a
			// process that started and was killed afterwards.
			await Bun.sleep(1_000);
			expect(drahtProcessesFor(seededThere.path)).toEqual([]);
			expect(existsSync(join(agentDir, "sockets", `${seededThere.id}.sock`))).toBe(false);
			await daemonStillAnswers();
		} finally {
			rmSync(trustPath, { force: true });
			// Reaped whatever happened: a run against the unfixed lookup starts a
			// real session here, and it is detached.
			for (const pid of drahtProcessesFor(seededThere.path)) resumedPids.push(pid);
			renderer.close();
		}
	}, 240_000);
});
