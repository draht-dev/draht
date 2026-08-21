/**
 * R32-FLEET.1, .3, .6 — the socket↔renderer attach bridge.
 *
 * The "session" in every case below is a REAL Unix socket bound by `node:net`
 * with a real `<id>.lock` beside it, and the bridge dials it with real
 * `net.connect`. Only the renderer side is a stand-in, and only because the
 * thing being asserted about it — how many bytes it has failed to flush — is
 * exactly what a real slow phone would vary and a test cannot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	DEFAULT_TRANSPORT_LIMITS,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
	type TransportLimits,
} from "@draht/geist-protocol";
import { AttachBridge, type RendererConnection } from "../../src/attach/attach-bridge.js";

const SESSION_ID = "session-under-test";

let socketDir: string;
let session: Server;
let sessionSockets: Socket[] = [];
let sessionLines: string[] = [];
let connectionCount = 0;
const bridges: AttachBridge[] = [];

/** A renderer whose flush behaviour the test controls. */
class FakeRenderer implements RendererConnection {
	readonly sent: string[] = [];
	readonly closes: { code: number; reason: string }[] = [];
	/** Bytes the host has accepted but not flushed. The test moves this. */
	buffered = 0;

	bufferedBytes(): number {
		return this.buffered;
	}

	send(text: string): void {
		this.sent.push(text);
		// A renderer that is backed up stays backed up until the test drains it.
		if (this.buffered > 0) this.buffered += Buffer.byteLength(text);
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
	}

	/** Every frame this renderer received, decoded and re-validated. */
	frames(): GeistServerFrame[] {
		return this.sent.map((text) => ServerFrameSchema.parse(JSON.parse(text)));
	}

	types(): string[] {
		return this.frames().map((frame) => frame.type);
	}

	last(): GeistServerFrame {
		const frames = this.frames();
		const frame = frames[frames.length - 1];
		if (!frame) throw new Error("renderer received no frames");
		return frame;
	}
}

beforeEach(async () => {
	socketDir = mkdtempSync("/tmp/geist-bridge-");
	sessionSockets = [];
	sessionLines = [];
	connectionCount = 0;

	session = createServer((socket) => {
		connectionCount += 1;
		sessionSockets.push(socket);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) sessionLines.push(line);
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve, reject) => {
		session.once("error", reject);
		session.listen(join(socketDir, `${SESSION_ID}.sock`), resolve);
	});
	writeFileSync(join(socketDir, `${SESSION_ID}.lock`), `${process.pid}\n/work/session\n2026-08-18T09:00:00.000Z`, {
		mode: 0o600,
	});
});

afterEach(() => {
	for (const bridge of bridges) bridge.close();
	bridges.length = 0;
	for (const socket of sessionSockets) socket.destroy();
	session.close();
	rmSync(socketDir, { recursive: true, force: true });
});

function makeBridge(renderer: FakeRenderer, limits?: Partial<TransportLimits>): AttachBridge {
	const bridge = new AttachBridge({
		socketDir,
		connection: renderer,
		limits: limits ? { ...DEFAULT_TRANSPORT_LIMITS, ...limits } : undefined,
		drainCheckMs: 5,
	});
	bridges.push(bridge);
	return bridge;
}

function hello(): string {
	return JSON.stringify({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "test-renderer", version: "0.0.0" },
	});
}

