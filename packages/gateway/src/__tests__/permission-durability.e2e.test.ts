/**
 * R34-PERM.6 — the pending registry OUTLIVES the client, and says so on the wire.
 *
 * Three properties were measured working by a verifier's probes and pinned by nothing, so all
 * three could regress in silence. This file is what stops that:
 *
 *   1. EXPIRY FIRES AND FAILS CLOSED. The one clock is the registry's own deadline. When it
 *      elapses the ask ends as `expired`, attributed to the system, the tool never runs, and the
 *      session's JSONL carries a row saying so.
 *   2. A RECONNECT UNDER THE SAME clientId IS REPLAYED. A phone that loses signal mid-ask comes
 *      back to the same ask — the same `requestId`, not a new one, because the id is what an
 *      answer names.
 *   3. DELIVERY BOOKKEEPING NEVER TRANSITIONS REQUEST STATE. Being shown an ask does not consume
 *      it and neither does dropping the connection you were shown it on. The wedge this exists to
 *      prevent is documented at `packages/coding-agent/src/modes/rpc/rpc-mode.ts`: a client that
 *      was shown the ask and then died taking it with it, leaving the agent parked in
 *      `beforeToolCall` forever with no surface able to answer.
 *
 * THE EXACTLY-ONCE PROPERTY IS THE INTERESTING ONE, and it is deliberately the WEAKER of the two
 * readings, because the stronger one is not achievable over this transport:
 *
 *   • exactly ONE authoritative resolution per request — the registry's synchronous
 *     compare-and-swap. Asserted below by answering twice and getting a tombstone the second time.
 *   • exactly ONE replay per (connection, still-pending request) — asserted below by counting
 *     `permission_request` frames over a fixed settle window and demanding the number 1, both for
 *     a first attach and for every reattach.
 *
 * Nothing here acks. An ack cannot make delivery authoritative: an ack that arrives says the ask
 * was seen, an ack that never arrives says nothing at all, so a design that consumed the ask on
 * delivery would lose it exactly in the case it was built for.
 *
 * TWO REAL PROCESSES, NEITHER IMPORTED — the emitted `packages/coding-agent/dist/cli.js` run
 * `--attachable` against the keyless stub provider, and the daemon started from
 * `packages/gateway/src/cli.ts`. Two transports, both public: a real `WebSocket` to the daemon
 * (what a phone speaks) and a raw `net.Socket` to the published `.sock` (what `draht --attach`
 * speaks). Nothing constructs a `SocketServer`, a `PermissionRegistry` or a `PermissionDelivery`;
 * a test that did could pass while the shipped binary replayed nothing at all.
 *
 * Harness hygiene, each item paid for by a probe that passed while proving nothing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env. This repo's interactive shell exports
 *    `auto`, under which the scripted `bash` call is auto-allowed and NO ask is ever raised — so
 *    every assertion below would be about a prompt that never happened.
 *  - The agent dir sits directly under /tmp with a short name: a Unix socket path over ~104 bytes
 *    fails to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 *  - `DRAHT_PERMISSION_EXPIRY_MS` is what makes the expiry case a four-second test rather than the
 *    hour the backstop defaults to. It moves the ONE clock; it does not add a second one.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "permission-durability-e2e-token";

/**
 * How long a client is watched, doing nothing, before its frame count is believed.
 *
 * Every "exactly once" assertion below is a claim about what did NOT arrive, and a claim like that
 * is only worth the wait behind it. A second copy of a replayed ask would be written in the same
 * loop as the first, so this is orders of magnitude longer than the window it has to cover.
 */
const SETTLE_MS = 1_500;

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

/** See the header: a long Unix socket path fails to bind with EINVAL. */
function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

/**
 * Poll until `probe` yields something truthy.
 *
 * The result is AWAITED, not merely tested: an async probe returns a Promise and every Promise is
 * truthy, so a version of this helper that skipped the await would succeed on the first tick.
 */
async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 60_000,
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

/** Every `.jsonl` under `dir`, however deep the session store nests them. */
function jsonlFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(full);
			else if (entry.endsWith(".jsonl")) found.push(full);
		}
	};
	walk(dir);
	return found;
}

/** Every parsed line of every session file under the agent dir. */
function sessionEntries(dir: string): Record<string, unknown>[] {
	const entries: Record<string, unknown>[] = [];
	for (const file of jsonlFiles(dir)) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// A half-written trailing line while the session is live is not a failure.
			}
		}
	}
	return entries;
}

