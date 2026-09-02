/**
 * R34-PERM.7 — the enumeration regression: every execution that raises a LOCAL permission prompt
 * raises a REMOTE one over the attach wire.
 *
 * ─── WHAT THE REQUIREMENT SAYS, AND THE TWO WAYS IT IS BROKEN AS WRITTEN ────────────────────────
 *
 * (a) IT IS VACUOUS UNLESS A PROMPT IS ACTUALLY RAISED. Under `DRAHT_PERMISSION_MODE=default` with
 *     no answering surface, draht raises no prompt at all — the gate hard-blocks at
 *     `packages/coding-agent/src/core/builtins/subagent.ts` with "(no UI available to request
 *     approval)". "Every execution that raises a local prompt" then enumerates the EMPTY SET and a
 *     green suite proves nothing. This file therefore always attaches a real client first, so a
 *     surface exists, and every assertion below is about an OBSERVED FRAME.
 *
 * (b) THE SUBAGENT LEG IS UNSATISFIABLE AND IS NOT ATTEMPTED. A subagent is a separate
 *     `draht --mode json -p --no-session` child process (subagent.ts `runAgent`, spawned with no
 *     `env` override, no socket, no UI and no channel back to the parent's relay). A tool call
 *     raised INSIDE that child can reach no surface anywhere: it hard-blocks in the child and the
 *     parent never learns an ask existed. Nothing in this file asserts that a subagent's inner
 *     tool call is relayed, because nothing could make it true — it is a product gap awaiting a
 *     scope ruling, escalated in the phase plan, not something a test can close. The `subagent`
 *     row below covers only the OUTER call, which is `allow` by default and must therefore raise
 *     nothing.
 *
 * ─── THE ORACLE ────────────────────────────────────────────────────────────────────────────────
 *
 * Never `PermissionGate.evaluate`. Computing the expectation from the gate asserts the gate against
 * itself: it would keep passing with the relay unwired, the decorator uninstalled, or the gate
 * itself detached from the tool loop. The expectation here is a LITERAL TABLE (`VECTORS`), measured
 * by running the shipped binary, and the observation is a `permission_request` frame arriving — or
 * provably not arriving — on a real WebSocket.
 *
 * ─── WHY ONE CANNED ARGUMENT PER TOOL WOULD ASSERT NOTHING ─────────────────────────────────────
 *
 * The gate is ARGUMENT-DEPENDENT, not metadata-dependent. Measured under shipped defaults (mode
 * `default`, no permissions.yml, cwd = a fresh temp project):
 *
 *   bash      → approve on EVERY call; there is no allow-vector at all.
 *   read      → allow inside the project, approve for a path outside it (or missing).
 *   write     → same.
 *   edit      → same.
 *   hello     → approve on EVERY call: an extension tool matches no rule and the catch-all in
 *               permission-gate.ts defaults unknown tools to `approve`. True under `default` AND
 *               `auto`, which is exactly the case R34-PERM.7 names.
 *   subagent  → allow on EVERY call; it is in `DEFAULT_ALLOWED_TOOLS`.
 *
 * So each row carries an APPROVE-VECTOR and, where one exists, an ALLOW-VECTOR, and both are
 * driven. A table with one argument per tool would silently assert nothing for four of the six
 * reachable tools.
 *
 * ─── WHERE THE LIST COMES FROM ─────────────────────────────────────────────────────────────────
 *
 * From INSIDE the running binary. No public protocol enumerates the tool registry — the RPC command
 * set has no `get_tools` and the CLI has no `--list-tools` — so `fixtures/permission-probe-extension.ts`
 * is loaded with `-e` and prints `pi.getAllTools()` / `pi.getActiveTools()` on stderr. The
 * completeness test fails if any tool the binary reports has no row here, which is the enumeration's
 * teeth: a tool added tomorrow cannot slip past.
 *
 * ─── THE NEGATIVE CONTROL: "IT RAN" COUNTS ONLY IF WITHHOLDING THE ANSWER STOPS IT ────────────
 *
 * Every approve test below ANSWERS. Answering alone cannot tell "the call ran because a remote
 * client approved it" from "the call ran regardless" — and it did not tell them apart: a
 * `setTimeout(…, 0)` added to `raise()` in `permission-relay.ts`, self-resolving every ask as
 * approved with nobody answering, left all five approve tests GREEN. `expect(resolved.decision)
 * .toBe("approved")` does not catch it either, because `withdraw` broadcasts whatever outcome
 * settled the ask, including a fabricated one.
 *
 * So the answer is WITHHELD in a control: the ask is raised and never answered, and for
 * {@link UNANSWERED_WINDOW_MS} nothing may appear — no tool result in the session's own transcript,
 * no marker file, and no `permission_resolved` frame for that ask.
 *
 * A settle window is worth exactly as much as the argument that it was long enough, so this one is
 * not asserted, it is MEASURED — in the same session, on the same call. When the window is over the
 * control finally answers `approve` and times how long that identical call then needs to record its
 * result. The window must exceed that by {@link WINDOW_SAFETY_FACTOR}, or the test fails and says
 * to raise it. "Nothing ran" therefore cannot degrade into "had not run yet": the same pipeline, on
 * this machine, in this session, needed under a {@link WINDOW_SAFETY_FACTOR}th of the window to
 * produce a result once it was allowed to.
 *
 * `DRAHT_PERMISSION_EXPIRY_MS` is set to {@link CONTROL_EXPIRY_MS} rather than to something tiny. A
 * tiny expiry would settle the ask INSIDE the window, and the control would then be asserting that
 * an expiry fails closed — which is T8's claim in `permission-durability.e2e.test.ts`, not this
 * one. What it buys here is a bounded life for an ask this test might abandon, and a frame whose
 * own `deadline` can be checked to land beyond the window: neither clock that can end an ask — the
 * registry's timer, or a timeout the decorator declared — may fire while the control is watching.
 *
 * ─── HARNESS HYGIENE, EACH ITEM PAID FOR BY A PROBE THAT PASSED WHILE PROVING NOTHING ──────────
 *
 *  - `DRAHT_PERMISSION_MODE` is DELETED from every child env. This repo's interactive shell exports
 *    `auto`, under which `bash` is auto-allowed and the danger filter decides; `yolo` downgrades
 *    every approve to allow and raises ZERO prompts.
 *  - Agent dirs sit directly under /tmp with short names: a Unix socket path over ~104 bytes fails
 *    to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  - `dist/cli.js` is rebuilt first. The artifact under test is emitted, not committed.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { GEIST_PROTOCOL_FAMILY, GEIST_PROTOCOL_VERSION } from "@draht/geist-protocol";
import { PROBE_PREFIX } from "./fixtures/permission-probe-extension";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const HELLO_EXTENSION = join(REPO_ROOT, "packages", "coding-agent", "examples", "extensions", "hello.ts");
const PROBE_EXTENSION = join(import.meta.dir, "fixtures", "permission-probe-extension.ts");
const TOKEN = "permission-enumeration-e2e-token";
/** The id every scripted tool call carries, so an ask can be matched to the call that raised it. */
const CALL_ID = "call-1";