/** Wait until `predicate` holds, or fail with what was actually seen. */
async function until(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Drive a bridge to the point where it is attached to the live session. */
async function attached(renderer: FakeRenderer, limits?: Partial<TransportLimits>): Promise<AttachBridge> {
	const bridge = makeBridge(renderer, limits);
	bridge.receive(hello());
	bridge.receive(JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c1", mode: "read-write" }));
	await until(() => sessionLines.length >= 1, "the session to receive the attach");
	return bridge;
}

/** Push one socket-wire line down every open session connection. */
function sessionEmits(line: unknown): void {
	for (const socket of sessionSockets) socket.write(`${JSON.stringify(line)}\n`);
}

/** Every `output` payload this renderer received, in order, concatenated. */
function outputText(renderer: FakeRenderer): string {
	return renderer
		.frames()
		.flatMap((frame) => (frame.type === "output" ? [frame.data] : []))
		.join("");
}

describe("handshake", () => {
	test("nothing is accepted before hello, and no session socket is dialled", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);

		bridge.receive(JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c1", mode: "read-write" }));

		expect(renderer.last()).toEqual({
			type: "protocol_error",
			code: "handshake_required",
			message: "expected hello, got attach",
		});
		expect(renderer.closes).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connectionCount).toBe(0);
	});

	test("hello is answered with server_hello carrying the advertised caps, then the fleet", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);

		bridge.receive(hello());

		expect(renderer.types()).toEqual(["server_hello", "fleet"]);
		const [serverHello, fleet] = renderer.frames();
		expect(serverHello).toMatchObject({
			type: "server_hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			limits: DEFAULT_TRANSPORT_LIMITS,
		});
		expect(fleet).toEqual({
			type: "fleet",
			sessions: [{ id: SESSION_ID, cwd: "/work/session", pid: process.pid, startedAt: "2026-08-18T09:00:00.000Z" }],
		});
	});

	test("a hello from a different protocol family is refused with version_mismatch", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);

		bridge.receive(JSON.stringify({ ...JSON.parse(hello()), protocol: "acp/1.0" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "version_mismatch" });
		expect(renderer.closes).toHaveLength(1);
	});
});

describe("refusals", () => {
	test("a frame over the byte cap draws frame_too_large and closes this connection", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, { maxFrameBytes: 256 });

		bridge.receive(JSON.stringify({ type: "hello", padding: "x".repeat(512) }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "frame_too_large" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "frame_too_large" }]);
	});

	test("a type this direction does not declare draws unknown_type", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "spawn", command: ["/bin/sh", "-c", "touch /tmp/canary"] }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "unknown_type" });
		expect(renderer.closes).toHaveLength(1);
	});

	test("attach to a session that is not live is refused before any socket is dialled", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(
			JSON.stringify({ type: "attach", sessionId: "no-such-session", clientId: "c1", mode: "read-write" }),
		);

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "unknown_session" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connectionCount).toBe(0);
	});

	test("a session id that is a path is refused, and nothing outside the socket dir is dialled", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(
			JSON.stringify({ type: "attach", sessionId: "../../../../tmp/evil", clientId: "c1", mode: "read-write" }),
		);

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "unknown_session" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connectionCount).toBe(0);
	});

	test("input before attach is refused and never reaches a session", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "input", data: "hi", clientId: "c1" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "invalid_frame" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connectionCount).toBe(0);
	});

	test("a second attach on one connection is refused and the first stays attached", async () => {
		const renderer = new FakeRenderer();
		const bridge = await attached(renderer);

		bridge.receive(JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c2", mode: "read-write" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "invalid_frame" });
		expect(connectionCount).toBe(1);
	});
});

