/**
 * R34-PERM.4 — a hostile permission ask, neutralized on the REAL wire.
 *
 * The sibling file `permission-frame-wire.e2e.test.ts` proves the frames exist and
 * `permission-relay-roundtrip.e2e.test.ts` proves an answer decides a tool call. Neither of them
 * ever put a hostile string on the wire: the only long command anywhere in this phase's evidence
 * is 600 literal `f` characters (packages/coding-agent/test/permission-detail-rpc.e2e.test.ts),
 * which proves BOUNDING and says nothing whatsoever about control characters, bidi overrides, or
 * fabricated rows. This file drives one.
 *
 * FOUR ATTACKS, one string, one real tool call:
 *
 *   A. TAIL ELISION — a shell command's decision-relevant content is its TAIL (`&& …`, `| sh`, a
 *      redirection). Head-truncation deletes exactly the part the human is deciding about.
 *   B. BIDI REVERSAL — U+202E costs ZERO display width in this codebase, so no width budget can
 *      price it out, and an unterminated override run stays live over everything appended after it.
 *   C. ESCAPE EXECUTION / ROW FABRICATION — a raw `ESC[2J` clears the operator's screen; a raw
 *      `\r\n  Yes` fabricates a row that looks exactly like the genuine option list.
 *   D. UNBOUNDED LENGTH — 5000 characters, which measured 76 rendered rows with the genuine `Yes`
 *      at index 70.
 *
 * Plus the one the byte bound exists for: a ZALGO witness — 512 grapheme clusters carrying dozens
 * of combining marks each. A grapheme budget alone bounds nothing, because ONE cluster admits
 * unboundedly many marks; that witness weighed 383,246 bytes before the producer bounded bytes too,
 * and the attach bridge answered it by dropping the renderer with close 1008. It is asserted here
 * as what it is — a frame that fits.
 *
 * EVIDENCE CLASS 3. Every assertion below is made on the bytes of a frame that crossed a real
 * `WebSocket` into a real daemon process from a real emitted binary. Nothing here imports
 * `safe-text.ts`, calls `boundedSafeText`, or constructs an `AttachBridge` — the forbidden-range
 * table is HAND-COPIED below precisely so that a test asserting neutralization cannot be satisfied
 * by the same table it is meant to be checking. A package-level test that imported the producer
 * would keep passing with the producer wired to nothing.
 *
 * Harness hygiene, every item paid for by a probe that passed while proving nothing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from both child environments. This repo's interactive shell
 *    exports `auto`, under which the scripted call is auto-allowed and NO ask is raised at all.
 *  - The agent dir sits directly under /tmp with a short name: a Unix socket path over ~104 bytes
 *    fails to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed, so "it
 *    exists" says nothing about whether it matches this tree.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "permission-safe-text-e2e-token";

/**
 * The transport's own per-frame cap, restated here rather than imported.
 *
 * A permission frame has NO chunking path — `#fit` in the attach bridge splits `output` and
 * nothing else — so a permission frame over this size is not delivered in halves, it drops the
 * renderer's connection with close 1008. That is the failure the byte bound exists to prevent.
 */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * The code points a rendered permission field may never contain — HAND-MIRRORED, not imported.
 *
 * This is the whole point of the file: if the test asked `isNeutralized()` whether the producer had
 * neutralized the string, both sides would be the same table and the test would assert nothing. The
 * eight ranges the requirement names (C0, DEL, C1, and the bidi/invisible formatting characters)
 * are all here; the rest are the producer's additional hardening, which this table also holds so a
 * silent narrowing of the producer's table is caught.
 */
