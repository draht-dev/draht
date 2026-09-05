/**
 * `RlmSession` — the RLM root loop.
 *
 * root-LLM-produces-code -> REPL-executes -> truncated-stdout ->
 * history-append -> FINAL-check, per
 * .planning/phases/26-rlm-core-primitives/26-01-PLAN.md, Architecture
 * section 4. Talks to `../python/repl_driver.py` over the newline-delimited
 * JSON wire protocol documented in that file's module docstring (and
 * section 2-3 of the plan).
 */

import { type ChildProcess, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSandboxed } from "./sandbox.js";
import type { RlmHistoryEntry, RlmResult, RlmSessionOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = join(__dirname, "..", "python", "repl_driver.py");

const DEFAULT_MAX_ITERATIONS = 24;
const DEFAULT_STDOUT_TRUNCATE_CHARS = 2000;

// Resource-limit defaults (Phase 28, Architecture section 3). These are the
// REAL enforcement mechanisms -- Node-side wall-clock + RSS polling, not any
// Python-level RLIMIT/timer (see repl_driver.py's Linux-only RLIMIT_AS,
// which is explicitly a backstop, not the primary mechanism, and isn't used
// on macOS at all per the plan).
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
/**
 * The startup self-test spawns python3 and drives a 2 s socket probe, so it
 * is bounded by at least this much even when a caller sets a tiny step
 * budget -- otherwise a slow start would be reported as a sandbox violation.
 */
const MIN_SELF_TEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RSS_BYTES = 256 * 1024 * 1024;
const DEFAULT_RSS_POLL_INTERVAL_MS = 250;

/**
 * Thrown internally when a step's Node-side wall-clock timeout fires and the
 * driver subprocess is hard-killed. Caught in `run()` and mapped to
 * `RlmResult.kind === "timeout"` -- never surfaced to callers directly.
 */
class RlmStepTimeoutError extends Error {}

/**
 * Thrown internally when a `maxSubCalls`/`maxTotalCostUsd` pre-check fails
 * and the driver subprocess is hard-killed as a result. Caught in `run()`
 * and mapped to `RlmResult.kind === "budget_exhausted"` -- never surfaced to
 * callers directly.
 */
class RlmBudgetExhaustedError extends Error {}

/**
 * Thrown internally when the OS-level sandbox's runtime startup self-test
 * (Phase 28 Architecture section 1) doesn't confirm the sandbox is actually
 * enforcing for this process -- either the driver never answered, answered
 * with something other than a well-formed `self_test_result`, or reported
 * that a network connect or an out-of-workdir file read *succeeded*. Caught
 * in `run()` and mapped to `RlmResult.kind === "sandbox_violation"`. This is
 * distinct from the synchronous `SandboxUnavailableError` thrown by
 * `spawnSandboxed` itself (missing wrapper binary/profile/interpreter) --
 * that one fails closed before any process exists; this one fails closed
 * after a process exists but before it's ever trusted with real
 * root-LLM-authored code.
 */
class RlmSandboxViolationError extends Error {}

/**
 * Reads the driver subprocess's current resident-set size in bytes, or
 * `null` if it can't be determined right now (process already exited,
 * `ps`/`/proc` unavailable, a transient read race, etc.). `null` always
 * means "skip this poll" -- never treated as "assume 0 bytes" or "assume
 * over the limit", since either guess could produce a wrong kill/no-kill
 * decision.
 *
 * Linux: reads `/proc/<pid>/status`'s `VmRSS` line directly (no subprocess
 * spawn needed). Every other platform (macOS in practice): shells out to
 * `ps -o rss= -p <pid>` (BSD `ps` reports RSS in KiB) since there's no
 * `/proc` to read. See Phase 28 Architecture section 3.
 */
function readRssBytes(pid: number): Promise<number | null> {
	if (process.platform === "linux") {
		return readFile(`/proc/${pid}/status`, "utf8").then(
			(status) => {
				const match = /^VmRSS:\s*(\d+)\s*kB$/m.exec(status);
				return match ? Number(match[1]) * 1024 : null;
			},
			() => null,
		);
	}
	return new Promise((resolve) => {
		execFile("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const trimmed = stdout.trim().split("\n")[0]?.trim();
			if (!trimmed) {
				resolve(null);
				return;
			}
			const kb = Number(trimmed);
			resolve(Number.isFinite(kb) ? kb * 1024 : null);
		});
	});
}

