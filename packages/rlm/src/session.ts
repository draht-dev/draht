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

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSandboxed } from "./sandbox.js";
import type { RlmHistoryEntry, RlmResult, RlmSessionOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = join(__dirname, "..", "python", "repl_driver.py");

const DEFAULT_MAX_ITERATIONS = 24;
const DEFAULT_STDOUT_TRUNCATE_CHARS = 2000;

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
	private readonly history: RlmHistoryEntry[] = [];
	private readonly ready: Promise<void>;

	private buffer = "";
	private messageQueue: DriverMessage[] = [];
	private waiters: PendingWaiter[] = [];
	private terminated = false;
	private terminationError: Error | null = null;
	private lastFinal: DriverFinalPayload | null = null;

	constructor(private readonly opts: RlmSessionOptions) {
		this.stdoutTruncateChars = opts.stdoutTruncateChars ?? DEFAULT_STDOUT_TRUNCATE_CHARS;
		this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

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

		this.ready = this.seedContext();
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
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(error);
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

	/** Sends one `exec` message and handles any `llm_query_request` round-trips until the matching `exec_result`. */
	private async runExec(code: string): Promise<DriverExecResult> {
		this.send({ type: "exec", code });
		while (true) {
			const message = await this.nextMessage();
			if (message.type === "llm_query_request") {
				const id = message.id as string;
				if (!this.opts.llmQuery) {
					throw new Error(
						"RlmSession: REPL code called llm_query(...) but no `llmQuery` callback was provided in RlmSessionOptions.",
					);
				}
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
		const response = await this.opts.rootLlm(this.history.slice());
		const code = extractPythonCode(response);
		const result = await this.runExec(code);
		const entry: RlmHistoryEntry = {
			step: this.history.length + 1,
			code,
			truncatedStdout: truncateStdout(result.stdout, this.stdoutTruncateChars),
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