const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
	[0x0000, 0x001f], // C0 controls — TAB, LF, CR, ESC
	[0x007f, 0x007f], // DEL
	[0x0080, 0x009f], // C1 controls — including CSI at U+009B
	[0x00ad, 0x00ad], // SOFT HYPHEN
	[0x061c, 0x061c], // ARABIC LETTER MARK
	[0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ
	[0x200e, 0x200f], // LRM, RLM
	[0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
	[0x2060, 0x2060], // WORD JOINER
	[0x2066, 0x2069], // LRI, RLI, FSI, PDI
	[0xfe00, 0xfe0f], // variation selectors
	[0xfeff, 0xfeff], // ZWNBSP / BOM
	[0xfff9, 0xfffb], // interlinear annotation
	[0xe0000, 0xe007f], // tag characters
];

/** Every offending code point in `value`, as `U+XXXX@index` — so a failure names the character. */
function offenders(value: string): string[] {
	const found: string[] = [];
	let index = 0;
	for (const ch of value) {
		const cp = ch.codePointAt(0) as number;
		for (const [start, end] of FORBIDDEN_RANGES) {
			if (cp >= start && cp <= end) {
				found.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}@${index}`);
				break;
			}
		}
		index += ch.length;
	}
	return found;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function graphemeCount(value: string): number {
	let count = 0;
	for (const _ of segmenter.segment(value)) count++;
	return count;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/**
 * The elision marker the producer writes, parsed back out.
 *
 * A bare `…` cannot distinguish three elided characters from four thousand characters of padding,
 * so the marker names a NUMBER and this is what reads it. The count plus the rendered length is how
 * a surface recovers the original length — see the note on `truncated` in the first test.
 */
function elidedCount(value: string): number | null {
	const match = /…\[(\d+) chars elided\]…/.exec(value);
	return match === null ? null : Number(match[1]);
}

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

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	cwd: string;
	stderr: { text: string };
	/** The session's OWN Unix socket — what `draht --attach` speaks, with no daemon in between. */
	socketPath: string;
}

/**
 * Start the emitted binary as an attachable session with ONE scripted tool call queued.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print mode and the
 * process answers once and exits before anything can attach. Nothing reads the child's stdout, so
 * the local RPC surface never answers and the ask stays up for the phone.
 */
async function startDrahtSession(toolCall: {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}): Promise<DrahtSession> {
	const cwd = realpathSync(tempDir("pst-c-"));
	const script = JSON.stringify([{ toolCalls: [toolCall] }]);
	const stderr = { text: "" };

	// Built from scratch, not inherited: this repo's shell exports DRAHT_PERMISSION_MODE=auto, and
	// a permission test run under it passes while raising no prompt at all.
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

	return { proc, id: id.slice(0, -".sock".length), cwd, stderr, socketPath: join(socketDir, id) };
}

function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

/** One renderer, driven exactly as a phone would drive it — keeping the RAW bytes of every frame. */
class Renderer {
	readonly frames: { raw: string; frame: Record<string, unknown> }[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			// The raw text is kept because half of what this file asserts is a SIZE. Re-encoding the
			// parsed object would measure this test's `JSON.stringify`, not the daemon's.
			const raw = String(event.data);
			this.frames.push({ raw, frame: JSON.parse(raw) as Record<string, unknown> });
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

	async waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		what: string,
		timeoutMs = 30_000,
	): Promise<{ raw: string; frame: Record<string, unknown> }> {
		return until(
			() => this.frames.find((entry) => predicate(entry.frame)),
			`${what} (saw: ${this.frames.map((entry) => String(entry.frame.type)).join(", ")})`,
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
 * One client speaking the SESSION'S OWN socket protocol, with nothing in between.
 *
 * This is the surface geist-protocol does not cover. `draht --attach` connects straight to the
 * published `.sock`, parses each line with a bare `JSON.parse(line) as ServerMessage` cast
 * (socket-client.ts), and writes session bytes straight to the operator's TTY — no zod schema, no
 * `.refine()`, no bridge. If neutralization lived at the protocol layer rather than at
 * construction, THIS client would still be handed a raw `ESC[2J`.
 *
 * It matters for a second reason the mutation log records: with the producer's bidi range removed,
 * the gateway path fails by TIMEOUT, because the wire schema refuses the frame and the ask never
 * reaches the phone at all. On this path there is no schema to refuse it, so the assertion that
 * fires is the one about the CHARACTERS — which is the property the requirement is about.
 */
class RawClient {
	readonly frames: { raw: string; frame: Record<string, unknown> }[] = [];
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
					this.frames.push({ raw: part, frame: JSON.parse(part) as Record<string, unknown> });
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

	send(frame: unknown): void {
		this.#socket.write(`${JSON.stringify(frame)}\n`);
	}

	waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		what: string,
		timeoutMs = 30_000,
	): Promise<{ raw: string; frame: Record<string, unknown> }> {
		return until(
			() => this.frames.find((entry) => predicate(entry.frame)),
			`${what} (saw: ${this.frames.map((entry) => String(entry.frame.type)).join(", ")})`,
			timeoutMs,
		);
	}

	close(): void {
		this.#socket.end();
	}
}

let agentDir: string;
let home: string;
let base: string;

beforeAll(async () => {
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("pst-a-");
	home = tempDir("pst-h-");

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

/** Handshake at the current member and attach read-write to a live session. */
async function attachedTo(sessionId: string, clientId: string): Promise<Renderer> {
	const renderer = await Renderer.open();
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-safe-text-e2e", version: "0.0.0" },
	});
	await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	renderer.send({ type: "attach", sessionId, clientId, mode: "read-write" });
	await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
	return renderer;
}

// ── the hostile payloads ────────────────────────────────────────────────────

/** `ESC[2J ESC[H` — clear the screen and home the cursor. Raw, it EXECUTES on a TTY. */
const CLEAR_SCREEN = "[2J[H";
/** A fabricated option list: two CRLF-separated rows that mimic the genuine `Yes` / `No`. */
const FAKE_OPTIONS = "\r\n  Yes\r\n  No\r\n";
/** RIGHT-TO-LEFT OVERRIDE, unterminated — zero display width, and live over everything after it. */
const RLO = "‮";
/**
 * The weld witness. If a neutralizer DELETES the newline instead of replacing it, `rm -r` and
 * `f /` become the single token `rm -rf /` — the displayed string stops matching the executed one
 * and nothing is left behind to say so. This is the assertion the "never delete" rule exists for.
 */
const WELD_LEFT = "rm -r";
const WELD_RIGHT = "f /";
/** U+240A SYMBOL FOR LINE FEED — what LF must become: exactly one visible code point, in place. */
const LF_PICTURE = "␊";
const DECISIVE = "DECISIVE-TAIL-MARKER";

test("a bash command carrying RLO, ESC, CR and 5000 characters arrives neutralized, tail-first, in one frame", async () => {
	const filler = "f".repeat(5000);
	const command = `${CLEAR_SCREEN}echo start${FAKE_OPTIONS}${RLO}${WELD_LEFT}\n${WELD_RIGHT} ${filler} && echo ${DECISIVE}`;
	// The witness really does carry all four attacks before it is sent.
	expect(command).toContain("");
	expect(command).toContain("\r");
	expect(command).toContain(RLO);
	expect(command.length).toBeGreaterThan(5000);

	const session = await startDrahtSession({ id: "call-1", name: "bash", arguments: { command } });
	const phone = await attachedTo(session.id, "phone");
	phone.send({ type: "input", data: "run the scripted tool", clientId: "phone" });

	const { raw, frame: ask } = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask (draht stderr: ${session.stderr.text})`,
		90_000,
	);
	expect(ask.toolName).toBe("bash");
	const wire = ask.command as string;
	expect(typeof wire).toBe("string");

	// ── C. no escape, no control character, no bidi override survived ──
	//
	// This is asserted against the hand-copied table above, over the frame's OWN field. A raw
	// `ESC[2J` here would clear the operator's terminal in `draht --attach`, which writes
	// session bytes straight to the TTY and parses this wire with a bare `JSON.parse` cast.
	expect(offenders(wire)).toEqual([]);
	// And the neutralization is one-for-one and VISIBLE, not a silent scrub: the LF that was
	// between `rm -r` and `f /` is present as its Control Pictures glyph.
	expect(wire).toContain(`${WELD_LEFT}${LF_PICTURE}${WELD_RIGHT}`);

	// ── the weld: NOTHING was deleted ──
	//
	// The single most dangerous outcome of a "sanitizer" is a shorter, more dangerous string.
	expect(wire).not.toContain("rm -rf /");

	// ── A. the decisive TAIL survived the bound ──
	expect(wire).toContain(DECISIVE);
	expect(wire.endsWith(DECISIVE)).toBe(true);
	// …and the head is still there too, so the elision really was in the MIDDLE. A surface that
	// showed only the tail would hide the `ESC[2J` the operator most needs to see neutralized.
	expect(wire).toContain("echo start");

	// ── D. the length is bounded, and the bound ANNOUNCES ITSELF WITH A NUMBER ──
	const elided = elidedCount(wire);
	expect(elided, `no numeric elision marker in: ${JSON.stringify(wire.slice(0, 400))}`).not.toBeNull();
	expect(elided as number).toBeGreaterThan(4000);
	// The marker is the evidence of the original length: rendered + elided recovers it, which a
	// bare `…` could not. The rendered field is far shorter than what the model asked for.
	const rendered = graphemeCount(wire);
	expect(rendered).toBeLessThan(600);
	expect(rendered + (elided as number)).toBeGreaterThan(5000);

	// ── D′. THE FRAME SAYS SO. The flag a surface reads, on a string 4,572 characters short ──
	//
	// This line spent a phase asserting `false` with a paragraph explaining why that was correct.
	// It was not correct: it pinned a defect as the requirement's answer. R34-PERM.4 asks that a
	// surface be able to say a decision is being made on an abbreviated string, and `truncated` is
	// the only field that says it — the marker above is inside free text a renderer may show
	// verbatim but cannot be asked to parse before deciding whether to warn.
	//
	// THE MUTATION THIS LINE DIES AGAINST: restore the `.value`-only discard in `safeField`
	// (packages/coding-agent/src/core/builtins/subagent.ts) — i.e. drop `BoundedText.truncated` on
	// the floor again — and this expects `true` and gets `false`. Nothing else in this file moves:
	// every other assertion here passes with the defect in place, which is exactly how it survived.
	// The seed in `buildRequestFrame` (permission-relay.ts) is the other half; deleting `detail?.
	// truncated === true` from its initialiser fails this line the same way, because the relay's own
	// 4000-grapheme bound never binds on text the producer already cut to ~530.
	//
	// `originalLength` IS NOT ASSERTED, and not by omission: `PermissionRequestFrameSchema`
	// (packages/geist-protocol/src/wire.ts) declares no such field, so there is no wire for it to
	// arrive on. Asserting it would require a protocol change; the elision marker's number is what
	// recovers the original length today, which is what the `rendered + elided` line above does.
	expect(ask.truncated).toBe(true);

	// ── the frame fits, and it arrived WHOLE ──
	//
	// A permission frame has no chunking path, so "too big" is not "arrives in two parts", it is
	// "the renderer is dropped with close 1008".
	expect(utf8Bytes(raw)).toBeLessThan(MAX_FRAME_BYTES);
	const asks = phone.frames.filter(
		(entry) => entry.frame.type === "permission_request" && entry.frame.requestId === ask.requestId,
	);
	expect(asks).toHaveLength(1);
	expect(phone.closed).toBeNull();

	// The ask is real and still answerable — a frame nobody could answer would make every
	// assertion above a statement about a dead dialog.
	phone.send({ type: "permission_response", clientId: "phone", requestId: ask.requestId, optionId: "deny" });
	const resolved = await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === ask.requestId,
		"the resolution",
	);
	expect(resolved.frame.decision).toBe("denied");
	phone.close();
}, 180_000);

test("a SHORT benign command arrives verbatim and says `truncated: false` — the flag is not a constant", async () => {
	// THE OTHER HALF OF THE FIX, and the reason it is a separate test rather than a second
	// assertion. `truncated` is a boolean, so the cheapest way to make the hostile test above pass
	// is to hard-code `true` — in `safeField`, in `buildRequestFrame`'s initialiser, or by ORing in
	// something that is always set. Every such "fix" makes a surface warn "you are approving an
	// abbreviated command" on `echo hello`, which trains the operator to ignore the warning and
	// costs the requirement everything it was for. This test is what refuses them.
	//
	// It runs the same producer, the same relay and the same wire as the hostile case; the ONLY
	// difference is the length of the string. Under default permission mode an unmatched bash call
	// requires approval (permission-gate.ts `defaultDecision`), so a 22-character `echo` is a real
	// ask with a real frame.
	const command = "echo BENIGN-SHORT-OK";
	expect(command.length).toBeLessThan(100);

	const session = await startDrahtSession({ id: "call-5", name: "bash", arguments: { command } });
	const phone = await attachedTo(session.id, "phone-5");
	phone.send({ type: "input", data: "run the benign tool", clientId: "phone-5" });

	const { frame: ask } = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask for the benign command (draht stderr: ${session.stderr.text})`,
		90_000,
	);
	expect(ask.toolName).toBe("bash");
	const wire = ask.command as string;

	// Nothing was elided, so nothing announces an elision: the string is byte-identical to what the
	// model asked for, and carries no marker.
	expect(wire).toBe(command);
	expect(elidedCount(wire)).toBeNull();

	// …and the flag agrees. This is the assertion that dies against a hard-coded `true`.
	expect(ask.truncated).toBe(false);

	// The other fields of the same frame are short too, so no field of this ask contributes a
	// verdict — a producer that ORed in, say, an id clamp on every ask would fail here.
	expect(offenders(wire)).toEqual([]);
	for (const field of ["toolName", "cwd", "title", "message"] as const) {
		expect(elidedCount(String(ask[field])), `${field} was elided: ${JSON.stringify(ask[field])}`).toBeNull();
	}

	phone.send({ type: "permission_response", clientId: "phone-5", requestId: ask.requestId, optionId: "deny" });
	await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === ask.requestId,
		"the resolution",
	);
	expect(phone.closed).toBeNull();
	phone.close();
}, 180_000);

test("the same rule holds on a second field: a hostile path on a read outside the project", async () => {
	// Absolute, so the gate's `isWithinProject` says no and the call needs approval; the hostile
	// content rides in the last segment. `read` takes `path`, and the ask carries it as `path` —
	// a different wire field, bounded by a different budget, from a different branch of the
	// detail builder. One field proved is one field proved.
	const filler = "p".repeat(5000);
	const path = `/etc/${CLEAR_SCREEN}${FAKE_OPTIONS}${RLO}${WELD_LEFT}\n${WELD_RIGHT}/${filler}/${DECISIVE}.txt`;

	const session = await startDrahtSession({ id: "call-2", name: "read", arguments: { path } });
	const phone = await attachedTo(session.id, "phone-2");
	phone.send({ type: "input", data: "read the scripted path", clientId: "phone-2" });

	const { raw, frame: ask } = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask for read (draht stderr: ${session.stderr.text})`,
		90_000,
	);
	expect(ask.toolName).toBe("read");
	const wire = ask.path as string;
	expect(typeof wire, `no path on the ask: ${JSON.stringify(ask)}`).toBe("string");

	expect(offenders(wire)).toEqual([]);
	expect(wire).toContain(`${WELD_LEFT}${LF_PICTURE}${WELD_RIGHT}`);
	expect(wire).not.toContain("rm -rf /");
	// The decisive part of a path is also its tail — the filename being read.
	expect(wire.endsWith(`${DECISIVE}.txt`)).toBe(true);
	expect(elidedCount(wire)).not.toBeNull();
	// The flag travels for the `path` branch of the detail builder too — it is a different `if`
	// arm, and a fix that only threaded the verdict out of the `command` arm would pass the first
	// test and fail here.
	expect(ask.truncated).toBe(true);
	expect(graphemeCount(wire)).toBeLessThan(600);
	expect(utf8Bytes(raw)).toBeLessThan(MAX_FRAME_BYTES);

	// Every OTHER field of the same frame is held to the same rule — the neutralizer is not a
	// special case for whichever field a test happened to look at.
	for (const field of ["toolName", "cwd", "title", "message"] as const) {
		expect(offenders(String(ask[field])), `${field}: ${JSON.stringify(ask[field])}`).toEqual([]);
	}
	for (const option of ask.options as { id: string; label: string }[]) {
		expect(offenders(option.label)).toEqual([]);
	}

	phone.send({ type: "permission_response", clientId: "phone-2", requestId: ask.requestId, optionId: "deny" });
	await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === ask.requestId,
		"the resolution",
	);
	expect(phone.closed).toBeNull();
	phone.close();
}, 180_000);

test("a Zalgo witness — 512 clusters, dozens of marks each — fits the frame instead of dropping the renderer", async () => {
	// THE CASE THE BYTE BOUND EXISTS FOR, kept above the wire cap and below Linux's per-environment-entry ceiling.
	//
	// A grapheme budget alone bounds nothing: one cluster admits unboundedly many combining marks.
	// U+0334 does not compose under NFC, so 512 clusters of 100 marks each stay 512 clusters —
	// inside every grapheme budget on this wire — while weighing over 100 KB. That is enough to
	// exceed the 64 KiB frame cap without making the environment variable that configures the
	// spawned stub itself unspawnable on Linux.
	const cluster = `x${"̴".repeat(100)}`;
	const command = `${cluster.repeat(512)} && echo ${DECISIVE}`;
	expect(graphemeCount(command)).toBeGreaterThan(500);
	expect(utf8Bytes(command)).toBeGreaterThan(100_000);

	const session = await startDrahtSession({ id: "call-3", name: "bash", arguments: { command } });
	const phone = await attachedTo(session.id, "phone-3");
	phone.send({ type: "input", data: "run the zalgo tool", clientId: "phone-3" });

	const { raw, frame: ask } = await phone.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask for the zalgo witness (draht stderr: ${session.stderr.text})`,
		90_000,
	);
	const wire = ask.command as string;

	// The renderer is still attached — the whole point. A frame over the cap does not arrive
	// truncated, it arrives never, and takes the connection with it.
	expect(phone.closed).toBeNull();
	expect(utf8Bytes(raw)).toBeLessThan(MAX_FRAME_BYTES);
	// The field itself is bounded in BYTES, well under what its grapheme budget alone would
	// have allowed: 4000 clusters of this shape is 324 KB.
	expect(utf8Bytes(wire)).toBeLessThan(4096);
	expect(graphemeCount(wire)).toBeLessThan(600);
	// Bounded, and it says so with a number rather than dropping the excess in silence.
	expect(elidedCount(wire)).not.toBeNull();
	// …and with the flag. This witness is inside EVERY grapheme budget on the wire — 512 clusters
	// against `command`'s 4000 — so the relay's own bound could never discover this elision no
	// matter how it were ordered. Only the producer's carried verdict can report it.
	expect(ask.truncated).toBe(true);
	// Still the tail, still no offenders — bounding by bytes did not switch off the rest.
	expect(wire.endsWith(DECISIVE)).toBe(true);
	expect(offenders(wire)).toEqual([]);

	phone.send({ type: "permission_response", clientId: "phone-3", requestId: ask.requestId, optionId: "deny" });
	await phone.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === ask.requestId,
		"the resolution",
	);
	phone.close();
}, 180_000);

test("the surface with NO schema in front of it — `draht --attach` — is handed the same neutralized text", async () => {
	// WHY THIS TEST EXISTS SEPARATELY. Reading R34-PERM.4's "protocol layer" as geist-protocol
	// alone leaves this client unprotected: it connects straight to the published `.sock` and
	// parses every line with a bare `JSON.parse(line) as ServerMessage` cast, then writes what it
	// gets to a TTY. A raw `ESC[2J` there clears the operator's screen. Nothing between the
	// producer and this socket can save it, so this is where "neutralized at CONSTRUCTION" is
	// actually load-bearing rather than merely true.
	//
	// Measured, not assumed: with the producer's bidi range deleted, the gateway test above fails
	// by TIMEOUT — `wire.ts`'s `.refine()` refuses the frame and the phone is never shown the ask.
	// A suite containing only that test would report a producer regression as a hang.
	const filler = "z".repeat(5000);
	const command = `${CLEAR_SCREEN}echo start${FAKE_OPTIONS}${RLO}${WELD_LEFT}\n${WELD_RIGHT} ${filler} && echo ${DECISIVE}`;

	const session = await startDrahtSession({ id: "call-4", name: "bash", arguments: { command } });
	const attach = await RawClient.open(session.socketPath);
	// Exactly what the attach client declares: read-write, and the capability that gates emission.
	attach.send({ type: "attach", clientId: "attach-cli", mode: "read-write", capabilities: ["permission-relay"] });
	await attach.waitFor((frame) => frame.type === "session_metadata", "session_metadata on the raw socket");
	attach.send({ type: "input", data: "run the scripted tool", clientId: "attach-cli" });

	const { raw, frame: ask } = await attach.waitFor(
		(frame) => frame.type === "permission_request",
		`the permission ask on the raw socket (draht stderr: ${session.stderr.text})`,
		90_000,
	);
	const wire = ask.command as string;

	expect(offenders(wire)).toEqual([]);
	expect(wire).toContain(`${WELD_LEFT}${LF_PICTURE}${WELD_RIGHT}`);
	expect(wire).not.toContain("rm -rf /");
	expect(wire.endsWith(DECISIVE)).toBe(true);
	expect(elidedCount(wire)).not.toBeNull();
	// The bare-`JSON.parse` client is told about the abbreviation too. Nothing between the producer
	// and this socket could have added the flag, so this is the producer's verdict or nothing.
	expect(ask.truncated).toBe(true);
	expect(graphemeCount(wire)).toBeLessThan(600);
	// The session's own socket has the same 64 KiB frame budget on the far side of the bridge,
	// and this line is what it costs.
	expect(utf8Bytes(raw)).toBeLessThan(MAX_FRAME_BYTES);

	attach.send({
		type: "permission_response",
		clientId: "attach-cli",
		requestId: ask.requestId,
		optionId: "deny",
	});
	await attach.waitFor(
		(frame) => frame.type === "permission_resolved" && frame.requestId === ask.requestId,
		"the resolution on the raw socket",
	);
	attach.close();
}, 180_000);