/** One newline-delimited-JSON message in either direction of the wire protocol. */
interface DriverMessage {
	type: string;
	[key: string]: unknown;
}

/** The `exec_result.final` payload shape (see repl_driver.py). */
interface DriverFinalPayload {
	kind: "value" | "var";
	/** For "value": `str(answer)`. For "var": `repr(globals_dict[name])`. */
	value: string;
	name?: string;
}

interface DriverExecResult extends DriverMessage {
	type: "exec_result";
	stdout: string;
	error: string | null;
	final: DriverFinalPayload | null;
}

/**
 * Extracts Python source from a root-LLM response.
 *
 * Per R26-RLM.4, the response is expected to contain a ```repl or ```python
 * fenced block (possibly surrounded by prose explaining the plan). Falls
 * back to the whole (trimmed) response when no fence is present, so mocked
 * `rootLlm` callbacks in tests can return raw code directly.
 */
export function extractPythonCode(response: string): string {
	const match = /```(?:repl|python)[ \t]*\r?\n([\s\S]*?)```/.exec(response);
	if (!match) return response.trim();
	return match[1].replace(/\r?\n$/, "");
}

/**
 * Truncates captured stdout to `limit` characters, appending an explicit
 * marker for how many characters were cut — matching the `[truncated N
 * chars]` format R28-SBX.4 (Phase 28) will enforce as a hard cap. This phase
 * only applies it as a plain formatting rule, not a safety mechanism.
 */
export function truncateStdout(stdout: string, limit: number): string {
	if (stdout.length <= limit) return stdout;
	const omitted = stdout.length - limit;
	return `${stdout.slice(0, limit)}\n[truncated ${omitted} chars]`;
}

/**
 * Restricted Python-literal parser used to turn a `FINAL_VAR`-produced
 * `repr()` string back into a real JS value.
 *
 * Handles the JSON-safe subset the plan calls out: `None`/`True`/`False`,
 * int/float, single- or double-quoted strings (with the common backslash
 * escapes), lists, tuples (mapped to arrays — JS has no tuple type), and
 * dicts (mapped to plain objects; keys are coerced with `String(...)`).
 * Anything it can't parse (custom object reprs like `<Foo object at
 * 0x...>`, sets, NaN/Infinity, etc.) falls back to the raw repr string
 * rather than throwing, so a result is never lost — see the module-level
 * note in this file's neighboring test for why raw-string fallback beats
 * failing the whole run.
 */
export function pythonReprToValue(repr: string): unknown {
	try {
		const parser = new PyReprParser(repr);
		const value = parser.parseValue();
		parser.expectEnd();
		return value;
	} catch {
		return repr;
	}
}

class PyReprParseError extends Error {}

/** Minimal recursive-descent parser for a subset of Python literal syntax. */
class PyReprParser {
	private i = 0;
	constructor(private readonly src: string) {}

	private skipWs(): void {
		while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
	}

	expectEnd(): void {
		this.skipWs();
		if (this.i !== this.src.length) {
			throw new PyReprParseError(`unexpected trailing characters at ${this.i}`);
		}
	}

	parseValue(): unknown {
		this.skipWs();
		const c = this.src[this.i];
		if (c === undefined) throw new PyReprParseError("unexpected end of repr");
		if (c === "'" || c === '"') return this.parseString();
		if (c === "[") return this.parseSequence("[", "]");
		if (c === "(") return this.parseSequence("(", ")");
		if (c === "{") return this.parseDictOrSet();
		if (this.src.startsWith("None", this.i)) {
			this.i += 4;
			return null;
		}
		if (this.src.startsWith("True", this.i)) {
			this.i += 4;
			return true;
		}
		if (this.src.startsWith("False", this.i)) {
			this.i += 5;
			return false;
		}
		return this.parseNumber();
	}