function resolutionRows(dir: string, requestId: string): Record<string, unknown>[] {
	return sessionEntries(dir).filter(
		(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
	);
}

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	marker: string;
	command: string;
	stderr: { text: string };
	/** Path of the session's own Unix socket, for a client that speaks to it directly. */
	socketPath: string;
	/** Every RPC line the child printed. The LOCAL surface, readable. */
	rpc: Record<string, unknown>[];
	/** Write one RPC command on the child's stdin. */
	sendRpc: (value: unknown) => void;
}

/**
 * Start the emitted draht binary as an attachable session with one scripted tool call queued.
 *
 * `--mode rpc` is required twice over. With no TTY, `resolveAppMode` falls through to print mode
 * and the process would answer once and exit before anything could attach. And it gives this test
 * a way to raise an ask WITH NOBODY ATTACHED — the prompt goes down stdin, not down the socket —
 * which is the whole point of the "delivered on first attach" case. The RPC surface is a live
 * local surface and is never answered here; the remote client is the only one that ever decides.
 */
async function startDrahtSession(
	agentDir: string,
	home: string,
	extraEnv: Record<string, string> = {},
): Promise<DrahtSession> {
	const cwd = realpathSync(tempDir("pdu-c-"));
	const marker = join(cwd, "approved-after-a-reconnect.txt");
	const command = `echo approved > ${marker}`;
	const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
	const stderr = { text: "" };
	const rpc: Record<string, unknown>[] = [];

	// Built from scratch rather than inherited: this repo's shell exports
	// DRAHT_PERMISSION_MODE=auto, and a permission test run under it passes while proving nothing.
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
				DRAHT_STUB_TOOL_CALLS: script,
				...extraEnv,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	collectRpcLines(proc.stdout as ReadableStream<Uint8Array>, rpc);

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

	return {
		proc,
		id: id.slice(0, -".sock".length),
		cwd,
		marker,
		command,
		stderr,
		socketPath: join(socketDir, id),
		rpc,
		sendRpc: (value: unknown) => {
			const stdin = proc.stdin as { write: (chunk: string) => void };
			stdin.write(`${JSON.stringify(value)}\n`);
		},
	};
}

/**
 * Parse the child's stdout as newline-delimited JSON, dropping the streaming noise.
 *
 * `message_update` carries the whole partial message on every delta, so a captured turn is
 * megabytes of it and nothing here reads any of it.
 */
function collectRpcLines(stream: ReadableStream<Uint8Array>, sink: Record<string, unknown>[]): void {
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				if (part.trim() === "") continue;
				try {
					const parsed = JSON.parse(part) as Record<string, unknown>;
					if (parsed.type === "message_update") continue;
					sink.push(parsed);
				} catch {
					// Startup timings and stray diagnostics are not events.
				}
			}
		}
	})().catch(() => {});
}

