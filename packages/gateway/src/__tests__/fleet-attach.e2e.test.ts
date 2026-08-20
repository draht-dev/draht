/**
 * R32-FLEET.1, .2, .3, .6, .7 — proved end to end, over HTTP and WS only.
 *
 * Two real processes, neither of them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`, the file
 *     `bin.draht` points at) run with `--attachable` against the in-repo keyless
 *     stub provider, so it publishes a real `<id>.sock` + `.lock` with a real
 *     pid and answers real prompts with real streamed assistant text;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`) on an
 *     ephemeral loopback port.
 *
 * Everything asserted below crosses the wire: `fetch` for `GET /fleet`, a real
 * `WebSocket` for `/attach`. Nothing here constructs `createServer()`, an
 * `AttachBridge`, or a `net.Socket` — a package-level test that did could pass
 * while the shipped daemon exposed none of this (the Phase 42/44 failure mode).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	FleetFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "fleet-attach-e2e-token";

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. The
 * agent directory therefore lives directly under /tmp.
 */
function shortTempDir(prefix: string): string {
	return mkdtempSync(`/tmp/${prefix}`);
}

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

function tempDir(prefix: string): string {
	const dir = shortTempDir(prefix);
	cleanup.push(dir);
	return dir;
}

/**
 * Poll until `probe` yields something truthy.
 *
 * The result is awaited, not merely tested: an async probe returns a Promise,
 * and a Promise is always truthy — a version of this helper that skipped the
 * await would "succeed" on the first tick of every polling assertion below.
 */
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

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	stderr: { text: string };
}

/**
 * Start the emitted draht binary as an attachable session.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print
 * mode and the process would answer once and exit before anything could attach.
 */
async function startDrahtSession(agentDir: string, home: string): Promise<DrahtSession> {
	const cwd = tempDir("gfc-");
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
				// Slow enough that a second prompt can land mid-stream, fast enough
				// that a whole reply still finishes inside a test.
				DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "25",
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
		// A child that already exited will never publish a socket. Reported the
		// moment it happens, with its stderr, instead of being indistinguishable
		// from a slow start for the next twenty seconds.
		if (proc.exitCode !== null) {
			throw new Error(
				`draht exited with code ${proc.exitCode} before publishing a socket.\nstderr:\n${stderr.text}`,
			);
		}
		return sockets(socketDir).find((entry) => !before.has(entry));
	}, `draht to publish its socket (stderr: ${stderr.text})`);
	return { proc, id: id.slice(0, -".sock".length), cwd, stderr };
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
	// `Bun.serve` types `port` as optional because a unix-socket listener has
	// none; a TCP probe always has one, and a missing one is a broken fixture.
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** One renderer, driven exactly as a phone would drive it. */
class Renderer {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			// Re-validated on arrival: nothing the daemon emits is trusted here
			// any more than a renderer's bytes are trusted there.
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(base: string): Promise<Renderer> {
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

	async handshake(): Promise<void> {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "e2e-renderer", version: "0.0.0" },
		});
		await this.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	}

	async attach(sessionId: string, clientId: string, mode = "read-write"): Promise<void> {
		this.send({ type: "attach", sessionId, clientId, mode });
		await this.waitFor((frame) => frame.type === "session_metadata", `session_metadata for ${sessionId}`);
	}

	async waitFor(
		predicate: (frame: GeistServerFrame) => boolean,
		what: string,
		timeoutMs = 20_000,
	): Promise<GeistServerFrame> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((f) => f.type).join(", ")})`,
			timeoutMs,
		);
	}

	/** Everything the session has printed, in order. */
	output(): string {
		return this.frames
			.filter((frame): frame is Extract<GeistServerFrame, { type: "output" }> => frame.type === "output")
			.map((frame) => frame.data)
			.join("");
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
let base: string;
let httpBase: string;
let session: DrahtSession;
let daemonStderr: { text: string };

async function fleet(headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }): Promise<Response> {
	return fetch(`${httpBase}/fleet`, { headers });
}

beforeAll(async () => {
	// Built unconditionally. The artifact under test is emitted, not committed,
	// so "it already exists" says nothing about whether it matches this source
	// tree — a stale dist/cli.js from an older checkout starts, fails to register
	// the stub provider, and the whole suite fails on socket timeouts instead of
	// on the thing it means to prove. The acceptance has to be reproducible from
	// the repo, not from whichever build happened to run last.
	const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("gfa-");
	home = tempDir("gfh-");

	const port = freeLoopbackPort();
	daemonStderr = { text: "" };
	const daemon = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(daemon);
	collect(daemon.stderr as ReadableStream<Uint8Array>, daemonStderr);
	await until(() => daemonStderr.text.includes("draht-gateway listening"), "the daemon to report a bound port");

	httpBase = `http://127.0.0.1:${port}`;
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