	private parseString(): string {
		const quote = this.src[this.i];
		this.i++;
		let out = "";
		while (this.i < this.src.length && this.src[this.i] !== quote) {
			const ch = this.src[this.i];
			if (ch === "\\") {
				this.i++;
				const esc = this.src[this.i];
				switch (esc) {
					case "n":
						out += "\n";
						break;
					case "t":
						out += "\t";
						break;
					case "r":
						out += "\r";
						break;
					case "b":
						out += "\b";
						break;
					case "f":
						out += "\f";
						break;
					case "v":
						out += "\v";
						break;
					case "0":
						out += "\0";
						break;
					case "\\":
						out += "\\";
						break;
					case "'":
						out += "'";
						break;
					case '"':
						out += '"';
						break;
					case "x": {
						out += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 1, this.i + 3), 16));
						this.i += 2;
						break;
					}
					case "u": {
						out += String.fromCharCode(Number.parseInt(this.src.slice(this.i + 1, this.i + 5), 16));
						this.i += 4;
						break;
					}
					case "U": {
						out += String.fromCodePoint(Number.parseInt(this.src.slice(this.i + 1, this.i + 9), 16));
						this.i += 8;
						break;
					}
					default:
						out += esc ?? "";
				}
				this.i++;
			} else {
				out += ch;
				this.i++;
			}
		}
		if (this.src[this.i] !== quote) throw new PyReprParseError("unterminated string literal");
		this.i++;
		return out;
	}

	private parseNumber(): number {
		const start = this.i;
		if (this.src[this.i] === "-" || this.src[this.i] === "+") this.i++;
		while (this.i < this.src.length && /[0-9]/.test(this.src[this.i])) this.i++;
		if (this.src[this.i] === ".") {
			this.i++;
			while (this.i < this.src.length && /[0-9]/.test(this.src[this.i])) this.i++;
		}
		if (this.src[this.i] === "e" || this.src[this.i] === "E") {
			this.i++;
			if (this.src[this.i] === "-" || this.src[this.i] === "+") this.i++;
			while (this.i < this.src.length && /[0-9]/.test(this.src[this.i])) this.i++;
		}
		const numStr = this.src.slice(start, this.i);
		if (!/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(numStr)) {
			throw new PyReprParseError(`invalid number literal at ${start}`);
		}
		return Number(numStr);
	}

	/** Parses `[...]` (list) or `(...)` (tuple) into a JS array. */
	private parseSequence(_open: string, close: string): unknown[] {
		this.i++; // opening bracket
		const out: unknown[] = [];
		this.skipWs();
		if (this.src[this.i] === close) {
			this.i++;
			return out;
		}
		while (true) {
			out.push(this.parseValue());
			this.skipWs();
			if (this.src[this.i] === ",") {
				this.i++;
				this.skipWs();
				if (this.src[this.i] === close) {
					this.i++;
					break;
				}
				continue;
			}
			if (this.src[this.i] === close) {
				this.i++;
				break;
			}
			throw new PyReprParseError(`expected ',' or '${close}' at ${this.i}`);
		}
		return out;
	}

	/** Parses `{...}` as a dict (if any `key: value` pair is found) or a set (mapped to an array). */
	private parseDictOrSet(): unknown {
		this.i++; // {
		this.skipWs();
		if (this.src[this.i] === "}") {
			this.i++;
			return {};
		}
		const firstKeyOrValue = this.parseValue();
		this.skipWs();
		if (this.src[this.i] === ":") {
			this.i++;
			const out: Record<string, unknown> = {};
			out[String(firstKeyOrValue)] = this.parseValue();
			this.skipWs();
			while (this.src[this.i] === ",") {
				this.i++;
				this.skipWs();
				if (this.src[this.i] === "}") break;
				const key = this.parseValue();
				this.skipWs();
				if (this.src[this.i] !== ":") throw new PyReprParseError(`expected ':' at ${this.i}`);
				this.i++;
				out[String(key)] = this.parseValue();
				this.skipWs();
			}
			if (this.src[this.i] !== "}") throw new PyReprParseError("expected '}' to close dict");
			this.i++;
			return out;
		}
		const out: unknown[] = [firstKeyOrValue];
		this.skipWs();
		while (this.src[this.i] === ",") {
			this.i++;
			this.skipWs();
			if (this.src[this.i] === "}") break;
			out.push(this.parseValue());
			this.skipWs();
		}
		if (this.src[this.i] !== "}") throw new PyReprParseError("expected '}' to close set");
		this.i++;
		return out;
	}
}