describe("relay", () => {
	test("attach reaches the session as the socket wire's attach — sessionId does not travel down it", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer);

		// `capabilities` is the bridge's own declaration (geist/0.3): it says this
		// process can relay permission frames, which is what makes the session
		// willing to emit them. `sessionId` still does not travel down.
		expect(JSON.parse(sessionLines[0]!)).toEqual({
			type: "attach",
			clientId: "c1",
			mode: "read-write",
			capabilities: ["permission-relay"],
		});
	});

	test("input is relayed verbatim, newline-framed", async () => {
		const renderer = new FakeRenderer();
		const bridge = await attached(renderer);

		bridge.receive(JSON.stringify({ type: "input", data: "explain this repo", clientId: "c1" }));
		await until(() => sessionLines.length >= 2, "the session to receive the input");

		expect(JSON.parse(sessionLines[1]!)).toEqual({ type: "input", data: "explain this repo", clientId: "c1" });
	});

	test("every relayed server frame reaches the renderer unchanged", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer);
		const relayed = [
			{
				type: "session_metadata",
				sessionId: SESSION_ID,
				cwd: "/work/session",
				createdAt: "2026-08-18T09:00:00.000Z",
			},
			{ type: "output", data: "stub: hello", stream: "stdout" },
			{ type: "input_echo", data: "typed by the other client", clientId: "other" },
			{ type: "client_joined", clientId: "other", mode: "read-only" },
			{ type: "client_left", clientId: "other" },
			{ type: "error", message: "Read-only clients cannot send input" },
		];

		for (const frame of relayed) sessionEmits(frame);
		await until(() => renderer.frames().length >= 2 + relayed.length, "all relayed frames");

		expect(renderer.frames().slice(2)).toEqual(relayed as GeistServerFrame[]);
	});

	test("several socket-wire lines arriving in one chunk are relayed as separate frames", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer);

		sessionSockets[0]!.write(
			`${JSON.stringify({ type: "output", data: "a", stream: "stdout" })}\n${JSON.stringify({ type: "output", data: "b", stream: "stdout" })}\n`,
		);
		await until(() => renderer.frames().length >= 4, "both output frames");

		expect(renderer.frames().slice(2)).toEqual([
			{ type: "output", data: "a", stream: "stdout" },
			{ type: "output", data: "b", stream: "stdout" },
		]);
	});

	test("detach is relayed and the session socket is closed", async () => {
		const renderer = new FakeRenderer();
		const bridge = await attached(renderer);
		const closed = new Promise<void>((resolve) => sessionSockets[0]!.once("close", () => resolve()));

		bridge.receive(JSON.stringify({ type: "detach", clientId: "c1" }));
		await until(() => sessionLines.length >= 2, "the session to receive the detach");
		await closed;

		expect(JSON.parse(sessionLines[1]!)).toEqual({ type: "detach", clientId: "c1" });
	});

	test("a socket-wire line no exported schema validates is refused here, not relayed onward", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer);

		sessionEmits({ type: "output", data: 42, stream: "stdout" });
		await until(() => renderer.frames().length >= 3, "the refusal");

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "invalid_frame" });
		expect(renderer.closes).toHaveLength(1);
	});
});

describe("session output larger than the frame cap", () => {
	/**
	 * `maxFrameBytes` bounds what a RENDERER may send. Charging session output to
	 * it made one large tool result — a big file read, a long diff — read as
	 * protocol drift, which dropped every client attached to that session at
	 * once: readers that had done nothing but watch.
	 */
	test("one oversized tool result reaches every attached client intact", async () => {
		const first = new FakeRenderer();
		const second = new FakeRenderer();
		await attached(first, { maxFrameBytes: 1024 });
		const secondBridge = makeBridge(second, { maxFrameBytes: 1024 });
		secondBridge.receive(hello());
		secondBridge.receive(
			JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c2", mode: "read-write" }),
		);
		await until(() => connectionCount >= 2, "the second attach");

		// ~12 KB of tool result on one socket-wire line, against a 1 KB cap.
		const toolResult = "line of a very long diff\n".repeat(500);
		sessionEmits({ type: "output", data: toolResult, stream: "stdout" });

		for (const renderer of [first, second]) {
			await until(() => outputText(renderer).length >= toolResult.length, "the whole tool result");
			expect(outputText(renderer)).toBe(toolResult);
			expect(renderer.closes).toHaveLength(0);
			// Chunked, not merely let through: the cap the daemon advertised still
			// describes every frame it sends.
			for (const text of renderer.sent) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		}
	});

	test("a multi-byte payload survives being chunked", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer, { maxFrameBytes: 256 });

		// Emoji are surrogate pairs and 4 UTF-8 bytes each: a chunker that counted
		// characters, or that split a pair without JSON escaping it, corrupts this.
		const emitted = "🌍 unicode tool output — ünïcödé\n".repeat(120);
		sessionEmits({ type: "output", data: emitted, stream: "stdout" });
		await until(() => outputText(renderer).length >= emitted.length, "the whole payload");

		expect(outputText(renderer)).toBe(emitted);
		expect(renderer.closes).toHaveLength(0);
		for (const text of renderer.sent) expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256);
	});
});