/**
 * How long an ask nobody answers is watched before the control concludes that nothing ran.
 *
 * Not a guess that has to hold on every machine: the same test measures the answered latency of the
 * same call and fails if this window is no longer {@link WINDOW_SAFETY_FACTOR} times it.
 */
const UNANSWERED_WINDOW_MS = 6_000;

/**
 * How many times the measured answered latency the window must be.
 *
 * At 3, a control that passes has watched for three times as long as the very same call demonstrably
 * needed once approved — so a pass means "an answer is required", not "the machine was busy".
 */
const WINDOW_SAFETY_FACTOR = 3;

/**
 * The expiry the control runs its session with — a CEILING, not a stopwatch. See the header: it is
 * deliberately far larger than the window, because an ask that expires mid-window would settle
 * itself and turn this control into a (differently owned) expiry test.
 */
const CONTROL_EXPIRY_MS = 60_000;

// ─── The literal table ─────────────────────────────────────────────────────────────────────────

/** Absolute paths a vector is written against: one inside the project, one deliberately outside it. */
interface Paths {
	/** The session's cwd — the "project" the gate scopes paths to. Already realpath'd. */
	inside: string;
	/** A directory that is NOT under `inside`. Already realpath'd. */
	outside: string;
}

/** One scripted execution, plus everything that must be true about it. */
interface Vector {
	/** Files to write before the turn starts. */
	seed?: (paths: Paths) => Record<string, string>;
	/** The tool call the stub provider is scripted to emit. */
	call: (paths: Paths) => { name: string; arguments: Record<string, unknown> };
	/**
	 * The canonical detail field the ask must carry, for approve-vectors only.
	 *
	 * The gate sends `command` when the input has one, `path` when it has a path, and a serialized
	 * `operation` otherwise — so an extension tool taking neither still shows the human something.
	 */
	detail?: (paths: Paths) => { field: "command" | "path" | "operation"; value: string };
	/** A file that exists ONLY if the call was let through. */
	marker?: (paths: Paths) => string;
	/** Text the tool's own recorded result must contain if the call was let through. */
	resultContains?: (paths: Paths) => string;
}