/** Raise the scripted ask with NOBODY attached, by prompting down the child's own stdin. */
async function raiseAskWithNobodyAttached(session: DrahtSession): Promise<void> {
	session.sendRpc({ id: "p1", type: "prompt", message: "run the scripted tool" });
	// The local RPC surface being shown the ask is how this test knows the ask EXISTS before any
	// client attaches. Without it, "delivered on attach" would be indistinguishable from
	// "delivered because attaching happened to race the raise".
	await until(
		() => session.rpc.find((line) => line.type === "extension_ui_request" && line.method === "confirm"),
		`the ask to be raised with nobody attached (stderr: ${session.stderr.text})`,
		120_000,
	);
}

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** One renderer, driven exactly as a phone would drive it. */
class Renderer {
	readonly frames: Record<string, unknown>[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			this.frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
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

	async waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		what: string,
		timeoutMs = 60_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((f) => String(f.type)).join(", ")})`,
			timeoutMs,
		);
	}

	/** Every `permission_request` for one id this connection has been sent. */
	asksFor(requestId: string): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request" && frame.requestId === requestId);
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

/**
 * One client speaking the session's OWN socket protocol, with nothing in between.
 *
 * This is the protocol `draht --attach` speaks: newline-delimited JSON straight into the `.sock`
 * the emitted binary published. It is used here for the cases that are about the SESSION's own
 * durability rather than the daemon's, so a failure cannot be blamed on the bridge in the middle.
 */
class RawClient {
	readonly frames: Record<string, unknown>[] = [];
	readonly #socket: Socket;
	#buffer = "";

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.#buffer += chunk;
			const parts = this.#buffer.split("\n");
			this.#buffer = parts.pop() ?? "";
			for (const part of parts) {
				if (part.trim() === "") continue;
				try {
					this.frames.push(JSON.parse(part) as Record<string, unknown>);
				} catch {
					// Not a frame.
				}
			}
		});
		socket.on("error", () => {});
	}

	static async open(socketPath: string): Promise<RawClient> {
		const socket = connect(socketPath);
		await new Promise<void>((res, rej) => {
			socket.once("connect", () => res());
			socket.once("error", (error) => rej(error));
		});
		return new RawClient(socket);
	}

	attach(clientId: string, mode: "read-write" | "read-only", capabilities?: string[]): void {
		const frame: Record<string, unknown> = { type: "attach", clientId, mode };
		if (capabilities !== undefined) frame.capabilities = capabilities;
		this.send(frame);
	}

	send(frame: unknown): void {
		this.#socket.write(`${JSON.stringify(frame)}\n`);
	}

	waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		what: string,
		timeoutMs = 60_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((frame) => String(frame.type)).join(", ")})`,
			timeoutMs,
		);
	}

	asksFor(requestId: string): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request" && frame.requestId === requestId);
	}

	permissionRequests(): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request");
	}

	/** Drop the connection the way a phone losing signal does. */
	destroy(): void {
		this.#socket.destroy();
	}

	close(): void {
		this.#socket.end();
	}
}

/**
 * Attach a raw client, retrying while the server still remembers the previous connection.
 *
 * A reconnect under the SAME id races the server's own `close` handling: until that lands, the id
 * is taken and the attach is refused with "Client ID already connected". Retrying is what a real
 * reconnecting client does too.
 */
async function attachRaw(
	socketPath: string,
	clientId: string,
	mode: "read-write" | "read-only" = "read-write",
	capabilities: string[] = ["permission-relay"],
): Promise<RawClient> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const client = await RawClient.open(socketPath);
		client.attach(clientId, mode, capabilities);
		try {
			await client.waitFor((frame) => frame.type === "session_metadata", `session_metadata for ${clientId}`, 1_500);
			return client;
		} catch (error) {
			client.destroy();
			if (Date.now() > deadline) throw error;
			await Bun.sleep(100);
		}
	}
}

let agentDir: string;
let home: string;
let base: string;

beforeAll(async () => {
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("pdu-a-");
	home = tempDir("pdu-h-");

	const port = freeLoopbackPort();
	const daemonStderr = { text: "" };
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
}, 300_000);

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

/**
 * Handshake at the current member, attach, and retry while the session still holds the id.
 *
 * The retry is not test scaffolding for a flake: a reconnecting phone hits exactly this race, and
 * a client that gave up on the first "Client ID already connected" would never get its ask back.
 */
async function attachRenderer(sessionId: string, clientId: string, timeoutMs = 40_000): Promise<Renderer> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const renderer = await Renderer.open(base);
		renderer.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "permission-durability-e2e", version: "0.0.0" },
		});
		try {
			await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame", 10_000);
			renderer.send({ type: "attach", sessionId, clientId, mode: "read-write" });
			await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata", 3_000);
			return renderer;
		} catch (error) {
			renderer.close();
			if (Date.now() > deadline) throw error;
			await Bun.sleep(150);
		}
	}
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (1) the phone that dropped mid-ask
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A connection ending is not an answer, and it is not a state transition on the ask.
 *
 * The client is SHOWN the ask and then its WebSocket dies without answering — the phone-in-a-lift
 * case. Everything about the ask has to be exactly as it was: same id, same offered set, still
 * answerable. Then the same clientId comes back and is shown it again, ONCE, and its answer runs
 * the command the agent was parked on.
 *
 * The marker file is the load-bearing assertion. A frame arriving proves plumbing; a file that
 * exists only because somebody tapped Approve AFTER a reconnect proves the ask survived the gap
 * with its arm on the permission gate still attached.
 */
