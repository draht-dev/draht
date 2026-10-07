/**
 * Spawns and supervises one child draht process for a subagent/workflow run (§7.1-7.4).
 *
 * `buildChildInvocation` and `resolveDrahtCommand` are pure; `runChildAgent` owns every
 * side effect (temp files, spawn, line reading, abort escalation) and never rejects.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonObject, JsonValue } from "@draht/ai";
import { validateToolArguments } from "@draht/ai";
import type { TSchema } from "typebox";
import { isBunBinary } from "../../config.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import {
	ChildEventReducer,
	type ChildExit,
	type ChildFinish,
	type ChildWireRecord,
	parseChildLine,
	summarizeToolArgs,
	toRunResult,
} from "./child-events.ts";
import { attachChildLineReader } from "./jsonl-reader.ts";
import {
	type AgentConfig,
	type AgentRunContext,
	type AgentRunner,
	currentPolyphaseDepth,
	DUET_DELEGATE_TOOL_NAME,
	POLYPHASE_DEPTH_ENV,
	POLYPHASE_RESULT_TOOL_NAME,
	POLYPHASE_SCHEMA_FILE_ENV,
	type ProgressFn,
	type RunResult,
	type TranscriptItem,
	WORKFLOW_TOOL_NAME,
} from "./types.ts";

const DEFAULT_KILL_GRACE_MS = 5000;
const LEGACY_TOOL_SUMMARY_MAX_CHARS = 60;
const LEGACY_TEXT_PROGRESS_MAX_CHARS = 80;
const INSPECT_OR_DEBUG_FLAG = /^--(?:inspect|debug)/;
const STRUCTURED_OUTPUT_NOTICE_MAX_CHARS = 200;

export interface ChildCommand {
	bin: string;
	argsPrefix: readonly string[];
}

/**
 * Bun binary: `{execPath, []}`. Otherwise `{execPath, [...execArgv without --inspect*
 * and --debug*, argv[1]]}`, which keeps tsx (and other loader-based dev runs) working in children.
 */
export function resolveDrahtCommand(): ChildCommand {
	if (isBunBinary) return { bin: process.execPath, argsPrefix: [] };
	const execArgv = process.execArgv.filter((arg) => !INSPECT_OR_DEBUG_FLAG.test(arg));
	return { bin: process.execPath, argsPrefix: [...execArgv, process.argv[1]] };
}

export interface ChildSpawnSpec {
	cwd: string;
	agent: AgentConfig;
	task: string;
	step?: number;
	run?: AgentRunContext;
	signal?: AbortSignal;
	onProgress?: ProgressFn;
	command?: ChildCommand;
	/** Grace period between SIGTERM and SIGKILL-via-tree on abort. Default 5000. */
	killGraceMs?: number;
	baseEnv?: NodeJS.ProcessEnv;
}

/** Pure: computes argv and env for one spawn. `files` are temp paths already written by the caller. */
export function buildChildInvocation(
	spec: ChildSpawnSpec,
	files: { systemPromptFile?: string; schemaFile?: string },
	options?: { omitModel?: boolean },
): { args: string[]; env: NodeJS.ProcessEnv } {
	const { agent, run } = spec;
	const omitModel = options?.omitModel ?? false;
	const args: string[] = ["--mode", "json", "-p", "--no-session"];

	const model = run?.model ?? agent.model;
	if (!omitModel && model) args.push("--model", model);
	if (!omitModel && run?.thinking) args.push("--thinking", run.thinking);

	if (agent.tools?.length) {
		const tools = [...agent.tools, ...(run?.extraTools ?? [])];
		args.push("--tools", tools.join(","));
	}

	if (agent.disableExtensions) args.push("--no-extensions");

	const excludeTools = [WORKFLOW_TOOL_NAME, DUET_DELEGATE_TOOL_NAME, ...(run?.excludeTools ?? [])];
	args.push("--exclude-tools", [...new Set(excludeTools)].join(","));

	if (files.systemPromptFile) args.push("--append-system-prompt", files.systemPromptFile);

	const baseEnv = spec.baseEnv ?? process.env;
	const env: NodeJS.ProcessEnv = { ...baseEnv, ...(run?.env ?? {}) };
	env[POLYPHASE_DEPTH_ENV] = String(currentPolyphaseDepth(baseEnv) + 1);
	if (files.schemaFile) {
		env[POLYPHASE_SCHEMA_FILE_ENV] = files.schemaFile;
	} else {
		delete env[POLYPHASE_SCHEMA_FILE_ENV];
	}

	return { args, env };
}