interface Row {
	tool: string;
	/**
	 * Arguments that MUST raise a prompt, or `null` with a stated reason when no such arguments
	 * exist for this tool under shipped defaults.
	 */
	approve: Vector | null;
	/** Arguments that must NOT raise a prompt, or `null` when every call of this tool prompts. */
	allow: Vector | null;
	/**
	 * Set for a tool that is in the registry but not in the default ACTIVE set, so no execution can
	 * reach it — the executor answers "Tool <name> not found" before the permission gate is ever
	 * consulted. Such a row has no vectors; the completeness test asserts the tool really is
	 * inactive, so activating it tomorrow fails here until a real vector is written.
	 */
	unreachable?: true;
	/** Why a `null` vector or an `unreachable` row is correct rather than an omission. */
	note: string;
}

const VECTORS: Row[] = [
	{
		tool: "bash",
		approve: {
			call: (p) => ({ name: "bash", arguments: { command: `echo approved > ${join(p.inside, "bash-ran.txt")}` } }),
			detail: (p) => ({ field: "command", value: `echo approved > ${join(p.inside, "bash-ran.txt")}` }),
			marker: (p) => join(p.inside, "bash-ran.txt"),
		},
		allow: null,
		note: "Under mode `default` every bash call requires approval, so there is no allow-vector. (Only `auto` allows one, via the danger filter — a different mode, deliberately not exercised here.)",
	},
	{
		tool: "read",
		approve: {
			seed: (p) => ({ [join(p.outside, "outside-read.txt")]: "T11-READ-OUTSIDE\n" }),
			call: (p) => ({ name: "read", arguments: { path: join(p.outside, "outside-read.txt") } }),
			detail: (p) => ({ field: "path", value: join(p.outside, "outside-read.txt") }),
			resultContains: () => "T11-READ-OUTSIDE",
		},
		allow: {
			seed: (p) => ({ [join(p.inside, "inside-read.txt")]: "T11-READ-INSIDE\n" }),
			call: (p) => ({ name: "read", arguments: { path: join(p.inside, "inside-read.txt") } }),
			resultContains: () => "T11-READ-INSIDE",
		},
		note: "Path-scoped: inside the project is allowed, outside requires approval.",
	},
	{
		tool: "write",
		approve: {
			call: (p) => ({
				name: "write",
				arguments: { path: join(p.outside, "outside-write.txt"), content: "T11-WRITE-OUTSIDE" },
			}),
			detail: (p) => ({ field: "path", value: join(p.outside, "outside-write.txt") }),
			marker: (p) => join(p.outside, "outside-write.txt"),
		},
		allow: {
			call: (p) => ({
				name: "write",
				arguments: { path: join(p.inside, "inside-write.txt"), content: "T11-WRITE-INSIDE" },
			}),
			marker: (p) => join(p.inside, "inside-write.txt"),
		},
		note: "Path-scoped, same as read.",
	},
	{
		tool: "edit",
		approve: {
			seed: (p) => ({ [join(p.outside, "outside-edit.txt")]: "before\n" }),
			call: (p) => ({
				name: "edit",
				arguments: { path: join(p.outside, "outside-edit.txt"), oldText: "before", newText: "T11-EDIT-OUTSIDE" },
			}),
			detail: (p) => ({ field: "path", value: join(p.outside, "outside-edit.txt") }),
			resultContains: () => "Successfully replaced",
		},
		allow: {
			seed: (p) => ({ [join(p.inside, "inside-edit.txt")]: "before\n" }),
			call: (p) => ({
				name: "edit",
				arguments: { path: join(p.inside, "inside-edit.txt"), oldText: "before", newText: "T11-EDIT-INSIDE" },
			}),
			resultContains: () => "Successfully replaced",
		},
		note: "Path-scoped, same as read.",
	},
	{
		tool: "hello",
		approve: {
			call: () => ({ name: "hello", arguments: { name: "T11" } }),
			// Neither `command` nor `path`: the gate serializes the whole argument object instead of
			// asking a human to approve an unnamed action.
			detail: () => ({ field: "operation", value: JSON.stringify({ name: "T11" }) }),
			resultContains: () => "Hello, T11!",
		},
		allow: null,
		note: "The extension-provided tool R34-PERM.7 names. No rule can match it, so the catch-all defaults it to `approve` on EVERY call — under `default` and under `auto` alike. There is no allow-vector.",
	},
	{
		tool: "subagent",
		approve: null,
		allow: {
			call: () => ({
				name: "subagent",
				arguments: { agent: "reviewer", task: "Say T11-SUBAGENT-RAN and nothing else." },
			}),
			resultContains: () => "T11-SUBAGENT-RAN",
		},
		note: "In DEFAULT_ALLOWED_TOOLS: delegation itself is free because the child re-runs this gate over its own calls. That the child's calls reach NO surface is the unsatisfiable leg described in the header — not asserted here, in either direction. CAVEAT ON THIS ROW'S RESULT CHECK: `T11-SUBAGENT-RAN` is a string this test itself puts in the task text, so a result that merely echoes its input satisfies `resultContains` without any delegated agent having done anything. What it witnesses is that the call was NOT BLOCKED — which is the whole of this row's claim — and not that a child ran. Distinguishing the two needs a side effect only a child could produce, and the child inherits this harness's DRAHT_STUB_TOOL_CALLS script, so it would replay the parent's scripted call rather than write a marker of its own; reported as a gap rather than papered over here.",
	},
	{
		tool: "grep",
		approve: null,
		allow: null,
		unreachable: true,
		note: "Registered but not in the default active set (read/bash/edit/write plus extension tools), so a call is answered 'Tool grep not found' before the gate is consulted.",
	},
	{
		tool: "find",
		approve: null,
		allow: null,
		unreachable: true,
		note: "Registered but not active by default; same as grep.",
	},
	{
		tool: "ls",
		approve: null,
		allow: null,
		unreachable: true,
		note: "Registered but not active by default; same as grep.",
	},
];