test("a client that is shown an ask and then dies gets it back on reconnect — once — and can still answer it", async () => {
	const session = await startDrahtSession(agentDir, home);
	const phone = await attachRenderer(session.id, "phone");
	expect(existsSync(session.marker)).toBe(false);

	phone.send({ type: "input", data: "run the scripted tool", clientId: "phone" });
	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the first ask", 120_000);
	const requestId = ask.requestId as string;
	expect(ask.toolName).toBe("bash");
	expect(ask.command).toBe(session.command);

	// ── the connection dies with the ask unanswered ──
	phone.close();
	await until(() => phone.closed !== null, "the websocket to actually close", 10_000);

	// ── the SAME clientId comes back ──
	const reconnected = await attachRenderer(session.id, "phone");
	const replayed = await reconnected.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed after the reconnect",
	);
	// THE SAME ask. A fresh id would mean the agent is parked on one nobody can now reach, and the
	// answer sent below would name a request that does not exist.
	expect(replayed.requestId).toBe(requestId);
	expect(replayed.toolCallId).toBe(ask.toolCallId);
	expect(replayed.command).toBe(session.command);
	expect(replayed.cwd).toBe(session.cwd);
	expect(replayed.options).toEqual(ask.options);

	// ── EXACTLY ONCE on this connection ──
	//
	// Counted over a settle window rather than sampled: a second copy would be written in the same
	// loop as the first, so anything that arrives at all arrives well inside this.
	await Bun.sleep(SETTLE_MS);
	expect(reconnected.asksFor(requestId)).toHaveLength(1);

	// ── a THIRD party attaching does not put a second copy on this connection ──
	//
	// Replay is targeted at the client that just attached, not broadcast. A replay that went out
	// to everybody would show every attached surface a duplicate of a dialog it already has open
	// every time anyone else joined.
	const desktop = await attachRenderer(session.id, "desktop");
	await desktop.waitFor(
		(frame) => frame.type === "permission_request" && frame.requestId === requestId,
		"the ask replayed to the second client",
	);
	await Bun.sleep(SETTLE_MS);
	expect(reconnected.asksFor(requestId)).toHaveLength(1);
	expect(desktop.asksFor(requestId)).toHaveLength(1);

	// Nothing has run. Being shown an ask twice, on two connections, decided nothing.
	expect(existsSync(session.marker)).toBe(false);

	// ── the answer given AFTER the reconnect reaches the gate ──
	reconnected.send({ type: "permission_response", clientId: "phone", requestId, optionId: "approve" });
	const resolved = await reconnected.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution after the reconnect",
	);
	expect(resolved.decision).toBe("approved");
	expect(resolved.chosenOptionId).toBe("approve");
	expect(resolved.clientId).toBe("phone");

	await until(
		() => existsSync(session.marker),
		`the tool approved after a reconnect to run (stderr: ${session.stderr.text})`,
		120_000,
	);

	// One authoritative resolution, and one row. The reconnect did not duplicate the ask's ending.
	expect(resolutionRows(agentDir, requestId)).toHaveLength(1);

	reconnected.close();
	desktop.close();
}, 300_000);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (2) raised with nobody attached, and replayed on every new connection
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * An ask raised into an empty room is still an ask.
 *
 * The prompt goes down the child's own stdin, so at the moment the agent parks on the permission
 * gate there is NO socket client at all — the fan-out reaches nobody and the registry is the only
 * thing that holds the ask. Attaching for the first time has to produce it.
 *
 * Then the same client attaches twice more. Each new connection is a new delivery: a reattaching
 * peer may be a whole new process with nothing on its screen, so remembering what the previous
 * connection had been shown would leave it staring at a session whose ask it cannot see. Within
 * any one connection it arrives exactly once.
 */