function truncateProgress(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Legacy `onProgress` strings duet relies on: a short line on every tool start, and one line for
 * the first delta of each new text item (a cheap "what is it writing" signal, not a transcript).
 */
function legacyProgressText(record: ChildWireRecord, pendingFirstDelta: Set<number>): string | undefined {
	if (record.type === "tool_execution_start") {
		const summary = truncateProgress(
			summarizeToolArgs(record.toolName, record.args as JsonValue | undefined),
			LEGACY_TOOL_SUMMARY_MAX_CHARS,
		);
		return summary ? `${record.toolName} ${summary}` : record.toolName;
	}
	if (record.type === "message_update") {
		const event = record.assistantMessageEvent;
		if (event.type === "text_start") {
			pendingFirstDelta.add(event.contentIndex);
			return undefined;
		}
		if (event.type === "text_delta" && pendingFirstDelta.delete(event.contentIndex)) {
			const firstLine = event.delta.split("\n")[0] ?? "";
			return truncateProgress(firstLine, LEGACY_TEXT_PROGRESS_MAX_CHARS);
		}
	}
	return undefined;
}

interface SpawnAttemptResult {
	exit: ChildExit;
	finish: ChildFinish;
}

/** One spawn: wires the line reader, stderr tail, abort escalation, and resolves via `reducer.finish`. */
function spawnAttempt(
	spec: ChildSpawnSpec,
	command: ChildCommand,
	reducer: ChildEventReducer,
	files: { systemPromptFile?: string; schemaFile?: string },
	options: { omitModel?: boolean },
): Promise<SpawnAttemptResult> {
	const killGraceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	const { args, env } = buildChildInvocation(spec, files, options);

	return new Promise<SpawnAttemptResult>((resolve) => {
		let settled = false;
		let closed = false;
		let killTimer: NodeJS.Timeout | undefined;
		let proc: ChildProcessWithoutNullStreams;

		const finishOnce = (exit: ChildExit) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (spec.signal) spec.signal.removeEventListener("abort", onAbort);
			resolve({ exit, finish: reducer.finish(exit) });
		};

		function onAbort(): void {
			if (settled) return;
			try {
				proc.kill("SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				if (!closed && proc.pid !== undefined) killProcessTree(proc.pid);
			}, killGraceMs);
			killTimer.unref();
		}

		try {
			proc = spawn(command.bin, [...command.argsPrefix, ...args], {
				cwd: spec.cwd,
				env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			finishOnce({
				code: null,
				signal: null,
				cancelled: spec.signal?.aborted === true,
				spawnError: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const pid = proc.pid;
		if (pid !== undefined) trackDetachedChildPid(pid);
		try {
			spec.run?.onStart?.({ pid, argv: args });
		} catch {
			// A throwing onStart must not cut this executor short: the stdin/stdout/stderr wiring and
			// close/error handlers below still need to run, or this child would keep running with
			// nothing left to supervise it (never settling, never killed on abort).
		}

		proc.stdin.on("error", () => {});
		proc.stdin.end(`Task: ${spec.task}`);

		const forward = (change: ReturnType<ChildEventReducer["apply"]>) => {
			if (change !== "none") spec.run?.onChange?.(change);
		};
		const pendingFirstDelta = new Set<number>();
		attachChildLineReader(
			proc.stdout,
			(line) => {
				const record = parseChildLine(line);
				if (!record) return;
				forward(reducer.apply(record));
				const progress = legacyProgressText(record, pendingFirstDelta);
				if (progress) spec.onProgress?.(progress);
			},
			{
				onSkipped: (prefix) => {
					if (prefix.includes("tool_execution_update")) forward(reducer.noteHeartbeat());
				},
			},
		);

		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => reducer.noteStderr(chunk));

		if (spec.signal) {
			if (spec.signal.aborted) onAbort();
			else spec.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("error", (error) => {
			closed = true;
			finishOnce({
				code: null,
				signal: null,
				cancelled: spec.signal?.aborted === true,
				spawnError: error.message,
			});
		});

		proc.on("close", (code, signal) => {
			closed = true;
			if (pid !== undefined) untrackDetachedChildPid(pid);
			finishOnce({ code, signal, cancelled: spec.signal?.aborted === true });
		});
	});
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * §7.4: extracts the per-field errors from `validateToolArguments`'s formatted message (one
 * `  - path: message` line per failing field, then a blank line and "Received arguments:"),
 * joins them onto one line, and caps the result. Any other error (e.g. "structured output must
 * be a JSON object") has no such lines and is passed through as its own (single-line) message.
 */
export function formatStructuredOutputError(rawMessage: string): string {
	const [body] = rawMessage.split("\n\nReceived arguments:");
	const lines = (body ?? rawMessage).split("\n");
	const fieldErrors = lines
		.slice(1)
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.filter((line) => line.length > 0);
	const detail = fieldErrors.length > 0 ? fieldErrors.join("; ") : (lines[0] ?? rawMessage);
	return truncateProgress(detail.replace(/\s+/g, " ").trim(), STRUCTURED_OUTPUT_NOTICE_MAX_CHARS);
}

/**
 * ChildEventReducer exposes no public "add a notice" API (pushNotice and bump are private, with
 * no exported hook for callers outside the class). This pushes the item directly, then reuses
 * the public `trimForRetention` pass with an unreachable budget, which recomputes
 * `transcriptChars` from scratch and bumps `version`/`coarseVersion` without evicting anything,
 * so version-keyed consumers (render caches, store) observe the change. Passing the run's
 * post-finish budget here would trim the whole live transcript down to that size as a side
 * effect, which is the store's job at `finish()` (§8.3 retention), not this mid-run notice's.
 * Always "coarse", since `trimForRetention` always bumps coarse.
 */
export function recordReducerNotice(
	reducer: ChildEventReducer,
	level: "info" | "warning" | "error",
	text: string,
): "coarse" {
	const item: TranscriptItem = { kind: "notice", seq: reducer.state.nextSeq++, rev: 1, level, text, at: Date.now() };
	reducer.state.transcript.push(item);
	reducer.trimForRetention(Number.POSITIVE_INFINITY);
	return "coarse";
}

const REDOS_SCHEMA_KEYWORDS = new Set(["pattern", "patternProperties"]);

/**
 * Deep-clones `schema`, dropping every `pattern`/`patternProperties` keyword at any depth. A
 * workflow script controls `schema` end to end (§guardAgentRequest only caps its JSON size), so a
 * crafted `pattern` such as `"^(a+)+$"` paired with a near-matching structured-output value makes
 * `validateToolArguments` backtrack exponentially. The child already validated the same value
 * against the *full* schema (including any `pattern`) before this parent-side re-validation runs,
 * so dropping regex keywords here only removes a redundant, attacker-triggerable check — it does
 * not let a value through the child missed.
 */
function stripRegexSchemaKeywords(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(stripRegexSchemaKeywords);
	if (typeof value === "object" && value !== null) {
		const result: JsonObject = {};
		for (const [key, child] of Object.entries(value)) {
			if (REDOS_SCHEMA_KEYWORDS.has(key)) continue;
			result[key] = stripRegexSchemaKeywords(child);
		}
		return result;
	}
	return value;
}

/** §7.4: validate `state.structured` against `run.schema`, mutating the reducer's public state in place. */
export function validateStructuredOutput(
	reducer: ChildEventReducer,
	schema: JsonObject,
	onChange?: (change: "fine" | "coarse") => void,
): void {
	const pending = reducer.state.structured;
	if (!pending) return;
	try {
		if (!isJsonObjectValue(pending.value)) throw new Error("structured output must be a JSON object");
		const safeSchema = stripRegexSchemaKeywords(schema) as JsonObject;
		const validated = validateToolArguments(
			{ name: POLYPHASE_RESULT_TOOL_NAME, description: "", parameters: safeSchema as unknown as TSchema },
			{ type: "toolCall", id: "result", name: POLYPHASE_RESULT_TOOL_NAME, arguments: pending.value },
		);
		reducer.state.structured = { value: validated as JsonValue };
	} catch (error) {
		reducer.state.structured = undefined;
		const rawMessage = error instanceof Error ? error.message : String(error);
		const message = formatStructuredOutputError(rawMessage);
		const change = recordReducerNotice(reducer, "warning", `structured output invalid: ${message}`);
		onChange?.(change);
	}
}

/** §7.3: re-spawn once without `--model`/`--thinking` when the inherited model could not be resolved. */
function shouldFallbackToChildDefault(
	spec: ChildSpawnSpec,
	reducer: ChildEventReducer,
	result: SpawnAttemptResult,
): boolean {
	return (
		spec.run?.fallbackToChildDefaultModel === true &&
		!result.exit.cancelled &&
		result.finish.exitCode !== 0 &&
		reducer.state.recordsSeen === 0 &&
		/model/i.test(reducer.state.stderrTail)
	);
}

/** Writes the appended-system-prompt and polyphase_result schema temp files, then runs §7.2-7.4. */
async function runInTempDir(spec: ChildSpawnSpec, tempDir: string, reducer: ChildEventReducer): Promise<RunResult> {
	const combinedPrompt = `${spec.agent.systemPrompt}\n\n${spec.run?.extraSystemPrompt ?? ""}`;
	let systemPromptFile: string | undefined;
	if (combinedPrompt.trim().length > 0) {
		systemPromptFile = path.join(tempDir, "prompt.md");
		fs.writeFileSync(systemPromptFile, combinedPrompt, { encoding: "utf-8", mode: 0o600 });
	}

	let schemaFile: string | undefined;
	if (spec.run?.schema) {
		schemaFile = path.join(tempDir, "schema.json");
		fs.writeFileSync(schemaFile, JSON.stringify(spec.run.schema), { encoding: "utf-8", mode: 0o600 });
	}

	const files = { systemPromptFile, schemaFile };
	const command = spec.command ?? resolveDrahtCommand();

	reducer.markSpawning();
	const start = Date.now();
	let result = await spawnAttempt(spec, command, reducer, files, {});

	if (shouldFallbackToChildDefault(spec, reducer, result)) {
		const requested = spec.run?.model ?? spec.agent.model ?? "";
		reducer.resetForRetry(
			{ source: "child-default", confirmed: false },
			`inherited model ${requested} is unavailable in the child; using the child's default model`,
		);
		result = await spawnAttempt(spec, command, reducer, files, { omitModel: true });
	}

	if (spec.run?.schema) validateStructuredOutput(reducer, spec.run.schema, spec.run?.onChange);

	return toRunResult(reducer.state, { agent: spec.agent.name, task: spec.task, step: spec.step }, result.finish, {
		cancelled: result.exit.cancelled,
		structured: reducer.state.structured,
		durationMs: Date.now() - start,
	});
}

function createReducerForSpec(spec: ChildSpawnSpec): ChildEventReducer {
	return (
		spec.run?.reducer ??
		new ChildEventReducer({
			model: spec.run?.modelInfo ?? {
				source: spec.agent.model ? "frontmatter" : "child-default",
				requested: spec.agent.model,
				confirmed: false,
			},
		})
	);
}

/** Never rejects: spawn and runtime failures resolve as a failed `RunResult`. */
export async function runChildAgent(spec: ChildSpawnSpec): Promise<RunResult> {
	const reducer = createReducerForSpec(spec);
	const base = { agent: spec.agent.name, task: spec.task, step: spec.step };
	const attemptStart = Date.now();

	if (spec.signal?.aborted) {
		const finish = reducer.finish({ code: null, signal: null, cancelled: true });
		return toRunResult(reducer.state, base, finish, {
			cancelled: true,
			durationMs: Date.now() - attemptStart,
		});
	}

	let tempDir: string | undefined;
	try {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-polyphase-"));
		return await runInTempDir(spec, tempDir, reducer);
	} catch (error) {
		const cancelled = spec.signal?.aborted === true;
		const finish = reducer.finish({
			code: null,
			signal: null,
			cancelled,
			spawnError: error instanceof Error ? error.message : String(error),
		});
		return toRunResult(reducer.state, base, finish, { cancelled, durationMs: Date.now() - attemptStart });
	} finally {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
	}
}

export function createProcessAgentRunner(command?: ChildCommand): AgentRunner {
	return (cwd, agent, task, signal, step, onProgress, run) =>
		runChildAgent({ cwd, agent, task, step, run, signal, onProgress, command });
}
