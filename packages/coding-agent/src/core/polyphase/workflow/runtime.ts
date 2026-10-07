/**
 * Runs a workflow script's prelude plus body in a `CodemodeSandbox` (DESIGN.md §13.4).
 *
 * The sandbox evaluates `(async (tools, console) => {<prelude><body>\n})` as `codemode.js`
 * (packages/codemode/src/runtime/worker.ts). Since the prelude is one line, a script error on
 * body line 1 is reported at `codemode.js:1:C` with `C` past the wrapper prefix and the prelude;
 * errors on later body lines report their real line number unchanged.
 */

import type { JsonObject, JsonValue } from "@draht/ai";
import {
	type CodemodeError,
	type CodemodeErrorKind,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	type CodemodeWasmModule,
	loadQuickJSWasm,
} from "@draht/codemode";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../../config.ts";
import type { WorkflowMeta } from "./meta.ts";
import { buildWorkflowPrelude, PHASE_MAX_CHARS } from "./prelude.ts";

export interface WorkflowAgentRequest {
	prompt: string;
	label?: string;
	phase?: string;
	schema?: JsonObject;
	model?: string;
	effort?: string;
	isolation?: "worktree";
	agentType?: string;
}

export type WorkflowAgentReply =
	| { kind: "value"; value: JsonValue }
	| { kind: "null"; reason: "failed" | "cancelled" | "budget" | "no-structured-output"; message?: string }
	| { kind: "error"; message: string };