describe("client identity is the daemon's, not the caller's", () => {
	/**
	 * The session authorises by client id — read-only mode is checked against it,
	 * and `detach` disconnects whoever it names. Relaying a caller-supplied id
	 * made that authorisation addressable by anyone on the wire.
	 */
	test("input is stamped with the id this connection attached with", async () => {
		const renderer = new FakeRenderer();
		const bridge = await attached(renderer); // attached as c1

		bridge.receive(JSON.stringify({ type: "input", data: "typed by c1", clientId: "c2" }));
		await until(() => sessionLines.length >= 2, "the session to receive the input");

		expect(JSON.parse(sessionLines[1]!)).toEqual({ type: "input", data: "typed by c1", clientId: "c1" });
	});

	test("a detach naming another client detaches only the connection that sent it", async () => {
		const first = new FakeRenderer();
		const second = new FakeRenderer();
		const firstBridge = await attached(first); // attached as c1
		const secondBridge = makeBridge(second);
		secondBridge.receive(hello());
		secondBridge.receive(
			JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c2", mode: "read-write" }),
		);
		await until(() => connectionCount >= 2, "the second attach");

		firstBridge.receive(JSON.stringify({ type: "detach", clientId: "c2" }));
		await until(
			() => sessionLines.some((line) => JSON.parse(line).type === "detach"),
			"the session to receive the detach",
		);

		expect(JSON.parse(sessionLines[sessionLines.length - 1]!)).toEqual({ type: "detach", clientId: "c1" });
		// c2 is untouched: still open, still streaming.
		sessionSockets[1]!.write(`${JSON.stringify({ type: "output", data: "still attached", stream: "stdout" })}\n`);
		await until(
			() => second.frames().some((frame) => frame.type === "output" && frame.data === "still attached"),
			"c2's stream to continue",
		);
		expect(second.closes).toHaveLength(0);
	});
});

describe("bounded transport (R32-FLEET.6)", () => {
	test("a renderer that never drains overflows its outbound frame queue and only it is dropped", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer, { maxOutboundFrames: 4 });
		renderer.buffered = 1; // backed up from here on: nothing flushes

		for (let i = 0; i < 20; i++) sessionEmits({ type: "output", data: `chunk-${i}`, stream: "stdout" });
		await until(() => renderer.closes.length > 0, "the overflow refusal");

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "outbound_queue_overflow" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "outbound_queue_overflow" }]);
		// The cap is a cap: the refusal arrives instead of an unbounded backlog.
		expect(renderer.frames().length).toBeLessThan(20);
	});

	test("a renderer whose buffer passes the byte cap overflows on bytes", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer, { maxBufferedOutputBytes: 512, maxOutboundFrames: 100_000 });
		renderer.buffered = 500;

		sessionEmits({ type: "output", data: "x".repeat(200), stream: "stdout" });
		await until(() => renderer.closes.length > 0, "the overflow refusal");

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "buffered_output_overflow" });
	});

	test("the session is paused while the renderer is backed up and resumed once it drains", async () => {
		const renderer = new FakeRenderer();
		await attached(renderer, { maxBufferedOutputBytes: 1024, maxOutboundFrames: 100_000 });
		renderer.buffered = 900;

		sessionEmits({ type: "output", data: "tick", stream: "stdout" });
		await until(() => bridges[0]!.sessionPaused, "the session to be paused");

		renderer.buffered = 0;
		await until(() => !bridges[0]!.sessionPaused, "the session to be resumed");
		expect(renderer.closes).toHaveLength(0);
	});

	test("a renderer that overflows does not disturb another attached to the same session", async () => {
		const slow = new FakeRenderer();
		const healthy = new FakeRenderer();
		await attached(slow, { maxOutboundFrames: 4 });
		const healthyBridge = makeBridge(healthy);
		healthyBridge.receive(hello());
		healthyBridge.receive(
			JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c2", mode: "read-write" }),
		);
		await until(() => connectionCount >= 2, "the second attach");
		slow.buffered = 1;

		for (let i = 0; i < 20; i++) sessionEmits({ type: "output", data: `chunk-${i}`, stream: "stdout" });
		await until(() => slow.closes.length > 0, "the slow renderer to be dropped");
		sessionEmits({ type: "output", data: "after the drop", stream: "stdout" });
		await until(
			() => healthy.frames().some((frame) => frame.type === "output" && frame.data === "after the drop"),
			"the healthy renderer's stream to continue",
		);

		expect(healthy.closes).toHaveLength(0);
		expect(healthy.frames().filter((frame) => frame.type === "output")).toHaveLength(21);
	});
});