test("an ask raised with nobody attached is delivered on first attach, and again on every reattach", async () => {
	const session = await startDrahtSession(agentDir, home);
	await raiseAskWithNobodyAttached(session);

	// ── first attach, into a session that has been holding the ask on its own ──
	const first = await attachRaw(session.socketPath, "late-comer");
	const ask = await first.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask delivered on the very first attach",
	);
	const requestId = ask.requestId as string;
	expect(ask.toolName).toBe("bash");
	expect(ask.command).toBe(session.command);
	await Bun.sleep(SETTLE_MS);
	expect(first.asksFor(requestId)).toHaveLength(1);
	expect(first.permissionRequests()).toHaveLength(1);

	// ── second connection, same id, still unanswered ──
	first.destroy();
	const second = await attachRaw(session.socketPath, "late-comer");
	const again = await second.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed on the second attach",
	);
	expect(again.requestId).toBe(requestId);
	await Bun.sleep(SETTLE_MS);
	expect(second.asksFor(requestId)).toHaveLength(1);

	// ── third connection, same id, still unanswered ──
	second.destroy();
	const third = await attachRaw(session.socketPath, "late-comer");
	const thirdTime = await third.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed on the third attach",
	);
	expect(thirdTime.requestId).toBe(requestId);
	await Bun.sleep(SETTLE_MS);
	expect(third.asksFor(requestId)).toHaveLength(1);

	// Three deliveries, three connections, ONE ask — and it is still the only thing that can be
	// answered. Nothing ran, and nothing has been written down, because nobody decided anything.
	expect(existsSync(session.marker)).toBe(false);
	expect(resolutionRows(agentDir, requestId)).toHaveLength(0);

	// The arm on the permission gate is still attached after three connections came and went.
	third.send({ type: "permission_response", clientId: "late-comer", requestId, optionId: "approve" });
	const resolved = await third.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution after three connections",
	);
	expect(resolved.decision).toBe("approved");
	await until(
		() => existsSync(session.marker),
		`the tool to run after three connections (stderr: ${session.stderr.text})`,
		120_000,
	);

	third.close();
}, 300_000);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (3) expiry fails closed, and a dead ask is never replayed
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The ONE clock fires, fails closed, and takes the ask out of the replay set with it.
 *
 * `DRAHT_PERMISSION_EXPIRY_MS` moves the registry's own deadline; it does not introduce a second
 * clock. The frame's `deadline` field is ADVISORY RENDERING DATA — something a surface can draw a
 * countdown to — and nothing remote may deny on it. A client-side auto-deny would be a NEW denial
 * path, denying in the name of a human who simply had not looked at their phone yet, and it would
 * contradict the archived R34-PERM.8 measurement that the agent core imposes no deadline at all.
 *
 * Three assertions, and the third is the durability one this file exists for: after the ask has
 * expired, a reconnecting client is shown NOTHING. Replaying a dead ask would put a dialog on a
 * phone whose every possible answer is already refused.
 */
test("an unanswered ask expires on the registry's clock, fails closed, and is never replayed afterwards", async () => {
	const expiryMs = 4_000;
	const session = await startDrahtSession(agentDir, home, { DRAHT_PERMISSION_EXPIRY_MS: String(expiryMs) });
	const phone = await attachRaw(session.socketPath, "phone-expiry");

	phone.send({ type: "input", data: "run the scripted tool", clientId: "phone-expiry" });
	const ask = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask nobody will answer",
		120_000,
	);
	const requestId = ask.requestId as string;
	const raisedAt = Date.now();

	// ── the advertised deadline is the ONE clock, and it is ADVISORY ──
	//
	// Measured against the frame's own `requestedAt` rather than against this process's wall clock:
	// the two are minutes apart under load, and what is being asserted is which timer the SESSION
	// armed, not how fast this test got scheduled. A window of `expiryMs` here is a window the
	// one-hour default could never fit through.
	const deadline = Date.parse(String(ask.deadline));
	const requestedAt = Date.parse(String(ask.requestedAt));
	expect(Number.isFinite(deadline)).toBe(true);
	expect(Number.isFinite(requestedAt)).toBe(true);
	expect(deadline - requestedAt).toBeGreaterThan(0);
	expect(deadline - requestedAt).toBeLessThanOrEqual(expiryMs + 1_000);

	// Nobody answers. Nothing is sent from here at all.
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the expiry to come back down the wire",
		expiryMs * 10,
	);
	expect(resolved.decision).toBe("expired");
	// Attributed to NOBODY. An expiry recorded against a surface would put a decision in the audit
	// trail that no person made.
	expect(resolved.surface).toBe("system");
	expect(resolved.clientId).toBeNull();
	expect(resolved.chosenOptionId).toBeNull();

	// It fired on the configured clock rather than instantly: an ask that ended the moment it was
	// raised would be a deadline of zero, which is a denial dressed as a timeout.
	const elapsed = Date.now() - raisedAt;
	expect(elapsed).toBeGreaterThan(expiryMs / 2);

	// ── FAIL CLOSED: the tool the ask was gating never ran ──
	expect(existsSync(session.marker)).toBe(false);

	// ── the durable record says so ──
	const rows = await until(() => {
		const found = resolutionRows(agentDir, requestId);
		return found.length > 0 ? found : undefined;
	}, "the permission_resolution row for the expiry");
	expect(rows).toHaveLength(1);
	expect(rows[0]?.decision).toBe("expired");
	expect(rows[0]?.decidedBy).toEqual({ surface: "system", clientId: null });
	expect(rows[0]?.chosenOptionId).toBeNull();

	// ── an expired ask is NOT in the replay set ──
	phone.destroy();
	const afterwards = await attachRaw(session.socketPath, "phone-expiry");
	await Bun.sleep(SETTLE_MS);
	expect(afterwards.permissionRequests()).toEqual([]);
	// And it stays fail-closed: answering the id it used to have is refused, not honoured.
	afterwards.send({ type: "permission_response", clientId: "phone-expiry", requestId, optionId: "approve" });
	const refusal = await afterwards.waitFor((frame) => frame.type === "error", "the refusal of an expired ask");
	expect(refusal.code).toBe("PERMISSION_ALREADY_RESOLVED");
	await Bun.sleep(500);
	expect(existsSync(session.marker)).toBe(false);
	expect(resolutionRows(agentDir, requestId)).toHaveLength(1);

	afterwards.close();
}, 300_000);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (4) an answered ask is over, and stays over across a reconnect
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Answering removes the entry — and the tombstone is what makes the removal legible.
 *
 * A client that answers and then drops its connection must not come back to the dialog it already
 * decided; that would be a second chance to change a decision the agent has already acted on. And
 * when it replays its own stale answer — which a reconnecting renderer with a queued outbox
 * genuinely does — it must be TOLD the ask was already resolved rather than handed a bare
 * unknown-id refusal. The two read identically to a human and mean opposite things: one says "your
 * answer landed", the other says "your answer was lost".
 */
