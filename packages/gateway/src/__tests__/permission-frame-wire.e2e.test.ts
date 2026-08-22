/**
 * R34-PERM.1 — the permission frame train, proved end to end over the real wire.
 *
 * Two real processes, neither of them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) run with
 *     `--attachable` against the keyless stub provider, so it publishes a real
 *     `<id>.sock` + `.lock` and answers a real socket-wire `attach`;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`) on an
 *     ephemeral loopback port.
 *
 * Everything asserted below crossed a real `WebSocket`. Nothing here constructs
 * an `AttachBridge`, a `net.Socket` or a `createServer()` — a package-level test
 * that did could pass while the shipped daemon spoke none of this.
 *
 * What this file is really about is SKEW, in both directions:
 *
 *   • forward — the socket wire gained frames, so geist-protocol must declare
 *     them in the same change, or `#onSessionData` drops every attached renderer
 *     with `protocol_error unknown_type` and close 1008;
 *   • backward — a client frame this draht does not know used to vanish with no
 *     reply at all, so a phone could not tell "answered" from "this draht is too
 *     old to have asked". It is answered now, and the answer is asserted here.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
/** The corpus for the member the wire currently IS, so this file follows a 0.x bump. */
const CORPUS = join(REPO_ROOT, "packages", "geist-protocol", "conformance", `geist-${GEIST_PROTOCOL_VERSION}`);
const TOKEN = "permission-frame-wire-e2e-token";

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. The
 * agent directory therefore lives directly under /tmp with a short name.
 */
const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
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

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	stderr: { text: string };
}

/**
 * Start the emitted draht binary as an attachable session.
 *
 * The child's environment is built from scratch rather than inherited. That is
 * not tidiness: this repo's interactive shell exports `DRAHT_PERMISSION_MODE=auto`,
 * and a permission test run under it passes while proving nothing.
 */
async function startDrahtSession(agentDir: string, home: string): Promise<DrahtSession> {
	const cwd = tempDir("pfw-c-");
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
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
			throw new Error(
				`draht exited with code ${proc.exitCode} before publishing a socket.\nstderr:\n${stderr.text}`,
			);
		}
		return sockets(socketDir).find((entry) => !before.has(entry));
	}, `draht to publish its socket (stderr: ${stderr.text})`);
	return { proc, id: id.slice(0, -".sock".length), stderr };
}

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

let agentDir: string;
let home: string;
let base: string;
let session: DrahtSession;

/**
 * One renderer, driven exactly as a phone would drive it.
 *
 * Frames are kept as decoded JSON rather than validated against
 * `ServerFrameSchema` on arrival: half of what this file asserts is what the
 * daemon says about frames, and a validating listener would throw inside an
 * event handler instead of failing an assertion.
 */
class Renderer {
	// Deliberately a loose shape rather than the GeistServerFrame union: this harness
	// asserts on RAW decoded objects so a frame the schema stopped declaring still
	// arrives here to be seen. `capabilities` joined it at geist/0.4.
	readonly frames: {
		type?: string;
		code?: string;
		version?: string;
		protocol?: string;
		capabilities?: unknown;
	}[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			this.frames.push(JSON.parse(String(event.data)));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(): Promise<Renderer> {
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

	async waitFor(predicate: (frame: { type?: string }) => boolean, what: string, timeoutMs = 20_000) {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((f) => f.type).join(", ")})`,
			timeoutMs,
		);
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

beforeAll(async () => {
	// Built unconditionally: the artifact under test is emitted, not committed,
	// so "it already exists" says nothing about whether it matches this tree.
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("pfw-a-");
	home = tempDir("pfw-h-");

	const port = freeLoopbackPort();
	const daemonStderr = { text: "" };
	// The daemon inherits the shell, minus the one variable that has already made
	// three permission probes pass while proving nothing.
	const daemonEnv: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		DRAHT_CODING_AGENT_DIR: agentDir,
	};
	delete daemonEnv.DRAHT_PERMISSION_MODE;
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: daemonEnv,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(() => daemonStderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");

	base = `ws://127.0.0.1:${port}`;
	session = await startDrahtSession(agentDir, home);
}, 240_000);

afterAll(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** Handshake at the current member and attach to the live session. */
async function attached(clientId: string): Promise<Renderer> {
	const renderer = await Renderer.open();
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-frame-e2e", version: "0.0.0" },
	});
	await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	renderer.send({ type: "attach", sessionId: session.id, clientId, mode: "read-write" });
	await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
	return renderer;
}