export interface WorkflowHost {
	runAgent(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReply>;
	onPhase(title: string): number;
	onLog(text: string, level: "info" | "warning"): void;
	spentTokens(): number;
}

export interface WorkflowRunSpec {
	meta: WorkflowMeta;
	body: string;
	args: string;
	budgetTokens: number | null;
	maxAgents: number;
	maxItemsPerCall: number;
	/** 0 or `Infinity` disables the deadline. */
	timeoutMs: number;
	/** Default 256 MiB. */
	memoryLimitBytes?: number;
	/** Default 1,000,000 (the result text keeps only the first/last 8000 console characters anyway). */
	maxOutputChars?: number;
	signal: AbortSignal;
	host: WorkflowHost;
	sandbox?: { wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>; workerUrl?: string | URL };
}

export interface WorkflowScriptError {
	kind: CodemodeErrorKind;
	message: string;
	line?: number;
	column?: number;
	stack?: string;
	hint?: string;
}

export type WorkflowOutcome =
	| { ok: true; value: JsonValue | undefined; consoleOutput: string[]; agentCalls: number }
	| { ok: false; error: WorkflowScriptError; consoleOutput: string[]; agentCalls: number };

const DEFAULT_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/**
 * `memoryLimitBytes` only bounds the QuickJS heap; nothing else stops a script from calling
 * `console.log`/`text()`/`image()` in a loop and growing the host process's memory without bound
 * (every output item is kept in `CodemodeResult.output` for the life of the run). The result text
 * keeps only the first/last 8000 console characters (`result-text.ts`), so this cap is generous
 * relative to what ever reaches the user.
 */
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

/** Prefix the worker wraps the full source in; see worker.ts:146. */
const WRAPPER_PREFIX_LENGTH = "(async (tools, console) => {".length;
/**
 * Anchored to frame lines (`    at ... (codemode.js:L:C)`, see sandbox.test.ts) rather than
 * matching anywhere in the stack: the stack's first line is `Name: message`, and a script or
 * agent-reply error message can itself contain text that looks like `codemode.js:L:C` (a host
 * error string, or a user-thrown message), which would otherwise be mistaken for the real frame.
 */
const FRAME_PATTERN = /^[ \t]*at .*codemode\.js:(\d+):(\d+)/gm;
const REDECLARATION_PATTERN = /redefinition|redeclar|already been declared/i;
const REDECLARATION_HINT = "do not redeclare agent, parallel, pipeline, phase, log, args, budget or meta";

const PROMPT_MAX_CHARS = 200_000;
const LABEL_MAX_CHARS = 80;
const SCHEMA_MAX_JSON_CHARS = 65_536;
const MODEL_MAX_CHARS = 160;
const AGENT_TYPE_PATTERN = /^[\w.-]{1,64}$/;

type AgentGuardResult = { ok: true; value: WorkflowAgentRequest } | { ok: false; error: string };

function guardAgentRequest(raw: unknown): AgentGuardResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "agent() request must be an object" };
	}
	const request = raw as Record<string, unknown>;

	const prompt = request.prompt;
	if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > PROMPT_MAX_CHARS) {
		return { ok: false, error: `agent(): prompt must be a string of 1 to ${PROMPT_MAX_CHARS} characters` };
	}

	const label = request.label;
	if (label !== undefined && (typeof label !== "string" || label.length > LABEL_MAX_CHARS)) {
		return { ok: false, error: `agent(): label must be a string of at most ${LABEL_MAX_CHARS} characters` };
	}

	const phase = request.phase;
	if (phase !== undefined && (typeof phase !== "string" || phase.length > PHASE_MAX_CHARS)) {
		return { ok: false, error: `agent(): phase must be a string of at most ${PHASE_MAX_CHARS} characters` };
	}

	const schema = request.schema;
	if (schema !== undefined) {
		if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
			return { ok: false, error: "agent(): schema must be an object" };
		}
		let json: string;
		try {
			json = JSON.stringify(schema);
		} catch {
			return { ok: false, error: "agent(): schema must be JSON-serializable" };
		}
		if (json.length > SCHEMA_MAX_JSON_CHARS) {
			return { ok: false, error: `agent(): schema must be at most ${SCHEMA_MAX_JSON_CHARS} JSON characters` };
		}
	}

	const model = request.model;
	if (model !== undefined && (typeof model !== "string" || model.length > MODEL_MAX_CHARS)) {
		return { ok: false, error: `agent(): model must be a string of at most ${MODEL_MAX_CHARS} characters` };
	}

	const effort = request.effort;
	if (effort !== undefined && typeof effort !== "string") {
		return { ok: false, error: "agent(): effort must be a string" };
	}

	const isolation = request.isolation;
	if (isolation !== undefined && isolation !== "worktree") {
		return { ok: false, error: 'agent(): isolation must be "worktree"' };
	}

	const agentType = request.agentType;
	if (agentType !== undefined && (typeof agentType !== "string" || !AGENT_TYPE_PATTERN.test(agentType))) {
		return { ok: false, error: "agent(): agentType must match /^[\\w.-]{1,64}$/" };
	}

	return {
		ok: true,
		value: {
			prompt,
			label: label as string | undefined,
			phase: phase as string | undefined,
			schema: schema as JsonObject | undefined,
			model: model as string | undefined,
			effort: effort as string | undefined,
			isolation: isolation as "worktree" | undefined,
			agentType: agentType as string | undefined,
		},
	};
}

function mapAgentReply(reply: WorkflowAgentReply, spent: number): JsonValue {
	if (reply.kind === "value") return { ok: true, value: reply.value, spent };
	if (reply.kind === "null") return { ok: true, value: null, spent };
	return { ok: false, error: reply.message ?? "agent failed", spent };
}

function extractLocation(stack: string | undefined, preludeLength: number): { line?: number; column?: number } {
	if (!stack) return {};
	const threshold = WRAPPER_PREFIX_LENGTH + preludeLength;
	for (const match of stack.matchAll(FRAME_PATTERN)) {
		const line = Number(match[1]);
		const column = Number(match[2]);
		if (line > 1 || column > threshold) return { line, column: line === 1 ? column - threshold : column };
	}
	return {};
}

function toScriptError(error: CodemodeError, preludeLength: number): WorkflowScriptError {
	if (error.kind !== "script") {
		return { kind: error.kind, message: error.message, stack: error.stack };
	}
	const { line, column } = extractLocation(error.stack, preludeLength);
	const hint =
		error.name === "SyntaxError" && REDECLARATION_PATTERN.test(error.message) ? REDECLARATION_HINT : undefined;
	return { kind: "script", message: error.message, line, column, stack: error.stack, hint };
}

