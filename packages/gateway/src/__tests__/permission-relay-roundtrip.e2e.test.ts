/**
 * R34-PERM.2 — the permission relay, closed end to end over the real wire.
 *
 * This is the file that proves the loop actually joins up. Everything Phase 34 built before it was
 * inert: the socket wire could CARRY a `permission_request` and geist/0.3 could DECLARE one, but
 * nothing in the product ever EMITTED one, and `AgentSession.setPermissionRelay` had zero
 * production callers — so `_wrapUIContext` returned the base untouched and the decorator never ran.
 *
 * Two real processes, neither of them imported:
 *
 *   • the emitted draht binary (`packages/coding-agent/dist/cli.js`) run with `--attachable`
 *     against the keyless stub provider, scripted to issue one real `bash` tool call;
 *   • the daemon its own bin starts (`bun packages/gateway/src/cli.ts`) on an ephemeral loopback
 *     port.
 *
 * Everything asserted below crossed a real transport into a real process. Nothing here constructs
 * an `AttachBridge` or a `createServer()`, and nothing imports the code under test — a
 * package-level test that did could pass while the shipped product relayed nothing at all, which
 * is precisely the state this task inherited.
 *
 * TWO TRANSPORTS, both public, and the second one is not a shortcut:
 *  - a real `WebSocket` to the daemon, which is what a phone speaks;
 *  - a raw `net.Socket` to the `.sock` the emitted binary published, which is what `draht attach`
 *    speaks. It is needed for exactly one thing: the capability gate's NEGATIVE cases. The attach
 *    bridge always declares `permission-relay` and always attaches read-write, so a client that
 *    declared nothing — the case the gate exists for — cannot be built through the gateway at all.
 *    See `RawClient`.
 *
 * THE LOAD-BEARING ASSERTION IS THE MARKER FILE. A frame arriving and a frame going back prove
 * plumbing; a file on disk that exists only because a phone tapped "Yes" proves that the answer
 * reached the permission gate and released a tool call the agent was parked on.
 *
 * Harness hygiene, each item paid for by a probe that passed while proving nothing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env. This repo's interactive shell exports
 *    `auto`, under which the scripted `bash` call is auto-allowed and NO ask is ever raised.
 *  - The agent dir sits directly under /tmp with a short name: a Unix socket path over ~104 bytes
 *    fails to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "permission-relay-roundtrip-e2e-token";

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
	timeoutMs = 30_000,
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

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	marker: string;
	command: string;
	stderr: { text: string };
	/** Path of the session's own Unix socket, for a client that speaks to it directly. */
	socketPath: string;
	/**
	 * Every RPC line the child printed, or `null` when its stdout was not captured.
	 *
	 * Capturing it turns the LOCAL surface into one this test can drive: rpc-mode prints an
	 * `extension_ui_request` and takes an `extension_ui_response` on stdin, which is how the
	 * "a local answer wins" case below answers as a human at the RPC surface would.
	 */
	rpc: Record<string, unknown>[] | null;
	/** Write one RPC command on the child's stdin. */
	sendRpc: (value: unknown) => void;
	/** Close the child's stdin — how a child learns its parent died, and one of shutdown's doorways. */
	closeStdin: () => void;
}

/**
 * Start the emitted draht binary as an attachable session with one scripted tool call queued.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print mode and the
 * process would answer once and exit before anything could attach. It also means the RPC surface
 * is a LIVE local surface, so the ask really is raced between two surfaces — the remote one wins
 * here only because nothing is reading the child's stdout to answer the local one.
 */