test("server_hello advertises geist/0.x 0.4 — the member the fleet projection landed in", async () => {
	// 0.3 was where the permission frames landed; 0.4 moved the member again for the
	// fleet projection, `fleet_delta`/`fleet_resync`, `session_resume` and the neutral
	// `answered` decision. The version this asserts is read from the constant rather
	// than typed twice, because the point of the test is that the RUNNING daemon and
	// the constant the tree compiles against are the same member — not what the
	// number happens to be this month.
	const renderer = await Renderer.open();
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-frame-e2e", version: "0.0.0" },
	});
	const hello = await renderer.waitFor((frame) => frame.type === "server_hello", "server_hello");

	expect(hello.protocol).toBe("geist/0.x");
	expect(hello.version).toBe(GEIST_PROTOCOL_VERSION);
	expect(GEIST_PROTOCOL_VERSION).toBe("0.4");
	// Since 0.4 the daemon also says what it is willing to be ASKED, so the next
	// verb does not need another hello-refusal cliff. Required, so its absence is a
	// wire break rather than an older daemon.
	expect(Array.isArray(hello.capabilities)).toBe(true);
	renderer.close();
}, 30_000);

test("a renderer that still speaks 0.2 is refused at the handshake, not at the first missing field", async () => {
	const renderer = await Renderer.open();
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: "0.2",
		client: { name: "stale-renderer", version: "0.0.0" },
	});
	const refusal = await renderer.waitFor((frame) => frame.type === "protocol_error", "the refusal");

	expect(refusal.code).toBe("version_mismatch");
	expect((await until(() => renderer.closed, "the close after the refusal")).code).toBe(1008);
}, 30_000);

test("an answer for a request nobody is holding is REFUSED, not swallowed, and the connection survives", async () => {
	// The whole client→session arm end to end: the renderer's frame is decoded by
	// geist-protocol, re-encoded by the bridge with the pinned client id, written
	// down the real Unix socket, and answered by the real socket server. Nothing
	// in this build registers a pending-ask registry yet, which is exactly the
	// condition being asserted — a refusal must never be silence.
	const renderer = await attached("answerer");
	renderer.send({
		type: "permission_response",
		clientId: "answerer",
		requestId: "no-such-request",
		optionId: "approve",
	});

	const refusal = await renderer.waitFor((frame) => frame.type === "error", "the relayed error");
	expect(refusal.code).toBe("PERMISSION_UNKNOWN_REQUEST");

	// A relayed `error` is the SESSION declining one frame, never the daemon
	// dropping the connection: a phone that answers a stale ask must not lose its
	// stream over it.
	await Bun.sleep(250);
	expect(renderer.closed).toBeNull();

	// Still live, and still answering: a second attempt gets the same refusal
	// rather than silence, which is what "the socket stayed open" has to mean.
	const before = renderer.frames.length;
	renderer.send({
		type: "permission_response",
		clientId: "answerer",
		requestId: "no-such-request-either",
		optionId: "deny",
	});
	const again = await until(
		() => renderer.frames.slice(before).find((frame) => frame.type === "error"),
		"a second relayed error",
	);
	expect(again.code).toBe("PERMISSION_UNKNOWN_REQUEST");
	expect(renderer.closed).toBeNull();
	renderer.close();
}, 60_000);

test("a genuinely undeclared frame type is still a protocol error that drops the connection", async () => {
	const renderer = await attached("intruder");
	renderer.send({ type: "permission_smuggle", clientId: "intruder", command: ["/bin/sh", "-c", "touch $CANARY"] });

	const refusal = await renderer.waitFor((frame) => frame.type === "protocol_error", "the refusal");
	expect(refusal.code).toBe("unknown_type");
	expect((await until(() => renderer.closed, "the close after the refusal")).code).toBe(1008);
}, 60_000);

test("the committed current-member corpus holds a recorded golden per new type per direction", () => {
	// Read, never regenerated here: a test that re-recorded the corpus would be
	// asserting against itself. Recording is the gate's job
	// (`bun scripts/check-geist-protocol.mjs`); this only proves the evidence was
	// committed alongside the schemas that describe it.
	const expected = [
		["server-to-client", "permission_request"],
		["server-to-client", "permission_resolved"],
		["client-to-server", "permission_response"],
		// Added by geist/0.4, and here for the same reason as the three above: the
		// evidence has to be committed next to the schemas that describe it.
		["server-to-client", "fleet_delta"],
		["server-to-client", "session_resumed"],
		["client-to-server", "fleet_resync"],
		["client-to-server", "session_resume"],
	] as const;

	for (const [direction, type] of expected) {
		const path = join(CORPUS, direction, `${type}.json`);
		expect(existsSync(path)).toBe(true);
		const golden = JSON.parse(readFileSync(path, "utf8"));
		expect(golden.version).toBe(GEIST_PROTOCOL_VERSION);
		expect(golden.direction).toBe(direction);
		expect(golden.frame.type).toBe(type);
	}

	// The older members stay committed: they are the record of what the wire
	// actually was, not scaffolding.
	expect(existsSync(join(REPO_ROOT, "packages/geist-protocol/conformance/geist-0.1"))).toBe(true);
	expect(existsSync(join(REPO_ROOT, "packages/geist-protocol/conformance/geist-0.2"))).toBe(true);
	expect(existsSync(join(REPO_ROOT, "packages/geist-protocol/conformance/geist-0.3"))).toBe(true);
});