interface PendingWaiter {
	resolve: (message: DriverMessage) => void;
	reject: (error: Error) => void;
}

export class RlmSession {
	private readonly child: ChildProcess;
	private readonly workdir: string;
	private readonly stdoutTruncateChars: number;
	private readonly maxIterations: number;
	private readonly stepTimeoutMs: number;
	private readonly maxRssBytes: number;
	private readonly rssPollIntervalMs: number;
	private readonly maxSubCalls: number | undefined;
	private readonly maxTotalCostUsd: number | undefined;
	private readonly getAccumulatedCostUsd: (() => number) | undefined;
	private readonly history: RlmHistoryEntry[] = [];
	private readonly ready: Promise<void>;

	private buffer = "";
	private messageQueue: DriverMessage[] = [];
	private waiters: PendingWaiter[] = [];
	private terminated = false;
	private terminationError: Error | null = null;
	private lastFinal: DriverFinalPayload | null = null;
	private subCallCount = 0;
	private rssPollTimer: NodeJS.Timeout | undefined;
	private rssPollInFlight = false;

	constructor(private readonly opts: RlmSessionOptions) {
		this.stdoutTruncateChars = opts.stdoutTruncateChars ?? DEFAULT_STDOUT_TRUNCATE_CHARS;
		this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
		this.maxRssBytes = opts.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES;
		this.rssPollIntervalMs = opts.rssPollIntervalMs ?? DEFAULT_RSS_POLL_INTERVAL_MS;
		this.maxSubCalls = opts.maxSubCalls;
		this.maxTotalCostUsd = opts.maxTotalCostUsd;
		this.getAccumulatedCostUsd = opts.getAccumulatedCostUsd;

		// The session's scratch workdir -- the only place the OS-sandboxed
		// driver process may read *and* write freely (see sandbox.ts /
		// ../sandbox/macos.sb). Created fresh per session and cleaned up in
		// dispose(). Not caller-configurable (yet): Phase 28 scopes the
		// sandbox to this session-owned directory, not an arbitrary
		// caller-supplied path.
		this.workdir = mkdtempSync(join(tmpdir(), "rlm-session-"));

		// spawnSandboxed wraps python3/repl_driver.py in the platform's
		// OS-level sandbox (sandbox-exec on macOS, unshare/bwrap on Linux) --
		// see sandbox.ts's module docstring for why this, and not
		// repl_driver.py's Python-level guardrails, is the real security
		// boundary. It throws SandboxUnavailableError synchronously (never
		// returns a fallback unwrapped command) if the sandbox can't be
		// established, which is exactly what should happen here: this
		// constructor must fail closed, not silently spawn the driver
		// unsandboxed.
		this.child = spawnSandboxed({ driverPath: DRIVER_PATH, workdir: this.workdir });

		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.onStdoutChunk(chunk));

		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => {
			// Driver-side crashes (as opposed to in-REPL exceptions, which are
			// reported via exec_result.error) surface here. Don't throw on
			// stray stderr output alone -- just make it visible for debugging.
			console.error(`[rlm repl_driver stderr] ${chunk}`);
		});

		this.child.once("exit", (code, signal) => {
			this.markTerminated(new Error(`RlmSession: python3 driver exited (code=${code}, signal=${signal})`));
		});
		this.child.once("error", (err) => {
			this.markTerminated(new Error(`RlmSession: failed to spawn python3 driver: ${err.message}`));
		});

		// Node-side RSS polling (Phase 28 Architecture section 3) -- the real
		// memory enforcement mechanism, running for the whole lifetime of the
		// child process, independent of any single step's wall-clock timeout.
		this.startRssPolling();

		// Tell the driver how aggressively to cap captured stdout *before* any
		// real step runs (see repl_driver.py's `configure` handling / Phase 28
		// Architecture section 5) -- fire-and-forget: writes to child.stdin are
		// delivered strictly in order, so this is guaranteed to be processed
		// before the `self_test`/`exec` messages sent next.
		this.send({ type: "configure", stdoutTruncateChars: this.stdoutTruncateChars });

		// Runtime startup self-test (Phase 28 Architecture section 1) -- runs
		// before `context` is even seeded, let alone before any root-LLM-
		// authored `exec`. If the OS sandbox isn't actually enforcing for this
		// process, `runSelfTest()` throws and `seedContext()` never runs, so no
		// step ever executes against an unconfined driver. See
		// `RlmSandboxViolationError`'s doc comment for how this differs from
		// `spawnSandboxed`'s synchronous fail-closed throw.
		this.ready = this.runSelfTest().then(() => this.seedContext());
		// Attach a no-op rejection handler so Node doesn't report this as an
		// unhandled rejection when the failure path is exercised without every
		// caller immediately awaiting `run()`/`step()` -- `await this.ready`
		// elsewhere still observes the same rejection (a promise notifies every
		// attached reaction, not just the first).
		this.ready.catch(() => {});
	}

	private onStdoutChunk(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			newlineIndex = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			let message: DriverMessage;
			try {
				message = JSON.parse(line) as DriverMessage;
			} catch {
				this.markTerminated(new Error(`RlmSession: driver emitted non-JSON output: ${line}`));
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter.resolve(message);
			else this.messageQueue.push(message);
		}
	}

	private markTerminated(error: Error): void {
		if (this.terminated) return;
		this.terminated = true;
		this.terminationError = error;
		if (this.rssPollTimer) {
			clearInterval(this.rssPollTimer);
			this.rssPollTimer = undefined;
		}
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(error);
	}

	/**
	 * Hard-kills the driver subprocess and marks the session terminated with
	 * `error` in one step. Used by every resource-limit enforcement path (RSS
	 * ceiling, wall-clock timeout, budget exhaustion) -- these are Node-side
	 * hard kills, not attempts at graceful in-process recovery (Phase 28
	 * Architecture sections 3 and 6). `markTerminated`'s first-write-wins
	 * guard means whichever of these fires first supplies the message callers
	 * actually see, even though the child's own `exit` handler will also fire
	 * shortly after and try to (harmlessly, redundantly) mark terminated too.
	 */
	private killAndTerminate(error: Error): void {
		this.markTerminated(error);
		this.child.kill("SIGKILL");
	}

	/**
	 * Starts the Node-side RSS poll loop (Phase 28 Architecture section 3) --
	 * the real memory enforcement mechanism, not any Python-level
	 * `RLIMIT_AS`. Runs for the child process's whole lifetime; `unref()`d so
	 * it never by itself keeps the host Node process alive past everything
	 * else finishing. A `maxRssBytes <= 0` disables polling entirely.
	 */
	private startRssPolling(): void {
		if (!(this.maxRssBytes > 0)) return;
		const timer = setInterval(() => {
			void this.pollRss();
		}, this.rssPollIntervalMs);
		timer.unref();
		this.rssPollTimer = timer;
	}

	private async pollRss(): Promise<void> {
		if (this.terminated || this.rssPollInFlight) return;
		const pid = this.child.pid;
		if (!pid) return;
		this.rssPollInFlight = true;
		try {
			const rssBytes = await readRssBytes(pid);
			if (rssBytes === null || rssBytes <= this.maxRssBytes) return;
			this.killAndTerminate(
				new Error(
					`RlmSession: python3 driver exceeded the configured RSS ceiling of ${this.maxRssBytes} bytes ` +
						`(observed ${rssBytes} bytes) -- killed. This is a resource-limit kill (Phase 28 Architecture ` +
						"section 3), not the OS sandbox itself failing.",
				),
			);
		} finally {
			this.rssPollInFlight = false;
		}
	}

	/**
	 * Pre-dispatch sub-call budget check (Phase 28 Architecture section 6,
	 * R28-SBX.5): called *before* an `llm_query_request` is ever forwarded to
	 * `opts.llmQuery`, so the (budget+1)th attempted sub-call never actually
	 * dispatches -- the session is killed right here instead. Deliberately
	 * NOT also checked before dispatching a whole step: a step that never
	 * attempts another sub-call can still legitimately finish (e.g. call
	 * FINAL immediately) even after the budget is otherwise exhausted, and
	 * pre-emptively killing such a step here would be wrong.
	 */
	private checkSubCallBudget(): void {
		if (this.maxSubCalls === undefined) return;
		if (this.subCallCount < this.maxSubCalls) return;
		const error = new RlmBudgetExhaustedError(
			`RlmSession: llm_query sub-call budget exhausted (maxSubCalls=${this.maxSubCalls}) -- refusing to ` +
				`dispatch sub-call #${this.subCallCount + 1} and killing the driver subprocess.`,
		);
		this.killAndTerminate(error);
		throw error;
	}

	/**
	 * Pre-dispatch cost budget check (Phase 28 Architecture section 6,
	 * R28-SBX.5): called before dispatching a step's `rootLlm` turn and
	 * before forwarding a sub-call to `opts.llmQuery`. No-ops unless both
	 * `maxTotalCostUsd` and `getAccumulatedCostUsd` are supplied -- see
	 * `RlmSessionOptions.maxTotalCostUsd`'s doc comment for why an unpaired
	 * option is a no-op rather than a guess.
	 */
	private checkCostBudget(): void {
		if (this.maxTotalCostUsd === undefined || !this.getAccumulatedCostUsd) return;
		const accumulated = this.getAccumulatedCostUsd();
		if (accumulated < this.maxTotalCostUsd) return;
		const error = new RlmBudgetExhaustedError(
			`RlmSession: cost budget exhausted (maxTotalCostUsd=$${this.maxTotalCostUsd}, accumulated=$${accumulated}) ` +
				"-- killing the driver subprocess.",
		);
		this.killAndTerminate(error);
		throw error;
	}

	/**
	 * Races `promise` against the configured wall-clock step timeout
	 * (Phase 28 Architecture section 3, R28-SBX.3) -- the real timeout
	 * enforcement mechanism. On expiry, hard-kills the driver subprocess and
	 * rejects with `RlmStepTimeoutError`, even if `promise` itself is stuck
	 * awaiting something that `markTerminated`'s waiter-rejection can't reach
	 * (e.g. a slow/hung `opts.llmQuery` callback, as opposed to a pending
	 * `nextMessage()` wait) -- the explicit `reject` here is what actually
	 * unblocks the caller in that case, not just a formality.
	 */
	private withStepTimeout<T>(promise: Promise<T>, timeoutMs = this.stepTimeoutMs): Promise<T> {
		if (!(timeoutMs > 0)) return promise;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new RlmStepTimeoutError(
					`RlmSession: step exceeded the configured wall-clock timeout of ${timeoutMs}ms -- killed.`,
				);
				this.killAndTerminate(error);
				reject(error);
			}, timeoutMs);
			timer.unref();
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	private nextMessage(): Promise<DriverMessage> {
		const queued = this.messageQueue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.terminated) {
			return Promise.reject(this.terminationError ?? new Error("RlmSession: driver process is no longer running"));
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	private send(message: Record<string, unknown>): void {
		if (this.terminated) {
			throw this.terminationError ?? new Error("RlmSession: cannot send to a terminated driver process");
		}
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	/**
	 * Sends one `exec` message and handles any `llm_query_request` round-trips
	 * until the matching `exec_result`, all under the wall-clock step timeout
	 * (`withStepTimeout`, Phase 28 Architecture section 3).
	 */
	private async runExec(code: string): Promise<DriverExecResult> {
		this.send({ type: "exec", code });
		return this.withStepTimeout(this.collectExecResult());
	}

	/** The message loop `runExec` races against the step timeout -- split out so `withStepTimeout` can wrap just this. */
	private async collectExecResult(): Promise<DriverExecResult> {
		while (true) {
			const message = await this.nextMessage();
			if (message.type === "llm_query_request") {
				const id = message.id as string;
				if (!this.opts.llmQuery) {
					throw new Error(
						"RlmSession: REPL code called llm_query(...) but no `llmQuery` callback was provided in RlmSessionOptions.",
					);
				}
				// Budget pre-checks (Phase 28 Architecture section 6, R28-SBX.5) --
				// before this sub-call is dispatched, not after: either check can
				// throw (and kill the driver), in which case opts.llmQuery is never
				// called for this attempt at all.
				this.checkSubCallBudget();
				this.checkCostBudget();
				this.subCallCount++;
				const text = await this.opts.llmQuery(message.prompt as string);
				this.send({ type: "llm_query_response", id, text });
				continue;
			}
			if (message.type === "exec_result") {
				return message as DriverExecResult;
			}
			throw new Error(`RlmSession: unexpected message from driver: ${JSON.stringify(message)}`);
		}
	}

	private async seedContext(): Promise<void> {
		// JSON string escaping and Python double-quoted string literal escaping
		// agree on the escapes that matter here (\", \\, \n, \t, \r, and
		// \uXXXX), so JSON.stringify produces a valid Python string literal.
		await this.runExec(`context = ${JSON.stringify(this.opts.prompt)}`);
	}

	/**
	 * Runtime proof the OS-level sandbox is actually enforcing for *this*
	 * process (Phase 28 Architecture section 1) -- sends `{"type":
	 * "self_test"}` and requires the driver's `self_test_result` response to
	 * report both a network connect attempt and an out-of-workdir file read
	 * failing. Throws `RlmSandboxViolationError` (fail-closed, refusing to run
	 * at all) if:
	 *   - the driver never responds (crash/hang -- guarded by the step
	 *     wall-clock timeout, floored at `MIN_SELF_TEST_TIMEOUT_MS`),
	 *   - the response isn't a well-formed `self_test_result`, or
	 *   - either check reports the sandbox did NOT block the attempt.
	 *
	 * Deliberately does not go through `runExec`/the guarded `exec()` wire
	 * message: `repl_driver.py`'s `_run_self_test` handles `self_test`
	 * on a route that bypasses its own Python-level guardrails (restricted
	 * builtins, import allowlist, AST screen) entirely, because a self-test
	 * *routed through* those guardrails would be a false positive -- e.g.
	 * `import socket` failing on the guardrail import allowlist looks
	 * identical to `import socket` failing because the OS sandbox denied the
	 * connection, even with the OS sandbox completely disabled. See
	 * `_run_self_test`'s docstring in repl_driver.py for the full reasoning.
	 */
	private async runSelfTest(): Promise<void> {
		this.send({ type: "self_test" });
		let message: DriverMessage;
		try {
			message = await this.withStepTimeout(
				this.nextMessage(),
				this.stepTimeoutMs > 0 ? Math.max(this.stepTimeoutMs, MIN_SELF_TEST_TIMEOUT_MS) : 0,
			);
		} catch (err) {
			throw new RlmSandboxViolationError(
				"RlmSession: OS-level sandbox startup self-test did not complete " +
					`(refusing to run -- fail-closed): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const networkBlocked = message.type === "self_test_result" && message.networkBlocked === true;
		const fileReadBlocked = message.type === "self_test_result" && message.fileReadBlocked === true;
		if (!networkBlocked || !fileReadBlocked) {
			const error = new RlmSandboxViolationError(
				"RlmSession: OS-level sandbox startup self-test failed -- the sandbox is not confining this " +
					`process (networkBlocked=${networkBlocked}, fileReadBlocked=${fileReadBlocked}, ` +
					`response=${JSON.stringify(message)}). Refusing to run rather than executing unconfined ` +
					"root-LLM-authored code (fail-closed).",
			);
			this.killAndTerminate(error);
			throw error;
		}
	}

	private resolveFinal(final: DriverFinalPayload): unknown {
		if (final.kind === "value") {
			// FINAL(answer) already sent `str(answer)` -- use as-is.
			return final.value;
		}
		// FINAL_VAR(name) sent `repr(globals_dict[name])`. Parse it back into a
		// real JS value for JSON-safe types; fall back to the raw repr string
		// for anything else. See `pythonReprToValue`'s doc comment for why.
		return pythonReprToValue(final.value);
	}

	/** One root-LLM turn: get code, exec it, append history, may resolve a final. */
	async step(): Promise<RlmHistoryEntry> {
		await this.ready;
		// Pre-dispatch cost budget check (Phase 28 Architecture section 6,
		// R28-SBX.5) -- before the root LLM is even asked for this step's code,
		// not just before a sub-call within it.
		this.checkCostBudget();
		const response = await this.opts.rootLlm(this.history.slice());
		const code = extractPythonCode(response);
		const result = await this.runExec(code);
		const entry: RlmHistoryEntry = {
			step: this.history.length + 1,
			code,
			// Already capped+marked incrementally by the driver's
			// `_TruncatingStdout` (Phase 28 Architecture section 5) -- no
			// second Node-side truncation pass here (Phase 26's original
			// post-hoc `truncateStdout` call is exactly the OOM-via-print gap
			// this phase closes; re-applying it here on top of the driver's
			// own `[truncated N chars]` marker would risk mangling it).
			truncatedStdout: result.stdout,
			error: result.error ?? null,
			timestamp: new Date().toISOString(),
		};
		this.history.push(entry);
		this.lastFinal = result.final ?? null;
		return entry;
	}

	/** Loops `step()` until a FINAL/FINAL_VAR, `maxIterations`, or an unrecoverable driver error. */
	async run(): Promise<RlmResult> {
		try {
			while (this.history.length < this.maxIterations) {
				await this.step();
				if (this.lastFinal) {
					const final = this.lastFinal;
					return {
						kind: final.kind === "var" ? "final_var" : "final",
						value: this.resolveFinal(final),
						steps: this.history.length,
						history: this.history.slice(),
					};
				}
			}
			return { kind: "max_iterations", steps: this.history.length, history: this.history.slice() };
		} catch (err) {
			// Typed stop reasons (Phase 28 Architecture section 6, R28-SBX.6):
			// a hard-killed step surfaces here as one of these internal error
			// classes; anything else (a genuine driver crash, a step
			// referencing llm_query with no callback configured, etc.) falls
			// through to the generic "error" kind, same as Phase 26.
			if (err instanceof RlmStepTimeoutError) {
				return {
					kind: "timeout",
					value: err.message,
					steps: this.history.length,
					history: this.history.slice(),
				};
			}
			if (err instanceof RlmBudgetExhaustedError) {
				return {
					kind: "budget_exhausted",
					value: err.message,
					steps: this.history.length,
					history: this.history.slice(),
				};
			}
			if (err instanceof RlmSandboxViolationError) {
				return {
					kind: "sandbox_violation",
					value: err.message,
					steps: this.history.length,
					history: this.history.slice(),
				};
			}
			return {
				kind: "error",
				value: err instanceof Error ? err.message : String(err),
				steps: this.history.length,
				history: this.history.slice(),
			};
		}
	}

	/** Kills the underlying python3 subprocess and removes its scratch workdir. Safe to call more than once. */
	dispose(): void {
		this.markTerminated(new Error("RlmSession: disposed"));
		this.child.stdin?.end();
		this.child.kill();
		try {
			rmSync(this.workdir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup only -- a leftover empty-ish tmp dir isn't
			// worth failing dispose() over.
		}
	}
}