// ─── Harness ───────────────────────────────────────────────────────────────────────────────────

const cleanup: string[] = [];
const children: Bun.Subprocess[] = [];

/** See the header: a long Unix socket path fails to bind with EINVAL. */
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
	for (;;) {
		const value = await probe();
		if (value) return value as T;
		if (Date.now() >= deadline) break;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * The inverse of {@link until}: poll for `windowMs` and fail the INSTANT `probe` reports something.
 *
 * `probe` returns the message describing what it saw, or undefined for "still nothing". Polling
 * rather than sleeping matters: the failure is reported at the moment the thing appeared, so a
 * fail-open defect is dated relative to the ask instead of only being visible at the end.
 */
async function stayAbsent(probe: () => string | undefined, windowMs: number): Promise<void> {
	const deadline = Date.now() + windowMs;
	for (;;) {
		const seen = probe();
		if (seen !== undefined) throw new Error(seen);
		if (Date.now() >= deadline) return;
		await Bun.sleep(100);
	}
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

/**
 * The tool result the SESSION ITSELF recorded for `toolCallId`, or undefined while the call is
 * still parked.
 *
 * This is the "did it run" oracle, and it is deliberately the session's own durable transcript
 * rather than anything this test computes: a tool the gate blocked records an `isError` result
 * carrying the block reason, and a tool that ran records what it returned. Scoped to one session's
 * file by id, because every session in a run shares an agent dir.
 */
function toolResult(sessionId: string, toolCallId: string): Record<string, unknown> | undefined {
	for (const file of jsonlFiles(agentDir)) {
		if (!file.includes(sessionId)) continue;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				// A half-written trailing line while the session is live is not a failure.
				continue;
			}
			if (parsed.type !== "message") continue;
			const message = parsed.message as Record<string, unknown> | undefined;
			if (message?.role === "toolResult" && message.toolCallId === toolCallId) return message;
		}
	}
	return undefined;
}