test("an answered ask is not replayed on reconnect, and its stale answer is refused as already resolved", async () => {
	const session = await startDrahtSession(agentDir, home);
	const phone = await attachRaw(session.socketPath, "decider");

	phone.send({ type: "input", data: "run the scripted tool", clientId: "decider" });
	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the ask to answer", 120_000);
	const requestId = ask.requestId as string;

	phone.send({ type: "permission_response", clientId: "decider", requestId, optionId: "approve" });
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution",
	);
	expect(resolved.decision).toBe("approved");
	await until(() => existsSync(session.marker), `the approved tool to run (stderr: ${session.stderr.text})`, 120_000);

	// ── the answering client drops and comes back ──
	phone.destroy();
	const returned = await attachRaw(session.socketPath, "decider");
	await Bun.sleep(SETTLE_MS);
	// NOTHING. The ask is over; a replay here would be a live Approve button on a command that has
	// already run.
	expect(returned.permissionRequests()).toEqual([]);

	// ── the stale answer from its outbox is told what happened, not that the ask is unknown ──
	returned.send({ type: "permission_response", clientId: "decider", requestId, optionId: "approve" });
	const late = await returned.waitFor(
		(frame) => frame.type === "error",
		"the stale answer to be told the ask was already resolved",
	);
	expect(late.code).toBe("PERMISSION_ALREADY_RESOLVED");
	expect(String(late.message)).toContain("already resolved");

	// Said once, written once. A stale answer settles nothing a second time.
	await Bun.sleep(500);
	expect(returned.frames.filter((frame) => frame.type === "permission_resolved")).toHaveLength(0);
	expect(resolutionRows(agentDir, requestId)).toHaveLength(1);

	returned.close();
}, 300_000);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (5) and (6) — who the replay is NOT for
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The replay is GATED by exactly the predicate emission is gated by, and nothing above proved it.
 *
 * Every case in this file so far attaches a read-write client that declares `permission-relay`, so
 * `RawClient.attach`'s `mode` and `capabilities` parameters had no call site that ever varied them
 * — and removing the `#mayReceivePermissionFrames(client)` check from the attach handler, so that
 * every attach replays the whole backlog unconditionally, left all four green. These two cases are
 * the negative witness: two clients that must be shown NOTHING, watched over the same settle
 * window the positive cases use.
 *
 * Both tests carry a POSITIVE CONTROL in the same session, at the same moment, over the same
 * socket: a capable read-write client that DOES get the ask. Without it, a harness that had
 * silently stopped raising asks at all would pass these by proving nothing — which is the exact
 * failure mode this whole file exists to catch.
 */

