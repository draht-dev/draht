/**
 * R34-PERM.5, the adversarial half — every refused answer leaves the ask STILL ANSWERABLE.
 *
 * `permission-relay-roundtrip.e2e.test.ts` proves the loop closes. This file proves the loop cannot
 * be closed by ACCIDENT: an id nobody minted, an option nobody offered, an id minted by a DIFFERENT
 * session, and a read-only watcher all fail — and none of them consumes the ask, so the human whose
 * decision the agent is parked on can still make it afterwards.
 *
 * THE LOAD-BEARING ASSERTION IS THE LAST ONE, not the refusals. Four `error` frames prove only that
 * something was rejected; a rejection that had silently resolved the request to `false` would emit
 * exactly the same four. What proves non-consumption is that the VALID answer sent AFTER all four
 * still wins — `permission_resolved{decision:"approved"}` on the wire and the marker file on disk,
 * written by a bash call the permission gate was holding the whole time.
 *
 * The in-house precedents this exists to keep out (all three still live in this repo):
 *  - packages/geist-acp/src/acp-harness-session.ts:325-332 — deletes the pending entry, THEN
 *    resolves with a completely unvalidated `optionId`.
 *  - packages/coding-agent/src/modes/rpc/rpc-mode.ts:856-859 — get-on-id, delete, resolve; a
 *    matching-id malformed response consumes the ask and lands as a silent DENY.
 *  - packages/geist-acp/src/acp-harness-session.ts:469-470 — per-session counter ids (`perm-${n}`),
 *    which collide across sessions on the first ask of every process.
 *
 * WHAT THE CROSS-SESSION CASE ACTUALLY TESTS, stated plainly because the plan's wording predates
 * the shipped code: `SettleRefusal "cross_session"` is UNREACHABLE from the socket path.
 * `SocketPermissionRelay.handleResponse` always passes its OWN bound `sessionId` to
 * `registry.settle`, so a client cannot present a foreign session id at all — the branch is a guard
 * on direct registry use (an in-process caller holding two registries), not a wire-reachable state.
 * What IS wire-reachable, and what is tested below, is the defect that guard exists for: an id
 * minted by another session, replayed here, must (a) be refused HERE and (b) leave the ask it
 * really belongs to untouched IN THE SESSION THAT OWNS IT. Both halves are asserted, the second by
 * going on to answer that other session's ask successfully. That is the property `perm-${n}` ids
 * break, and it holds here because ids are `crypto.randomUUID` and each session keys its own
 * registry.
 *
 * Two real processes, neither imported: the emitted `packages/coding-agent/dist/cli.js` under
 * `--attachable`, and the daemon (`bun packages/gateway/src/cli.ts`). Everything below crossed a
 * real WebSocket or a real Unix socket.
 *
 * Harness hygiene, each item paid for by a probe that passed while proving nothing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env. This repo's interactive shell exports
 *    `auto`, under which the scripted `bash` call is auto-allowed and NO ask is ever raised — every
 *    assertion below would then be waiting on a prompt that never happens.
 *  - The agent dir sits directly under /tmp with a short name: a Unix socket path over ~104 bytes
 *    fails to bind with EINVAL.
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
const TOKEN = "permission-answer-validation-e2e-token";

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

/** Every `permission_resolution` row for one request id, across every session file. */
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
}

/**
 * Start the emitted draht binary as an attachable session with one scripted tool call queued.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print mode and the
 * process would answer once and exit before anything could attach. Nothing reads this child's
 * stdout, so the local RPC surface never answers and the ask stays parked for as long as the test
 * needs it — which is exactly the situation the refusals below have to survive.
 */
async function startDrahtSession(
	agentDir: string,
	home: string,
	tag: string,
	extraEnv: Record<string, string> = {},
): Promise<DrahtSession> {
	const cwd = realpathSync(tempDir(`pav-c-${tag}-`));
	const marker = join(cwd, "ran-because-somebody-approved.txt");
	const command = `echo approved > ${marker}`;
	const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
	const stderr = { text: "" };

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

	return {
		proc,
		id: id.slice(0, -".sock".length),
		cwd,
		marker,
		command,
		stderr,
		socketPath: join(socketDir, id),
	};
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

	errors(): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "error");
	}

	resolutions(requestId?: string): Record<string, unknown>[] {
		return this.frames.filter(
			(frame) => frame.type === "permission_resolved" && (requestId === undefined || frame.requestId === requestId),
		);
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
 * The gateway's attach bridge always attaches read-write and always declares `permission-relay`, so
 * a READ-ONLY answerer cannot be built through a `WebSocket` at all. This is how one gets built:
 * newline-delimited JSON straight into the `.sock` the emitted binary published, which is the same
 * public protocol `draht attach` speaks.
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
		timeoutMs = 30_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((frame) => String(frame.type)).join(", ")})`,
			timeoutMs,
		);
	}

	permissionFrames(): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request" || frame.type === "permission_resolved");
	}

	destroy(): void {
		this.#socket.destroy();
	}

	close(): void {
		this.#socket.end();
	}
}

/**
 * Attach a raw client, retrying while the server still remembers a previous connection.
 *
 * A reconnect under the SAME id races the server's own `close` handling: until that lands, the id
 * is taken and the attach is refused. Retrying is what a real reconnecting client does too.
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

beforeAll(async () => {
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("pav-a-");
	home = tempDir("pav-h-");

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

/** Handshake at the current member and attach to a live session. */
async function attachedTo(sessionId: string, clientId: string): Promise<Renderer> {
	const renderer = await Renderer.open(base);
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-answer-validation-e2e", version: "0.0.0" },
	});
	await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	renderer.send({ type: "attach", sessionId, clientId, mode: "read-write" });
	await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
	return renderer;
}

/** Raise the scripted ask on a session and return the id an answer has to name. */
async function raiseAsk(session: DrahtSession, phone: Renderer, clientId: string): Promise<string> {
	expect(existsSync(session.marker)).toBe(false);
	phone.send({ type: "input", data: "run the scripted tool", clientId });
	const ask = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask on ${clientId} (stderr: ${session.stderr.text})`,
		60_000,
	);
	expect(ask.toolName).toBe("bash");
	expect(ask.command).toBe(session.command);
	const options = ask.options as { id: string; label: string }[];
	// The immutable offered set. Everything below is measured against exactly these two ids.
	expect(options.map((option) => option.id).sort()).toEqual(["approve", "deny"]);
	return ask.requestId as string;
}