async function startDrahtSession(
	agentDir: string,
	home: string,
	extraEnv: Record<string, string> = {},
	options: { captureRpc?: boolean } = {},
): Promise<DrahtSession> {
	const cwd = realpathSync(tempDir("prr-c-"));
	const marker = join(cwd, "approved-from-the-phone.txt");
	const command = `echo approved > ${marker}`;
	const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
	const stderr = { text: "" };
	const rpc: Record<string, unknown>[] | null = options.captureRpc === true ? [] : null;

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
			stdout: rpc === null ? "ignore" : "pipe",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	if (rpc !== null) collectRpcLines(proc.stdout as ReadableStream<Uint8Array>, rpc);

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
		closeStdin: () => {
			const stdin = proc.stdin as { end?: () => void };
			stdin.end?.();
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
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((f) => String(f.type)).join(", ")})`,
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

/**
 * One client speaking the session's OWN socket protocol, with nothing in between.
 *
 * The gateway's attach bridge always declares `permission-relay` and always attaches read-write,
 * so the capability gate's NEGATIVE cases are unreachable through a `WebSocket`: there is no way
 * to ask for a client that declared nothing. This class is how a client that declared nothing gets
 * built — newline-delimited JSON straight into the `.sock` the emitted binary published, which is
 * the same public protocol `draht attach` speaks.
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

	/**
	 * Attach, declaring EXACTLY what the caller says and nothing more.
	 *
	 * `capabilities: undefined` omits the field altogether rather than sending an empty array —
	 * an older client that predates the capability is the case the gate exists for, and it is
	 * distinguishable on the wire only by the field's absence.
	 */
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
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((frame) => String(frame.type)).join(", ")})`,
			timeoutMs,
		);
	}

	/** Every permission frame this client was sent, of any kind. Expected to be EMPTY for two of them. */
	permissionFrames(): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request" || frame.type === "permission_resolved");
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
	mode: "read-write" | "read-only",
	capabilities?: string[],
): Promise<RawClient> {
	const deadline = Date.now() + 15_000;
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
let session: DrahtSession;

beforeAll(async () => {
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("prr-a-");
	home = tempDir("prr-h-");

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
	session = await startDrahtSession(agentDir, home);
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

/** Handshake at the current member and attach to a live session. */
async function attachedTo(sessionId: string, clientId: string): Promise<Renderer> {
	const renderer = await Renderer.open(base);
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-relay-e2e", version: "0.0.0" },
	});
	await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	renderer.send({ type: "attach", sessionId, clientId, mode: "read-write" });
	await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
	return renderer;
}

function attached(clientId: string): Promise<Renderer> {
	return attachedTo(session.id, clientId);
}

test("an ask raised by the agent reaches a phone, the phone's answer runs the tool, and the session records it", async () => {
	const phone = await attached("phone");
	expect(existsSync(session.marker)).toBe(false);

	// The prompt goes down the SAME wire a phone would use. The stub provider answers it with
	// the scripted `bash` call, which the permission gate stops.
	phone.send({ type: "input", data: "run the scripted tool", clientId: "phone" });

	// ── (1) the ask arrives, and it carries the canonical facts, not a prose sentence ──
	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the permission ask", 60_000);
	expect(ask.method).toBe("confirm");
	expect(ask.toolName).toBe("bash");
	expect(ask.toolCallId).toBe("call-1");
	// Canonical: /tmp is a symlink to /private/tmp on macOS, so an un-realpathed cwd would read
	// as a different project on the answering surface.
	expect(ask.cwd).toBe(session.cwd);
	expect(ask.command).toBe(session.command);
	expect(ask.truncated).toBe(false);
	expect(typeof ask.requestId).toBe("string");
	const requestId = ask.requestId as string;

	// The offered set is what may be answered, and each option is named by its own id. Nothing
	// downstream may read meaning out of a position in this array.
	const options = ask.options as { id: string; label: string }[];
	expect(options).toHaveLength(2);
	expect(options.map((option) => option.id).sort()).toEqual(["approve", "deny"]);

	// ── (2) an option nobody offered is SILENCE: refused, and the ask stays answerable ──
	phone.send({
		type: "permission_response",
		clientId: "phone",
		requestId,
		optionId: "definitely-not-offered",
	});
	const refusal = await phone.waitFor((frame) => frame.type === "error", "the refusal of an unoffered option");
	expect(refusal.code).toBe("PERMISSION_INVALID_OPTION");
	// A refusal must never consume the request, and must never take the connection down with
	// it: the human has not answered yet.
	await Bun.sleep(250);
	expect(phone.closed).toBeNull();
	expect(existsSync(session.marker)).toBe(false);

	// ── (3) the real answer wins, and every surface is told who decided ──
	phone.send({ type: "permission_response", clientId: "phone", requestId, optionId: "approve" });

	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution echo",
	);
	expect(resolved.decision).toBe("approved");
	expect(resolved.chosenOptionId).toBe("approve");
	expect(resolved.surface).toBe("attach");
	// Named, and named as the client that actually answered — not as "someone".
	expect(resolved.clientId).toBe("phone");

	// ── (4) THE LOAD-BEARING ONE: the tool ran because the phone said so ──
	await until(
		() => existsSync(session.marker),
		`the approved tool call to run (draht stderr: ${session.stderr.text})`,
		60_000,
	);

	// ── (5) a second answer is TOLD it lost, rather than silently refused as unknown ──
	phone.send({ type: "permission_response", clientId: "phone", requestId, optionId: "deny" });
	const late = await until(
		() => phone.frames.find((frame) => frame.type === "error" && frame.code === "PERMISSION_ALREADY_RESOLVED"),
		"the late answer to be told it lost",
	);
	expect(String(late.message)).toContain("already resolved");
	expect(phone.closed).toBeNull();

	// ── (6) the session's own JSONL records the resolution, with everything needed to audit it ──
	const record = await until(
		() =>
			sessionEntries(agentDir).find(
				(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
			),
		"the permission_resolution entry in the session file",
	);
	expect(record.toolCallId).toBe("call-1");
	expect(record.toolName).toBe("bash");
	expect(record.cwd).toBe(session.cwd);
	expect(record.decision).toBe("approved");
	expect(record.chosenOptionId).toBe("approve");
	expect(record.decidedBy).toEqual({ surface: "attach", clientId: "phone" });
	// The immutable offered set, in the order it was offered — what the human was choosing from.
	expect(record.offeredOptionIds).toEqual(["approve", "deny"]);
	expect((record.detail as Record<string, unknown>).command).toBe(session.command);

	// Exactly one record. A second broadcast or a second append would mean the ask was settled
	// twice, which is the defect the synchronous compare-and-swap exists to prevent.
	const all = sessionEntries(agentDir).filter(
		(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
	);
	expect(all).toHaveLength(1);
	expect(
		phone.frames.filter((frame) => frame.type === "permission_resolved" && frame.requestId === requestId),
	).toHaveLength(1);

	phone.close();
}, 120_000);

test("a client that attaches mid-ask is shown it, and its denial reaches every other surface", async () => {
	// A second session, because the stub scripts exactly one tool call per process: once the
	// script is spent it falls back to its text reply forever, which is what ends the turn.
	// A configured expiry, so the advertised deadline can be checked against a number this test
	// chose rather than against the default it would have had anyway.
	const expiryMs = 90_000;
	const denied = await startDrahtSession(agentDir, home, { DRAHT_PERMISSION_EXPIRY_MS: String(expiryMs) });
	const first = await attachedTo(denied.id, "desktop");

	first.send({ type: "input", data: "run the scripted tool", clientId: "desktop" });
	const ask = await first.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask on the first client",
		60_000,
	);
	const requestId = ask.requestId as string;

	// ── the advertised deadline is the registry's own clock, and it is ADVISORY ──
	//
	// One clock: the frame's `deadline` exists so a surface can draw a countdown, and it is derived
	// from the only timer that can actually end an ask. Nothing remote enforces it — this ask is
	// answered below, and a client-side auto-deny would be a second clock denying in the name of a
	// human who had simply not looked at their phone yet.
	const deadline = Date.parse(String(ask.deadline));
	expect(Number.isFinite(deadline)).toBe(true);
	expect(deadline - Date.now()).toBeGreaterThan(expiryMs / 2);
	expect(deadline - Date.now()).toBeLessThanOrEqual(expiryMs);

	// ── replay: a client that arrives AFTER the ask was raised is still shown it ──
	//
	// This is what makes the ask survive client churn. Delivery is bookkeeping, never a state
	// transition: being shown an ask does not consume it, so the still-pending ask is replayed
	// to the newcomer right after its `session_metadata` — and the client that was already
	// looking at it keeps looking at exactly the same one.
	const late = await attachedTo(denied.id, "phone");
	const replayed = await late.waitFor(
		(frame) => frame.type === "permission_request" && frame.requestId === requestId,
		"the ask replayed to the client that attached mid-ask",
	);
	expect(replayed.toolCallId).toBe("call-1");
	expect(replayed.command).toBe(denied.command);
	// The same ask, not a second one raised for the newcomer.
	expect(late.frames.filter((frame) => frame.type === "permission_request")).toHaveLength(1);

	// ── the latecomer denies, and the denial is read off the option's OWN decision ──
	late.send({ type: "permission_response", clientId: "phone", requestId, optionId: "deny" });

	for (const [who, renderer] of [
		["the answering client", late],
		["the client that lost the race", first],
	] as const) {
		const resolved = await renderer.waitFor(
			(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
			`the resolution on ${who}`,
		);
		expect(resolved.decision).toBe("denied");
		expect(resolved.chosenOptionId).toBe("deny");
		expect(resolved.clientId).toBe("phone");
	}

	// The turn carries on with the call blocked — the stub's fallback reply is what proves the
	// agent was released rather than left parked.
	await until(
		() => first.frames.some((frame) => frame.type === "output"),
		`the turn to continue after the denial (draht stderr: ${denied.stderr.text})`,
		60_000,
	);
	expect(existsSync(denied.marker)).toBe(false);

	const record = await until(
		() =>
			sessionEntries(agentDir).find(
				(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
			),
		"the permission_resolution entry for the denial",
	);
	expect(record.decision).toBe("denied");
	expect(record.chosenOptionId).toBe("deny");
	expect(record.decidedBy).toEqual({ surface: "attach", clientId: "phone" });

	first.close();
	late.close();
}, 120_000);

/**
 * T8-PIN (1) — the fail-closed clock really fires, and the expiry is really recorded.
 *
 * `DRAHT_PERMISSION_EXPIRY_MS` is the seam that makes this a three-second test rather than the
 * hour the backstop defaults to. Everything else is the product: the same binary, the same relay,
 * the same registry timer.
 *
 * The load-bearing part is the pair. A frame saying `expired` proves the timer fired; the JSONL
 * row saying `expired` proves the ending was WRITTEN DOWN, which is what makes a forgotten ask
 * diagnosable afterwards instead of a session that simply never continued. And the marker file
 * must NOT exist: an ask that ran out of time may never let the call it was gating through.
 */
test("an ask nobody answers expires, is announced as the system's doing, and is recorded", async () => {
	const expiryMs = 2_000;
	const forgotten = await startDrahtSession(agentDir, home, { DRAHT_PERMISSION_EXPIRY_MS: String(expiryMs) });
	const phone = await attachedTo(forgotten.id, "phone-expiry");

	phone.send({ type: "input", data: "run the scripted tool", clientId: "phone-expiry" });
	const ask = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask that nobody will answer",
		60_000,
	);
	const requestId = ask.requestId as string;
	const raisedAt = Date.now();

	// Nobody answers. Nothing is sent from here at all.
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the expiry to come back down the wire",
		expiryMs * 10,
	);

	expect(resolved.decision).toBe("expired");
	// Attributed to NOBODY. An expiry recorded against a surface would put a decision in the audit
	// trail that no person made — the exact fabrication the relay exists to refuse.
	expect(resolved.surface).toBe("system");
	expect(resolved.clientId).toBeNull();
	expect(resolved.chosenOptionId).toBeNull();

	// It fired on the configured clock, not on the one-hour default and not instantly.
	const elapsed = Date.now() - raisedAt;
	expect(elapsed).toBeGreaterThanOrEqual(expiryMs - 250);
	expect(elapsed).toBeLessThan(expiryMs * 5);

	const record = await until(
		() =>
			sessionEntries(agentDir).find(
				(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
			),
		"the permission_resolution entry for the expiry",
	);
	expect(record.decision).toBe("expired");
	expect(record.decidedBy).toEqual({ surface: "system", clientId: null });
	expect(record.chosenOptionId).toBeNull();
	// The offered set is still recorded: what the human WOULD have been choosing from is part of
	// what makes an expiry auditable.
	expect(record.offeredOptionIds).toEqual(["approve", "deny"]);

	// FAIL CLOSED. The tool the ask was gating never ran.
	expect(existsSync(forgotten.marker)).toBe(false);

	phone.close();
}, 120_000);

/**
 * T8-PIN (3), (2) and (4) — the capability gate's negative cases, a reconnect, and the second answer.
 *
 * All three need a client the gateway cannot build. The attach bridge always declares
 * `permission-relay` and always attaches read-write, so "a read-write client that declared NO
 * capabilities" and "a read-only client that DID declare it" exist only for a client speaking the
 * session's own socket protocol. That is what `RawClient` is: newline-JSON into the `.sock` the
 * emitted binary published, which is the protocol `draht attach` itself speaks.
 *
 * The gate is asserted in BOTH directions, because either half alone is satisfiable by a bug:
 * a server that sent nothing to anybody would pass the silence assertions, and a server that sent
 * everything to everybody would pass the delivery one.
 */
test("only a capable read-write client is shown an ask — and it survives a reconnect and a second answer", async () => {
	const gated = await startDrahtSession(agentDir, home);
	const socketPath = gated.socketPath;

	// (a) the one client the product would build: read-write, capability declared.
	const capable = await attachRaw(socketPath, "capable", "read-write", ["permission-relay"]);
	// (b) an OLDER client: read-write, no `capabilities` field at all. Not being asked is the
	//     correct outcome — it cannot render the dialog, so a frame would be a dead prompt.
	const legacy = await attachRaw(socketPath, "legacy", "read-write");
	// (c) a WATCHER: it declared the capability, but read-only means it may look, never decide.
	const watcher = await attachRaw(socketPath, "watcher", "read-only", ["permission-relay"]);

	capable.send({ type: "input", data: "run the scripted tool", clientId: "capable" });
	const ask = await capable.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask on the capable client",
		60_000,
	);
	const requestId = ask.requestId as string;
	expect(ask.toolName).toBe("bash");

	// ── (3) ZERO permission frames for the other two ──
	//
	// Given a quarter of a second after the capable client already has the ask: if either of them
	// were going to be sent one, it would have arrived in the same broadcast loop.
	await Bun.sleep(250);
	expect(legacy.permissionFrames()).toEqual([]);
	expect(watcher.permissionFrames()).toEqual([]);
	// They ARE attached and ARE receiving the session's other traffic — the silence is the gate,
	// not a dead connection.
	expect(legacy.frames.some((frame) => frame.type === "session_metadata")).toBe(true);
	expect(watcher.frames.some((frame) => frame.type === "session_metadata")).toBe(true);

	// ── and neither can answer, even knowing the id it was never shown ──
	legacy.send({ type: "permission_response", clientId: "legacy", requestId, optionId: "approve" });
	const legacyRefusal = await legacy.waitFor((frame) => frame.type === "error", "the legacy client's refusal");
	expect(legacyRefusal.code).toBe("PERMISSION_NOT_CAPABLE");

	watcher.send({ type: "permission_response", clientId: "watcher", requestId, optionId: "approve" });
	const watcherRefusal = await watcher.waitFor((frame) => frame.type === "error", "the watcher's refusal");
	expect(watcherRefusal.code).toBe("PERMISSION_READ_ONLY");

	// A refusal never consumes: the ask is still the human's to answer, and nothing has run.
	expect(existsSync(gated.marker)).toBe(false);

	// ── (2) the same client comes back and is shown the SAME ask ──
	//
	// The connection dies mid-ask, exactly as a phone losing signal does. Delivery is
	// per-connection bookkeeping, so the reconnecting client — which may be a brand new process
	// with nothing on its screen — is shown every still-pending ask again.
	capable.destroy();
	const reconnected = await attachRaw(socketPath, "capable", "read-write", ["permission-relay"]);
	const replayed = await reconnected.waitFor(
		(frame) => frame.type === "permission_request",
		"the ask replayed to the reconnected client",
	);
	// THE SAME ask, not a second one raised for the newcomer: the id is what the answer names, and
	// a fresh id here would mean the agent was parked on an ask nobody can now reach.
	expect(replayed.requestId).toBe(requestId);
	expect(replayed.toolCallId).toBe(ask.toolCallId);
	expect(replayed.command).toBe(gated.command);
	expect(reconnected.frames.filter((frame) => frame.type === "permission_request")).toHaveLength(1);

	// ── the answer runs the tool ──
	reconnected.send({ type: "permission_response", clientId: "capable", requestId, optionId: "approve" });
	const resolved = await reconnected.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution",
	);
	expect(resolved.decision).toBe("approved");
	expect(resolved.chosenOptionId).toBe("approve");
	expect(resolved.surface).toBe("attach");
	expect(resolved.clientId).toBe("capable");
	await until(() => existsSync(gated.marker), `the approved tool call to run (stderr: ${gated.stderr.text})`, 60_000);

	// ── (4) a second answer is TOLD it lost, and nothing is written twice ──
	reconnected.send({ type: "permission_response", clientId: "capable", requestId, optionId: "deny" });
	const late = await reconnected.waitFor(
		(frame) => frame.type === "error" && frame.code === "PERMISSION_ALREADY_RESOLVED",
		"the second answer to be told it lost",
	);
	expect(String(late.message)).toContain("already resolved");

	await Bun.sleep(250);
	expect(
		reconnected.frames.filter((frame) => frame.type === "permission_resolved" && frame.requestId === requestId),
	).toHaveLength(1);
	expect(
		sessionEntries(agentDir).filter(
			(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
		),
	).toHaveLength(1);

	// The gate held for the whole ask, resolution included: a `permission_resolved` naming a
	// decision is exactly as undecodable to a client that never got the request.
	expect(legacy.permissionFrames()).toEqual([]);
	expect(watcher.permissionFrames()).toEqual([]);

	reconnected.close();
	legacy.close();
	watcher.close();
}, 180_000);

/**
 * T8-PIN (5) — the LOCAL surface wins, and the record says what actually happened and who did it.
 *
 * This is the end-to-end guard on the two defects the fix agent just closed:
 *
 *  1. `withdraw` hardcoded `cancelled`, so a local approval whose command HAD ALREADY RUN was
 *     broadcast and written down as `{decision: "cancelled", chosenOptionId: null}`;
 *  2. the decorator hardcoded `{surface: "tui"}`, so an answer typed into the RPC surface was
 *     recorded as a human at a terminal that does not exist.
 *
 * Both are only observable when a LOCAL surface beats the remote one, which is why this test reads
 * the child's stdout and answers on its stdin: that is a human at the RPC surface, and the phone
 * attached alongside is what makes the relay live and lets the resolution be observed on the wire.
 */
test("a local RPC answer records the decision it made, attributed to the surface that made it", async () => {
	const local = await startDrahtSession(agentDir, home, {}, { captureRpc: true });
	const rpcLines = local.rpc;
	if (rpcLines === null) throw new Error("the RPC stream was not captured");

	// The phone is here to prove the relay is live and to receive the resolution; it never answers.
	const phone = await attachedTo(local.id, "phone-local");

	local.sendRpc({ id: "p1", type: "prompt", message: "run the scripted tool" });

	// The ask reaches BOTH surfaces: the remote one over the socket, the local one on stdout.
	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the ask on the phone", 60_000);
	const requestId = ask.requestId as string;
	const localAsk = await until(
		() => rpcLines.find((line) => line.type === "extension_ui_request" && line.method === "confirm"),
		`the ask on the local RPC surface (stderr: ${local.stderr.text})`,
	);

	// The human at the terminal answers first.
	local.sendRpc({ type: "extension_ui_response", id: localAsk.id, confirmed: true, optionId: "approve" });

	// ── the command runs, because the local human approved it ──
	await until(
		() => existsSync(local.marker),
		`the locally approved tool call to run (stderr: ${local.stderr.text})`,
		60_000,
	);

	// ── the remote copy comes down saying WHAT was decided, not a guess ──
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the resolution echo on the phone",
	);
	// `approved`, not `cancelled`: the command has already run by the time this frame is built.
	expect(resolved.decision).toBe("approved");
	// `rpc`, not `tui`: this session binds no terminal at all.
	expect(resolved.surface).toBe("rpc");
	expect(resolved.clientId).toBeNull();
	// THE ID THE OPERATOR NAMED. rpc-mode validates an `optionId` against the immutable offered set
	// and lets it override `confirmed`; until T8-FIX2 only the resulting boolean survived the trip
	// through `Promise<boolean>`, so an operator who pressed a named option was recorded with
	// `chosenOptionId: null`. The surface now states its own outcome, id and all.
	expect(resolved.chosenOptionId).toBe("approve");

	// ── and the durable record agrees with the transcript ──
	const record = await until(
		() =>
			sessionEntries(agentDir).find(
				(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
			),
		"the permission_resolution entry for the local approval",
	);
	expect(record.decision).toBe("approved");
	expect(record.decidedBy).toEqual({ surface: "rpc", clientId: null });
	expect(record.chosenOptionId).toBe("approve");
	expect(record.toolName).toBe("bash");
	expect((record.detail as Record<string, unknown>).command).toBe(local.command);

	// Exactly one row and one echo: the decorator withdraws every ask it settles, and a withdrawal
	// of an ask that is already over must be silent.
	expect(
		sessionEntries(agentDir).filter(
			(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
		),
	).toHaveLength(1);
	expect(
		phone.frames.filter((frame) => frame.type === "permission_resolved" && frame.requestId === requestId),
	).toHaveLength(1);

	phone.close();
}, 180_000);

/**
 * T8-FIX2 (1) — AN EXPIRY MUST TAKE THE ASK DOWN EVERYWHERE. This one was FAIL-OPEN.
 *
 * With a phone attached AND a live local RPC surface, the registry's clock fired: the relay
 * broadcast `{decision: "expired", surface: "system"}` and appended a matching JSONL row — and the
 * LOCAL dialog stayed on screen, still wired to the gate's `await`. Answering it with "approve"
 * afterwards RAN THE COMMAND. The durable record said the ask expired and was refused; the marker
 * file said otherwise.
 *
 * THE LOAD-BEARING ASSERTION IS THE ABSENT MARKER FILE, exactly as it is the present one in the
 * happy-path test above. A frame and a row prove the relay's half; only the file proves that the
 * gate's `await` really came back fail-closed and that a late local "yes" cannot revive a dead ask.
 */
test("an expired ask cannot be revived by a late answer on the local surface", async () => {
	const expiryMs = 2_000;
	const forgotten = await startDrahtSession(
		agentDir,
		home,
		{ DRAHT_PERMISSION_EXPIRY_MS: String(expiryMs) },
		{ captureRpc: true },
	);
	const rpcLines = forgotten.rpc;
	if (rpcLines === null) throw new Error("the RPC stream was not captured");

	const phone = await attachedTo(forgotten.id, "phone-late");
	forgotten.sendRpc({ id: "p1", type: "prompt", message: "run the scripted tool" });

	// The ask reaches BOTH surfaces.
	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the ask on the phone", 60_000);
	const requestId = ask.requestId as string;
	const localAsk = await until(
		() => rpcLines.find((line) => line.type === "extension_ui_request" && line.method === "confirm"),
		`the ask on the local RPC surface (stderr: ${forgotten.stderr.text})`,
	);

	// Nobody answers either surface. The registry's own clock ends it.
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the expiry to come back down the wire",
		expiryMs * 10,
	);
	expect(resolved.decision).toBe("expired");
	expect(resolved.surface).toBe("system");

	// ── the late local "yes", on the dialog that used to still be tappable ──
	forgotten.sendRpc({ type: "extension_ui_response", id: localAsk.id, confirmed: true, optionId: "approve" });

	// Long enough for the command to have run several times over if the ask were still live: the
	// happy-path test above sees its marker within the same window.
	await Bun.sleep(3_000);

	// FAIL CLOSED. An ask the record says expired may never let its command through.
	expect(existsSync(forgotten.marker)).toBe(false);

	// And the ending was said ONCE, on the wire and in the session file. A second frame or a
	// second row would mean the ask was settled twice.
	expect(
		phone.frames.filter((frame) => frame.type === "permission_resolved" && frame.requestId === requestId),
	).toHaveLength(1);
	const rows = sessionEntries(agentDir).filter(
		(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.decision).toBe("expired");
	expect(rows[0]?.decidedBy).toEqual({ surface: "system", clientId: null });

	phone.close();
}, 180_000);

/**
 * T8-FIX2 (2) — a shutdown is not a human's refusal.
 *
 * stdin EOF is how a child learns its parent died. rpc-mode handles it by resolving every open
 * dialog fail-closed, and `ExtensionUIContext.confirm` returns a bare `Promise<boolean>` — so that
 * shutdown arrived at the decorator as the same `false` a human pressing "No" produces, and was
 * written into the session as `{decision: "denied", decidedBy: {surface: "rpc", clientId: null}}`:
 * a decision, attributed to a person, for an ask nobody ever answered. Deterministic on every
 * shutdown, every EOF and every `abort`.
 *
 * The record must say `cancelled`, and must name nobody.
 */
test("a shutdown with an ask outstanding is recorded as cancelled by the system, not as a denial", async () => {
	const dying = await startDrahtSession(agentDir, home, {}, { captureRpc: true });
	const rpcLines = dying.rpc;
	if (rpcLines === null) throw new Error("the RPC stream was not captured");

	const phone = await attachedTo(dying.id, "phone-shutdown");
	dying.sendRpc({ id: "p1", type: "prompt", message: "run the scripted tool" });

	const ask = await phone.waitFor((frame) => frame.type === "permission_request", "the ask on the phone", 60_000);
	const requestId = ask.requestId as string;
	await until(
		() => rpcLines.find((line) => line.type === "extension_ui_request" && line.method === "confirm"),
		`the ask on the local RPC surface (stderr: ${dying.stderr.text})`,
	);

	// The bridge dies. Nobody answered anything.
	dying.closeStdin();

	const record = await until(
		() =>
			sessionEntries(agentDir).find(
				(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
			),
		`the permission_resolution entry for the shutdown (stderr: ${dying.stderr.text})`,
		60_000,
	);

	// `cancelled`, not `denied`: nobody refused this call, the process went away underneath it.
	expect(record.decision).toBe("cancelled");
	// And attributed to NOBODY. `{surface: "rpc"}` here names a human at a surface that never
	// showed anyone this ask.
	expect(record.decidedBy).toEqual({ surface: "system", clientId: null });
	expect(record.chosenOptionId).toBeNull();
	expect(record.toolName).toBe("bash");

	// Fail closed, and said once.
	expect(existsSync(dying.marker)).toBe(false);
	expect(
		sessionEntries(agentDir).filter(
			(entry) => entry.type === "permission_resolution" && entry.requestId === requestId,
		),
	).toHaveLength(1);

	phone.close();
}, 180_000);