/**
 * A client that never declared the capability cannot decode the frame — so it is never sent one.
 *
 * The skew this protects is the whole reason emission is opt-in: a bridge built before geist/0.3
 * sends an attach line with no `capabilities` at all, and a `permission_request` arriving at it is
 * an unknown frame type, which ends the connection with `protocol_error` and close 1008. Replaying
 * a BACKLOG at such a client would drop it on the way in, on the strength of asks it never asked
 * for — a watcher that could have kept watching, disconnected by a feature it does not have.
 */
test("a read-write client that never declared permission-relay is replayed NOTHING on attach", async () => {
	const session = await startDrahtSession(agentDir, home);
	await raiseAskWithNobodyAttached(session);

	// Read-WRITE — it may type into the session, it simply cannot render a permission dialog. The
	// mode is not what disqualifies it here; the empty capability list is.
	const older = await attachRaw(session.socketPath, "older-bridge", "read-write", []);
	await Bun.sleep(SETTLE_MS);
	expect(older.permissionRequests()).toEqual([]);
	// Still attached, not dropped: being ineligible for a frame is not an error, and nothing was
	// sent that could have closed the connection.
	expect(older.frames.some((frame) => frame.type === "session_metadata")).toBe(true);

	// ── the positive control: the ask is real, pending, and replayable RIGHT NOW ──
	const capable = await attachRaw(session.socketPath, "capable-phone", "read-write", ["permission-relay"]);
	const ask = await capable.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed to the client that declared the capability",
	);
	const requestId = ask.requestId as string;
	expect(ask.command).toBe(session.command);

	// A frame was written to somebody, over this same socket, while the older bridge sat there.
	await Bun.sleep(SETTLE_MS);
	expect(older.permissionRequests()).toEqual([]);

	// ── and it is not told how the ask ENDED either ──
	//
	// Gated by the same predicate: a client that could not have been asked is not sent a resolution
	// for a dialog it never had.
	capable.send({ type: "permission_response", clientId: "capable-phone", requestId, optionId: "approve" });
	await capable.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution reaching the capable client",
	);
	await Bun.sleep(SETTLE_MS);
	expect(older.frames.filter((frame) => frame.type === "permission_resolved")).toEqual([]);

	older.close();
	capable.close();
}, 300_000);

/**
 * A read-only peer may WATCH the session and may never decide anything in it.
 *
 * Declaring `permission-relay` is a statement about what a client can RENDER, not about what it is
 * allowed to do. Replaying the backlog to a read-only client would put a live Approve button on a
 * surface whose answer the session refuses — a dialog that can only ever produce a refusal, shown
 * to somebody who has no way to know that before tapping it.
 */
test("a read-only client that DOES declare permission-relay is replayed NOTHING on attach", async () => {
	const session = await startDrahtSession(agentDir, home);
	await raiseAskWithNobodyAttached(session);

	// The capability IS declared. Only the mode disqualifies it — the other half of the predicate.
	const watcher = await attachRaw(session.socketPath, "read-only-watcher", "read-only", ["permission-relay"]);
	await Bun.sleep(SETTLE_MS);
	expect(watcher.permissionRequests()).toEqual([]);
	expect(watcher.frames.some((frame) => frame.type === "session_metadata")).toBe(true);

	// ── the positive control, again in the same session and over the same socket ──
	const decider = await attachRaw(session.socketPath, "deciding-phone", "read-write", ["permission-relay"]);
	const ask = await decider.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed to the read-write client",
	);
	const requestId = ask.requestId as string;
	await Bun.sleep(SETTLE_MS);
	expect(watcher.permissionRequests()).toEqual([]);

	// The read-only peer is not told how it ended either, and the answer that DID land came from
	// the client that was allowed to give one.
	decider.send({ type: "permission_response", clientId: "deciding-phone", requestId, optionId: "approve" });
	const resolved = await decider.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution after the read-only peer was shown nothing",
	);
	expect(resolved.clientId).toBe("deciding-phone");
	await Bun.sleep(SETTLE_MS);
	expect(watcher.frames.filter((frame) => frame.type === "permission_resolved")).toEqual([]);

	// One decision, one row, and it names the client that was eligible to make it.
	expect(resolutionRows(agentDir, requestId)).toHaveLength(1);

	watcher.close();
	decider.close();
}, 300_000);