describe("GET /fleet (R32-FLEET.2)", () => {
	test("is behind the bearer auth the daemon already enforces", async () => {
		expect((await fleet({})).status).toBe(401);
		expect((await fleet({ Authorization: "Bearer wrong" })).status).toBe(401);
	});

	test("lists exactly the spawned session, with its real id, cwd and pid", async () => {
		const body = FleetFrameSchema.parse(await (await fleet()).json());

		expect(body.sessions).toHaveLength(1);
		const [only] = body.sessions;
		expect(only.id).toBe(session.id);
		expect(only.pid).toBe(session.proc.pid);
		expect(only.cwd).toBe(realpathSync(session.cwd));
		expect(Number.isFinite(Date.parse(only.startedAt))).toBe(true);
	});

	test("carries no socket path — a renderer never needs one and this body reaches a phone", async () => {
		expect(JSON.stringify(await (await fleet()).json())).not.toContain(".sock");
	});

	test("a session whose process is killed is gone within one poll, and its files are reaped", async () => {
		const second = await startDrahtSession(agentDir, home);
		const listed = FleetFrameSchema.parse(await (await fleet()).json());
		expect(listed.sessions.map((s) => s.id).sort()).toEqual([session.id, second.id].sort());

		second.proc.kill("SIGKILL");
		await second.proc.exited;

		const after = await until(async () => {
			const body = FleetFrameSchema.parse(await (await fleet()).json());
			return body.sessions.every((s) => s.id !== second.id) ? body : undefined;
		}, "the killed session to leave the fleet");
		expect(after.sessions.map((s) => s.id)).toEqual([session.id]);
		expect(existsSync(join(agentDir, "sockets", `${second.id}.sock`))).toBe(false);
		expect(existsSync(join(agentDir, "sockets", `${second.id}.lock`))).toBe(false);
	}, 60_000);
});