function toOutcome(result: CodemodeResult, preludeLength: number, agentCalls: number): WorkflowOutcome {
	const consoleOutput = result.output.filter((item) => item.type === "text").map((item) => item.text);
	if (result.ok) {
		return { ok: true, value: result.value as JsonValue | undefined, consoleOutput, agentCalls };
	}
	return { ok: false, error: toScriptError(result.error, preludeLength), consoleOutput, agentCalls };
}

export async function runWorkflowScript(spec: WorkflowRunSpec): Promise<WorkflowOutcome> {
	const prelude = buildWorkflowPrelude({
		meta: spec.meta,
		args: spec.args,
		budgetTokens: spec.budgetTokens,
		maxItemsPerCall: spec.maxItemsPerCall,
	});

	// A non-finite maxAgents (NaN from a malformed setting, Infinity) must not silently disable the
	// cap for the wrong reason: `agentCalls >= NaN` is always false, same effect as "no cap" but by
	// accident rather than by a documented "unlimited" value.
	const maxAgents = Number.isFinite(spec.maxAgents)
		? Math.max(0, Math.floor(spec.maxAgents))
		: Number.MAX_SAFE_INTEGER;

	// `agentCalls` counts agents actually dispatched to the host (DESIGN.md §13.4 "count accepted
	// requests"); a request rejected by the cap never reaches `host.runAgent` and is not counted.
	let agentCalls = 0;
	const agentGlobal: CodemodeTool = {
		name: "__polyphase.agent",
		execute: async (rawArgs, { signal }) => {
			const guarded = guardAgentRequest(rawArgs);
			if (!guarded.ok) {
				return { ok: false, error: guarded.error, spent: spec.host.spentTokens() };
			}
			if (agentCalls >= maxAgents) {
				return {
					ok: false,
					error: `agent cap reached: a workflow may start at most ${maxAgents} agents (polyphase.maxAgentsPerRun)`,
					spent: spec.host.spentTokens(),
				};
			}
			agentCalls++;
			let reply: WorkflowAgentReply;
			try {
				reply = await spec.host.runAgent(guarded.value, signal);
			} catch (error) {
				// A rejection must still flow through the normal `{ok:false}` reply path below, or
				// the prelude's `agent()` never runs its call-site stack rewrite (its `if (!reply.ok)`
				// branch is skipped entirely when `await __polyphase.agent(...)` itself throws) and
				// `__polyphaseSpent` is never updated from this call.
				reply = { kind: "error", message: error instanceof Error ? error.message : String(error) };
			}
			return mapAgentReply(reply, spec.host.spentTokens());
		},
	};
	const phaseGlobal: CodemodeTool = {
		name: "__polyphase.phase",
		execute: (title) => {
			if (typeof title !== "string" || title.trim() === "") {
				throw new Error("phase(title) needs a non-empty string");
			}
			if (title.length > PHASE_MAX_CHARS) {
				throw new Error(`phase(title) needs a non-empty string of at most ${PHASE_MAX_CHARS} characters`);
			}
			return spec.host.onPhase(title);
		},
	};
	const logGlobal: CodemodeTool = {
		name: "__polyphase.log",
		spread: true,
		execute: (rawArgs) => {
			const args = Array.isArray(rawArgs) ? rawArgs : [];
			const [first, second]: [unknown, unknown] = [args[0], args[1]];
			const text = typeof first === "string" ? first : String(first);
			spec.host.onLog(text, second === "warning" ? "warning" : "info");
		},
	};

	const sandbox = new CodemodeSandbox({
		globals: [agentGlobal, phaseGlobal, logGlobal],
		timeoutMs: spec.timeoutMs > 0 ? spec.timeoutMs : Number.POSITIVE_INFINITY,
		memoryLimitBytes: spec.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
		maxOutputChars: spec.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
		wasm: spec.sandbox?.wasm ?? loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: spec.sandbox?.workerUrl ?? getCodemodeWorkerSpecifier(),
	});

	try {
		const result = await sandbox.execute(prelude + spec.body, { signal: spec.signal });
		return toOutcome(result, prelude.length, agentCalls);
	} finally {
		await sandbox.close();
	}
}