/** The text of a recorded tool result, flattened. */
function resultText(message: Record<string, unknown>): string {
	const content = message.content as { type?: string; text?: string }[] | undefined;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

interface DrahtSession {
	proc: Bun.Subprocess;
	id: string;
	paths: Paths;
	stderr: { text: string };
}

/**
 * Start the emitted binary as an attachable session with exactly one scripted tool call queued.
 *
 * `--mode rpc` is required: with no TTY, `resolveAppMode` falls through to print mode and the
 * process would answer once and exit before anything could attach.
 */
interface SessionOptions {
	/** Extra environment for the child, layered over the fixed set built below. */
	env?: Record<string, string>;
	/**
	 * Start the child through the UNRESOLVED temp path (`/tmp/pen-c-…`, which is a symlink to
	 * `/private/tmp/pen-c-…` on macOS) instead of its realpath, so the ask's `cwd` has a
	 * canonicalization to get right. Where /tmp is a real directory the two paths coincide, the
	 * hazard is simply absent, and the assertion still holds.
	 */
	startThroughSymlink?: boolean;
}

async function startSession(vector: Vector, options: SessionOptions = {}): Promise<DrahtSession> {
	const rawInside = tempDir("pen-c-");
	const inside = realpathSync(rawInside);
	const outside = realpathSync(tempDir("pen-o-"));
	const paths: Paths = { inside, outside };

	for (const [file, contents] of Object.entries(vector.seed?.(paths) ?? {})) writeFileSync(file, contents);

	const call = vector.call(paths);
	const script = JSON.stringify([{ toolCalls: [{ id: CALL_ID, name: call.name, arguments: call.arguments }] }]);
	const stderr = { text: "" };

	// Built from scratch, never inherited: this repo's shell exports DRAHT_PERMISSION_MODE=auto and
	// a permission test run under it passes while proving nothing.
	const proc = Bun.spawn(
		[
			"node",
			DRAHT_CLI,
			"--attachable",
			"--mode",
			"rpc",
			"--provider",
			"draht-stub",
			"--model",
			"stub-1",
			"-e",
			HELLO_EXTENSION,
			"-e",
			PROBE_EXTENSION,
		],
		{
			cwd: options.startThroughSymlink === true ? rawInside : inside,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
				DRAHT_STUB_TOOL_CALLS: script,
				...options.env,
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

	return { proc, id: id.slice(0, -".sock".length), paths, stderr };
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
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			this.frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
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

	asks(): Record<string, unknown>[] {
		return this.frames.filter((frame) => frame.type === "permission_request");
	}

	async waitFor(
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

beforeAll(async () => {
	const build = Bun.spawnSync(["bun", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

	agentDir = tempDir("pen-a-");
	home = tempDir("pen-h-");

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

async function attachedTo(sessionId: string, clientId: string): Promise<Renderer> {
	const renderer = await Renderer.open();
	renderer.send({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "permission-enumeration-e2e", version: "0.0.0" },
	});
	await renderer.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	renderer.send({ type: "attach", sessionId, clientId, mode: "read-write" });
	await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
	return renderer;
}

/** Assert every claim a vector makes about the side effect of the call having run. */
function expectRanFor(vector: Vector, session: DrahtSession, result: Record<string, unknown>): void {
	expect(result.isError).toBe(false);
	const wanted = vector.resultContains?.(session.paths);
	if (wanted !== undefined) expect(resultText(result)).toContain(wanted);
	const marker = vector.marker?.(session.paths);
	if (marker !== undefined) expect(existsSync(marker)).toBe(true);
}

// ─── The enumeration itself ────────────────────────────────────────────────────────────────────

/**
 * The teeth. Every tool the RUNNING BINARY reports must have a row above.
 *
 * A tool added to draht tomorrow lands in `pi.getAllTools()` and fails here until someone writes
 * its argument vectors down — which is the only thing that keeps the rest of this file from
 * quietly covering a shrinking fraction of the product.
 */
test("every tool the running binary reports has a literal vector row", async () => {
	const session = await startSession(VECTORS[0].approve as Vector);
	const line = await until(
		() => session.stderr.text.split("\n").find((entry) => entry.startsWith(PROBE_PREFIX)),
		`the probe extension to report the tool registry (stderr: ${session.stderr.text})`,
	);
	const reported = JSON.parse(line.slice(PROBE_PREFIX.length)) as { all: string[]; active: string[] };

	// The list the plan measured, so a silent change in what ships is visible here and not only as
	// a missing row.
	expect(reported.all.slice().sort()).toEqual([
		"bash",
		"edit",
		"find",
		"grep",
		"hello",
		"ls",
		"read",
		"subagent",
		"write",
	]);

	const rows = new Map(VECTORS.map((row) => [row.tool, row]));
	for (const tool of reported.all) {
		expect(rows.has(tool)).toBe(true);
	}
	// And nothing in the table is a ghost: a row for a tool the binary no longer has would let a
	// deleted tool go on "passing".
	for (const row of VECTORS) expect(reported.all).toContain(row.tool);

	// Reachability is a claim the table makes, so the table has to be held to it. A tool marked
	// unreachable must really be absent from the active set; every other row must really be in it.
	for (const row of VECTORS) {
		if (row.unreachable === true) expect(reported.active).not.toContain(row.tool);
		else expect(reported.active).toContain(row.tool);
	}

	// Every reachable row states at least one vector — a row with neither would be an entry that
	// asserts nothing while looking like coverage.
	for (const row of VECTORS) {
		if (row.unreachable === true) continue;
		expect(row.approve !== null || row.allow !== null).toBe(true);
		expect(row.note.length).toBeGreaterThan(0);
	}
}, 120_000);

for (const row of VECTORS) {
	const approve = row.approve;
	if (approve === null) continue;

	test(`${row.tool}: an execution that must prompt raises exactly one ask on the attach wire`, async () => {
		const session = await startSession(approve);
		const phone = await attachedTo(session.id, `phone-${row.tool}`);
		const marker = approve.marker?.(session.paths);
		if (marker !== undefined) expect(existsSync(marker)).toBe(false);

		phone.send({ type: "input", data: `run the scripted ${row.tool} call`, clientId: `phone-${row.tool}` });

		const ask = await phone.waitFor((frame) => frame.type === "permission_request", `the ${row.tool} ask`, 60_000);
		expect(ask.method).toBe("confirm");
		expect(ask.toolName).toBe(row.tool);
		expect(ask.toolCallId).toBe(CALL_ID);
		// The project the answering surface is told this ask belongs to. It asserts no
		// canonicalization: this session is spawned with an ALREADY-realpath'd cwd, so no symlink is
		// ever presented to resolve. The negative control below starts its session THROUGH the
		// /tmp → /private/tmp symlink and asserts the same field, which is where that claim lives.
		expect(ask.cwd).toBe(session.paths.inside);
		expect(ask.truncated).toBe(false);
		expect(typeof ask.requestId).toBe("string");

		// The decisive fact, per tool: what is actually being approved.
		const detail = approve.detail?.(session.paths);
		if (detail !== undefined) expect(ask[detail.field]).toBe(detail.value);

		const options = ask.options as { id: string; label: string }[];
		expect(options.map((option) => option.id).sort()).toEqual(["approve", "deny"]);

		const requestId = ask.requestId as string;
		phone.send({ type: "permission_response", clientId: `phone-${row.tool}`, requestId, optionId: "approve" });

		const resolved = await phone.waitFor(
			(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
			`the ${row.tool} resolution`,
		);
		expect(resolved.decision).toBe("approved");
		expect(resolved.chosenOptionId).toBe("approve");

		// The load-bearing part: the call ran because a remote client said so.
		const result = await until(
			() => toolResult(session.id, CALL_ID),
			`the ${row.tool} call to run after approval (draht stderr: ${session.stderr.text})`,
			60_000,
		);
		expectRanFor(approve, session, result);

		// EXACTLY one. A second ask for the same call would mean a surface was asked twice for one
		// decision, which is how a human ends up approving something they already approved.
		expect(phone.asks()).toHaveLength(1);
		phone.close();
	}, 120_000);
}

for (const row of VECTORS) {
	const allow = row.allow;
	if (allow === null) continue;

	test(`${row.tool}: an execution that must not prompt raises no ask at all`, async () => {
		const session = await startSession(allow);
		const phone = await attachedTo(session.id, `quiet-${row.tool}`);

		phone.send({ type: "input", data: `run the scripted ${row.tool} call`, clientId: `quiet-${row.tool}` });

		// Race the two outcomes rather than sleeping on one: an unexpected ask parks the agent
		// forever, so waiting only for the result would report a spurious prompt as a timeout.
		const outcome = await until(
			() => {
				const ask = phone.asks()[0];
				if (ask !== undefined) return { ask } as const;
				const result = toolResult(session.id, CALL_ID);
				return result === undefined ? undefined : ({ result } as const);
			},
			`the ${row.tool} call to run unprompted (draht stderr: ${session.stderr.text})`,
			60_000,
		);
		if ("ask" in outcome) {
			throw new Error(`${row.tool} raised a permission ask it must not raise: ${JSON.stringify(outcome.ask)}`);
		}
		expectRanFor(allow, session, outcome.result);

		// A settle window AFTER the result, because a late ask is still an ask.
		await Bun.sleep(1_500);
		expect(phone.asks()).toEqual([]);
		phone.close();
	}, 120_000);
}

// ─── The negative control: the answer is what makes the call run ───────────────────────────────

/**
 * Tools the control is run for.
 *
 * `bash` is the one that matters — it is the only row whose approve-vector leaves a marker FILE, so
 * "it did not run" is observable in the filesystem and not only in the transcript. `hello` is the
 * extension tool R34-PERM.7 names, and covers the catch-all approve path with a different executor
 * behind it for the price of one more session.
 */
const NEGATIVE_CONTROL_TOOLS = ["bash", "hello"] as const;

for (const tool of NEGATIVE_CONTROL_TOOLS) {
	test(`${tool}: an ask nobody answers runs nothing — and the same call runs the moment it is answered`, async () => {
		const row = VECTORS.find((entry) => entry.tool === tool);
		if (row === undefined || row.approve === null) {
			throw new Error(`the negative control names ${tool}, which has no approve-vector in the table`);
		}
		const approve = row.approve;

		const session = await startSession(approve, {
			env: { DRAHT_PERMISSION_EXPIRY_MS: String(CONTROL_EXPIRY_MS) },
			// The one place a cwd canonicalization is actually presented; see the header.
			startThroughSymlink: true,
		});
		const clientId = `silent-${tool}`;
		const phone = await attachedTo(session.id, clientId);
		const marker = approve.marker?.(session.paths);
		if (marker !== undefined) expect(existsSync(marker)).toBe(false);

		phone.send({ type: "input", data: `run the scripted ${tool} call`, clientId });

		const ask = await phone.waitFor((frame) => frame.type === "permission_request", `the ${tool} ask`, 60_000);
		const requestId = ask.requestId as string;
		expect(ask.toolName).toBe(tool);
		expect(ask.toolCallId).toBe(CALL_ID);

		// The session was started through `/tmp/pen-c-…`; the ask must name the canonical project
		// path, because that is what every other surface — and the session's own transcript — calls
		// it. A relay that carried the spawn-time string here would show the phone a project the
		// session does not believe it is in.
		expect(ask.cwd).toBe(session.paths.inside);

		// The window sits inside BOTH clocks that could end this ask without a human: the registry's
		// expiry and any timeout the decorator declared, whichever is earlier, is what `deadline`
		// reports. Without this, a silent drop of `CONTROL_EXPIRY_MS` would turn "nobody answered"
		// into "it expired" and the control would still look green.
		const requestedAt = Date.parse(ask.requestedAt as string);
		const deadline = Date.parse(ask.deadline as string);
		expect(Number.isFinite(requestedAt) && Number.isFinite(deadline)).toBe(true);
		expect(deadline - requestedAt).toBeGreaterThan(UNANSWERED_WINDOW_MS * 2);

		// ── the control: say nothing, and watch ────────────────────────────────────────────────
		await stayAbsent(() => {
			const premature = toolResult(session.id, CALL_ID);
			if (premature !== undefined) {
				return `${tool} recorded a tool result while its ask was unanswered — the call did not need the answer: ${JSON.stringify(premature)}`;
			}
			if (marker !== undefined && existsSync(marker)) {
				return `${tool} produced ${marker} while its ask was unanswered — the call ran without a decision`;
			}
			const settled = phone.frames.find(
				(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
			);
			if (settled !== undefined) {
				return `the ${tool} ask settled with nobody answering it: ${JSON.stringify(settled)}`;
			}
			return undefined;
		}, UNANSWERED_WINDOW_MS);

		// Still exactly the one ask, still open: nothing was re-raised, and nothing gave up.
		expect(phone.asks()).toHaveLength(1);

		// ── the calibration: now answer, and time the identical call ───────────────────────────
		const answeredAt = Date.now();
		phone.send({ type: "permission_response", clientId, requestId, optionId: "approve" });

		const resolved = await phone.waitFor(
			(frame) => frame.type === "permission_resolved" && frame.requestId === requestId,
			`the ${tool} resolution`,
		);
		expect(resolved.decision).toBe("approved");

		const result = await until(
			() => toolResult(session.id, CALL_ID),
			`the ${tool} call to run after the withheld answer was finally given (draht stderr: ${session.stderr.text})`,
			60_000,
		);
		const answeredMs = Date.now() - answeredAt;
		expectRanFor(approve, session, result);

		// THE POINT. The window that saw nothing was this many times the time the same call, in the
		// same session, actually took once it was allowed to run — so "nothing ran" cannot be read
		// as "had not run yet". A machine slow enough to break this relation must raise the window
		// rather than be quietly excused by it.
		if (answeredMs * WINDOW_SAFETY_FACTOR > UNANSWERED_WINDOW_MS) {
			throw new Error(
				`${tool} took ${answeredMs}ms to record its result once answered, which is more than ` +
					`1/${WINDOW_SAFETY_FACTOR} of the ${UNANSWERED_WINDOW_MS}ms unanswered window. The window no ` +
					`longer proves an answer is required — raise UNANSWERED_WINDOW_MS.`,
			);
		}
		phone.close();
	}, 180_000);
}