test("four bad answers are each refused and none of them consumes the ask — the valid one still wins", async () => {
	// The session whose ask is under attack, and a SECOND, independent one whose request id is
	// borrowed for the cross-session case. Two processes, two registries, two `crypto.randomUUID`
	// id spaces.
	const victim = await startDrahtSession(agentDir, home, "v");
	const other = await startDrahtSession(agentDir, home, "o");

	const phone = await attachedTo(victim.id, "phone");
	// A second capable read-write client on the SAME session. It never sends anything: it is here
	// to prove every refusal below is TARGETED AT THE SENDER. A refusal broadcast to the session
	// would put an error on the screen of a human who is still being asked to decide.
	const bystander = await attachedTo(victim.id, "bystander");
	const otherPhone = await attachedTo(other.id, "other-phone");

	const requestId = await raiseAsk(victim, phone, "phone");
	const foreignRequestId = await raiseAsk(other, otherPhone, "other-phone");
	// Ids are per-ask UUIDs, not a per-session counter. `perm-${n}` ids (the shape
	// geist-acp still mints) would make these two strings EQUAL on the first ask of each process,
	// and the cross-session replay below would then be indistinguishable from a valid answer.
	expect(foreignRequestId).not.toBe(requestId);

	// The ask is visible to both attached clients, so "no resolution" below is measured against a
	// client that really was watching this ask.
	await bystander.waitFor(
		(frame) => frame.type === "permission_request" && frame.requestId === requestId,
		"the ask replayed to the bystander",
	);

	/** One refusal round trip: send, expect this code back, and expect nothing to have been decided. */
	const expectRefused = async (
		what: string,
		send: () => void,
		expected: { on: { errors(): Record<string, unknown>[] }; code: string },
	): Promise<Record<string, unknown>> => {
		const before = expected.on.errors().length;
		send();
		const error = await until(() => expected.on.errors().slice(before)[0], `the refusal of ${what}`);
		expect(error.code).toBe(expected.code);

		// NOTHING was decided by that. Given a quarter of a second: a resolution would have been
		// broadcast in the same tick the answer was handled.
		await Bun.sleep(250);
		expect(phone.resolutions()).toEqual([]);
		expect(bystander.resolutions()).toEqual([]);
		expect(existsSync(victim.marker)).toBe(false);
		expect(resolutionRows(agentDir, requestId)).toEqual([]);
		// Targeted at the sender: the client that did nothing wrong is told nothing at all.
		expect(bystander.errors()).toEqual([]);
		// And a refusal never takes the connection down with it — the human has not answered yet.
		expect(phone.closed).toBeNull();
		expect(bystander.closed).toBeNull();
		return error;
	};

	// ── (1) an id nobody ever minted ──
	//
	// The temptation this rules out is mapping an unknown id onto "the one pending ask": the gate
	// serializes tool asks, so at this instant there IS exactly one, and answering it would look
	// like it worked.
	const unknown = await expectRefused(
		"an id nobody minted",
		() =>
			phone.send({
				type: "permission_response",
				clientId: "phone",
				requestId: crypto.randomUUID(),
				optionId: "approve",
			}),
		{ on: phone, code: "PERMISSION_UNKNOWN_REQUEST" },
	);
	expect(String(unknown.message)).toContain("No permission ask");

	// ── (2) an option nobody offered ──
	//
	// `maybe` is not in the frozen offered set. It must be SILENCE: not a dismissal, not a deny,
	// and above all not a decision anybody can later attribute to the human.
	const invalid = await expectRefused(
		"an option nobody offered",
		() => phone.send({ type: "permission_response", clientId: "phone", requestId, optionId: "maybe" }),
		{ on: phone, code: "PERMISSION_INVALID_OPTION" },
	);
	expect(String(invalid.message)).toContain("was not offered");
	// It named the ask it could not answer, so a renderer can keep the right dialog on screen.
	expect(String(invalid.message)).toContain(requestId);

	// ── (3) an id minted by a DIFFERENT session ──
	//
	// See the file header: the wire cannot present a foreign SESSION id, so what is tested is the
	// defect the `cross_session` guard exists for — a foreign REQUEST id, replayed here. It must be
	// refused here AND leave the ask it belongs to untouched over there.
	await expectRefused(
		"a request id minted by another session",
		() =>
			phone.send({
				type: "permission_response",
				clientId: "phone",
				requestId: foreignRequestId,
				optionId: "approve",
			}),
		{ on: phone, code: "PERMISSION_UNKNOWN_REQUEST" },
	);
	// The other session neither resolved its ask nor ran its command because of a frame sent to
	// this one. Cross-session settlement is the failure mode; this is its absence.
	expect(otherPhone.resolutions()).toEqual([]);
	expect(existsSync(other.marker)).toBe(false);
	expect(resolutionRows(agentDir, foreignRequestId)).toEqual([]);

	// ── (4) a read-only watcher answering ──
	//
	// It declared the capability and knows the real id and a real option: the ONLY thing wrong with
	// this answer is who sent it. Refused at the socket layer, before the relay ever sees it.
	const watcher = await attachRaw(victim.socketPath, "watcher", "read-only", ["permission-relay"]);
	await expectRefused(
		"a read-only client answering",
		() => watcher.send({ type: "permission_response", clientId: "watcher", requestId, optionId: "approve" }),
		{ on: { errors: () => watcher.frames.filter((frame) => frame.type === "error") }, code: "PERMISSION_READ_ONLY" },
	);
	// A read-only client is never shown an ask either, so it could only ever be answering one it
	// learned about elsewhere.
	expect(watcher.permissionFrames()).toEqual([]);

	// Four refusals, four errors, on the sender's connection only.
	expect(phone.errors()).toHaveLength(3);
	expect(watcher.frames.filter((frame) => frame.type === "error")).toHaveLength(1);
	expect(bystander.errors()).toEqual([]);

	// ── THE POINT: after all four, the request is still the human's to answer ──
	phone.send({ type: "permission_response", clientId: "phone", requestId, optionId: "approve" });

	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
		"the valid answer to win after four refusals",
	);
	expect(resolved.decision).toBe("approved");
	expect(resolved.chosenOptionId).toBe("approve");
	expect(resolved.surface).toBe("attach");
	expect(resolved.clientId).toBe("phone");

	// The load-bearing one. The permission gate was parked on this ask for the whole sequence
	// above; the file exists only because the gate was released by an answer, and it is written by
	// the very bash call the refusals must not have decided.
	await until(
		() => existsSync(victim.marker),
		`the approved tool call to run (draht stderr: ${victim.stderr.text})`,
		60_000,
	);

	// ── the now-STALE valid answer: told it lost, by name ──
	//
	// A bare unknown-id refusal here reads exactly like a lost answer, and a phone that had its
	// reply dropped would have no way to tell the two apart. The tombstone is what makes the
	// second answer answerable-about.
	phone.send({ type: "permission_response", clientId: "phone", requestId, optionId: "approve" });
	const stale = await until(
		() => phone.frames.find((frame) => frame.type === "error" && frame.code === "PERMISSION_ALREADY_RESOLVED"),
		"the stale answer to be told it lost",
	);
	expect(String(stale.message)).toContain("already resolved");
	// NOT the unknown-id refusal the first case got.
	expect(stale.code).not.toBe("PERMISSION_UNKNOWN_REQUEST");

	// Said ONCE, on the wire and in the session file. A refusal that had also resolved would show
	// up here as a second echo or a second row.
	await Bun.sleep(250);
	expect(phone.resolutions(requestId)).toHaveLength(1);
	expect(bystander.resolutions(requestId)).toHaveLength(1);
	const rows = resolutionRows(agentDir, requestId);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.decision).toBe("approved");
	expect(rows[0]?.chosenOptionId).toBe("approve");
	expect(rows[0]?.decidedBy).toEqual({ surface: "attach", clientId: "phone" });
	// The immutable offered set, recorded as it was offered — `maybe` was never part of it.
	expect(rows[0]?.offeredOptionIds).toEqual(["approve", "deny"]);

	// ── and the OTHER session's ask, borrowed for case (3), is still answerable there ──
	//
	// This is the non-consumption proof for the cross-session case, and it is the same shape as the
	// one above: not "no resolution arrived" but "the real answer still works".
	otherPhone.send({
		type: "permission_response",
		clientId: "other-phone",
		requestId: foreignRequestId,
		optionId: "approve",
	});
	const otherResolved = await otherPhone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === foreignRequestId,
		"the other session's ask to still be answerable",
	);
	expect(otherResolved.decision).toBe("approved");
	await until(
		() => existsSync(other.marker),
		`the other session's approved tool call to run (draht stderr: ${other.stderr.text})`,
		60_000,
	);

	watcher.close();
	phone.close();
	bystander.close();
	otherPhone.close();
}, 240_000);