describe("the attach bridge (R32-FLEET.3)", () => {
	test("handshake, attach, prompt — the assistant's text arrives streamed", async () => {
		const renderer = await Renderer.open(base);
		await renderer.handshake();

		const [serverHello, fleetFrame] = renderer.frames;
		expect(serverHello).toMatchObject({
			type: "server_hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
		});
		expect(fleetFrame).toMatchObject({ type: "fleet" });

		await renderer.attach(session.id, "client-a");
		expect(renderer.frames.at(-1)).toMatchObject({ type: "session_metadata", sessionId: session.id });

		renderer.send({ type: "input", data: "hello from the wire", clientId: "client-a" });
		await renderer.waitFor(
			(frame) => frame.type === "output" && renderer.output().includes("stub: hello from the wire"),
			"the streamed reply",
		);

		// Streamed, not one blob: the stub emits four characters per frame.
		const outputs = renderer.frames.filter((frame) => frame.type === "output");
		expect(outputs.length).toBeGreaterThan(1);
		renderer.close();
	}, 60_000);

	test("a second attached client sees the first client's input_echo", async () => {
		const a = await Renderer.open(base);
		const b = await Renderer.open(base);
		await a.handshake();
		await b.handshake();
		await a.attach(session.id, "client-a");
		await b.attach(session.id, "client-b");
		await a.waitFor((frame) => frame.type === "client_joined" && frame.clientId === "client-b", "client-b joining");

		a.send({ type: "input", data: "typed on the desktop", clientId: "client-a" });

		const echo = await b.waitFor((frame) => frame.type === "input_echo", "the echo of client-a's input");
		expect(echo).toEqual({ type: "input_echo", data: "typed on the desktop", clientId: "client-a" });
		await b.waitFor(
			(frame) => frame.type === "output" && b.output().includes("stub: typed on the desktop"),
			"the shared reply",
		);
		a.close();
		b.close();
	}, 60_000);

	test("an unauthenticated attach is refused before any Unix socket is opened", async () => {
		// The property this test has always proved: an attach that has not
		// authenticated reaches no session. Phase 32 held it by 401-ing the
		// upgrade; R33-REACH.5 cannot, because a device presents its credential in
		// a *frame* and a frame needs the 101 that 401 refused. So the 101 now
		// happens first and the refusal is a `not_authenticated` `protocol_error`
		// on the wire. The mechanism moved one layer in. The property did not, and
		// it is still asserted the only way that means anything: on what the
		// intruder could actually reach.
		const watcher = await Renderer.open(base);
		await watcher.handshake();
		await watcher.attach(session.id, "watcher");
		const joinsBefore = watcher.frames.filter((frame) => frame.type === "client_joined").length;
		const socketsBefore = sockets(join(agentDir, "sockets")).sort();
		expect(socketsBefore).toContain(`${session.id}.sock`);

		// A plain GET is not an upgrade and reaches no handler at all. Kept as an
		// assertion because "the route left the auth middleware" must not quietly
		// become "the route serves something over HTTP".
		expect((await fetch(`${httpBase}/attach`)).status).toBe(404);

		const frames: GeistServerFrame[] = [];
		const intruder: { closed: { code: number; reason: string } | null } = { closed: null };
		const unauthenticated = new WebSocket(`${base}/attach`);
		unauthenticated.addEventListener("message", (event: MessageEvent) => {
			frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		unauthenticated.addEventListener("close", (event: CloseEvent) => {
			intruder.closed = { code: event.code, reason: event.reason };
		});
		const outcome = await new Promise<string>((res) => {
			unauthenticated.addEventListener("open", () => res("open"));
			unauthenticated.addEventListener("error", () => res("error"));
			unauthenticated.addEventListener("close", () => res("close"));
		});
		// The upgrade is expected to succeed now. It is where the credential would
		// have gone, not where it is checked.
		expect(outcome).toBe("open");

		unauthenticated.send(
			JSON.stringify({
				type: "hello",
				protocol: GEIST_PROTOCOL_FAMILY,
				version: GEIST_PROTOCOL_VERSION,
				client: { name: "intruder", version: "0.0.0" },
			}),
		);
		await until(
			() => frames.some((frame) => frame.type === "server_hello"),
			"the daemon's server_hello to the intruder",
		);
		// `server_hello` and nothing else. The fleet listing is session data — ids,
		// working directories, pids — and an unauthenticated peer is not told that
		// a session exists, let alone which.
		expect(frames.filter((frame) => frame.type === "fleet")).toHaveLength(0);

		// The frame that would dial `<id>.sock`, naming a session that really is
		// live. Refused above the switch that looks it up.
		unauthenticated.send(
			JSON.stringify({ type: "attach", sessionId: session.id, clientId: "intruder", mode: "read-write" }),
		);
		const refusal = await until(
			() => frames.find((frame) => frame.type === "protocol_error"),
			`the refusal (saw: ${frames.map((f) => f.type).join(", ")})`,
		);
		expect(refusal).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(await until(() => intruder.closed, "the daemon to drop the intruder")).toMatchObject({ code: 1008 });

		// The two independent proofs that no Unix socket was dialled.
		//
		// The first is the session's own account of who reached it: had the
		// refusal happened after the dial, the already-attached watcher would have
		// been told a new client joined. That is the load-bearing one — it is
		// asserted on the far side of the socket, by the draht process itself.
		await Bun.sleep(1000);
		expect(watcher.frames.filter((frame) => frame.type === "client_joined")).toHaveLength(joinsBefore);
		// The second is the fleet's own filesystem: the same sockets, no more and
		// no fewer, and the named session still published rather than reaped by an
		// intruder-induced failure.
		expect(sockets(join(agentDir, "sockets")).sort()).toEqual(socketsBefore);
		watcher.close();
	}, 60_000);
});

describe("a session that dies under an attached renderer", () => {
	test("the renderer is told the session ended instead of being left on a dead socket", async () => {
		const doomed = await startDrahtSession(agentDir, home);
		const renderer = await Renderer.open(base);
		await renderer.handshake();
		await renderer.attach(doomed.id, "mourner");

		doomed.proc.kill("SIGKILL");
		await doomed.proc.exited;

		const ended = await renderer.waitFor((frame) => frame.type === "error", "the session-ended notice");
		expect(ended).toMatchObject({ type: "error", code: "SESSION_ENDED" });
		await until(() => renderer.closed, "the attach socket to close");
		expect(renderer.closed).toMatchObject({ code: 1001 });
	}, 60_000);
});

describe("bounded transport (R32-FLEET.6)", () => {
	test("an oversized frame drops only the offending client; the other's stream continues", async () => {
		const offender = await Renderer.open(base);
		const healthy = await Renderer.open(base);
		await offender.handshake();
		await healthy.handshake();
		await offender.attach(session.id, "offender");
		await healthy.attach(session.id, "healthy");

		offender.send({ type: "input", data: "x".repeat(70 * 1024), clientId: "offender" });

		const refusal = await offender.waitFor((frame) => frame.type === "protocol_error", "the typed refusal");
		expect(refusal).toMatchObject({ type: "protocol_error", code: "frame_too_large" });
		await until(() => offender.closed, "the offending connection to close");
		expect(offender.closed).toMatchObject({ code: 1008, reason: "frame_too_large" });

		healthy.send({ type: "input", data: "still here", clientId: "healthy" });
		await healthy.waitFor(
			(frame) => frame.type === "output" && healthy.output().includes("stub: still here"),
			"the survivor's stream",
		);
		expect(healthy.closed).toBeNull();
		healthy.close();
	}, 60_000);
});

describe("concurrent writers (R32-FLEET.7)", () => {
	test("a prompt sent mid-stream is queued, acknowledged, and answered — never silently dropped", async () => {
		const renderer = await Renderer.open(base);
		await renderer.handshake();
		await renderer.attach(session.id, "writer");

		const first = "the first prompt is deliberately long so that it is still streaming";
		renderer.send({ type: "input", data: first, clientId: "writer" });
		await renderer.waitFor((frame) => frame.type === "output", "the first reply to start streaming");
		expect(renderer.output()).not.toContain(`stub: ${first}`); // still mid-stream

		const second = "the second prompt arrives mid-stream";
		renderer.send({ type: "input", data: second, clientId: "writer" });

		const notice = await renderer.waitFor((frame) => frame.type === "error", "the client-visible queue notice");
		expect(notice).toMatchObject({ type: "error", code: "PROMPT_QUEUED" });
		expect((notice as Extract<GeistServerFrame, { type: "error" }>).message.toLowerCase()).toContain("queued");

		await renderer.waitFor(
			() => renderer.output().includes(`stub: ${first}`) && renderer.output().includes(`stub: ${second}`),
			"both replies",
			40_000,
		);
		// Order is preserved: the running turn finishes before the queued one starts.
		expect(renderer.output().indexOf(`stub: ${first}`)).toBeLessThan(renderer.output().indexOf(`stub: ${second}`));
		expect(renderer.closed).toBeNull();
		renderer.close();
	}, 90_000);
});