describe("backpressure toward a session that stops reading", () => {
	/**
	 * The backlog is read through the injected host hook rather than from a real
	 * stalled peer, because the two runtimes disagree about what a stalled peer
	 * looks like: node grows `writableLength` without bound, while Bun's
	 * `node:net` reports 0 and acks the write. What is under test here is the
	 * bridge's policy given a host that reports a backlog — the host's own
	 * bookkeeping is the host's to get right.
	 */
	test("a client that outruns the session is refused rather than buffered without bound", async () => {
		const renderer = new FakeRenderer();
		let backlog = 0;
		const bridge = new AttachBridge({
			socketDir,
			connection: renderer,
			limits: { ...DEFAULT_TRANSPORT_LIMITS, maxOutboundFrames: 4 },
			drainCheckMs: 5,
			backlogBytes: () => backlog,
		});
		bridges.push(bridge);
		bridge.receive(hello());
		bridge.receive(JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c1", mode: "read-write" }));
		await until(() => sessionLines.length >= 1, "the session to receive the attach");

		// The session stops draining from here on.
		backlog = 1;
		for (let i = 0; i < 20 && renderer.closes.length === 0; i++) {
			bridge.receive(JSON.stringify({ type: "input", data: `prompt ${i}`, clientId: "c1" }));
		}

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "outbound_queue_overflow" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "outbound_queue_overflow" }]);
	});

	test("a session backlog past the byte cap refuses on bytes", async () => {
		const renderer = new FakeRenderer();
		let backlog = 0;
		const bridge = new AttachBridge({
			socketDir,
			connection: renderer,
			limits: { ...DEFAULT_TRANSPORT_LIMITS, maxBufferedOutputBytes: 512, maxOutboundFrames: 100_000 },
			drainCheckMs: 5,
			backlogBytes: () => backlog,
		});
		bridges.push(bridge);
		bridge.receive(hello());
		bridge.receive(JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId: "c1", mode: "read-write" }));
		await until(() => sessionLines.length >= 1, "the session to receive the attach");

		backlog = 500;
		bridge.receive(JSON.stringify({ type: "input", data: "y".repeat(200), clientId: "c1" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "buffered_output_overflow" });
	});

	test("a healthy session keeps taking input — the bound is a bound, not a throttle", async () => {
		const renderer = new FakeRenderer();
		const bridge = await attached(renderer, { maxOutboundFrames: 2 });

		for (let i = 0; i < 10; i++) {
			bridge.receive(JSON.stringify({ type: "input", data: `prompt ${i}`, clientId: "c1" }));
		}
		await until(() => sessionLines.length >= 11, "every input to reach the session");

		expect(renderer.closes).toHaveLength(0);
	});
});
