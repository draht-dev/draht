/**
 * Router-backed `RlmSession` factory.
 *
 * `RlmSession` (session.ts) takes `rootLlm`/`llmQuery` as injected callbacks
 * -- this module is the production wiring that builds those callbacks on top
 * of `@draht/router`'s `ModelRouter`, selects the right system-prompt tier
 * from the resolved `rlm-root` model's context window (prompts.ts), and logs
 * a cost entry (via `@draht/router`'s `estimateCost`/`logCost`) for every
 * root and sub call, tagged with a single `trajectoryId` shared across the
 * whole session. See .planning/phases/27-sub-llm-integration/27-01-PLAN.md,
 * Architecture section 5.
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@draht/ai/compat";
import type { ModelRouter } from "@draht/router";
import { estimateCost, logCost } from "@draht/router";
import type { PromptVars } from "./prompts.js";
import { renderPrompt, selectTier } from "./prompts.js";
import { RlmSession } from "./session.js";
import type { RlmHistoryEntry } from "./types.js";

/** RLM-specific router roles (see `@draht/router`'s `DEFAULT_CONFIG`). */
type RlmRole = "rlm-root" | "rlm-sub";

export interface CreateRouterBackedSessionOptions {
	/** Becomes the `context` variable inside the REPL (see `RlmSessionOptions.prompt`). */
	prompt: string;
	/**
	 * Router used to resolve models and stream completions for both the
	 * "rlm-root" and "rlm-sub" roles. Caller-supplied so production code
	 * passes a real `ModelRouter` and tests can inject a fake one shaped
	 * like its public API, with no real network calls.
	 */
	router: ModelRouter;
	/** What kind of content `prompt` holds (e.g. "text", "code", "logs", "json"). Default "text". */
	contextType?: string;
	/** Max number of `llm_query` sub-calls advertised to the root LM this session. Default 50. */
	maxSubCallBudget?: number;
	/** Max characters per `llm_query` sub-call prompt advertised to the root LM. Default 12_000. */
	subCallCharBudget?: number;
	/** Passthrough to `logCost`'s `logPath` param; defaults to `.draht/cost-log.jsonl`. */
	costLogPath?: string;
	/** `CostEntry.sessionId` for every cost entry this session logs. Defaults to the generated `trajectoryId`. */
	sessionId?: string;
}

const DEFAULT_CONTEXT_TYPE = "text";
const DEFAULT_MAX_SUB_CALL_BUDGET = 50;
const DEFAULT_SUB_CALL_CHAR_BUDGET = 12_000;

/**
 * Fallback context window used only when the "rlm-root" role's primary
 * model can't be resolved against the `@draht/ai` registry (should not
 * happen with a correctly configured router, but `selectTier` still needs
 * *some* number). 128_000 lands squarely in "coder-mid" -- the safest
 * middle ground between over-terse (frontier) and over-verbose
 * (small-context) prompting when we genuinely don't know the model.
 */
const FALLBACK_ROOT_CONTEXT_WINDOW = 128_000;

/**
 * Splits `totalLength` into near-equal chunks no larger than
 * `chunkCharBudget`, used only to populate the `chunk_lengths` prompt
 * variable with concrete, addable suggestions (not enforced anywhere).
 */
function computeChunkLengths(totalLength: number, chunkCharBudget: number): number[] {
	if (totalLength <= 0 || chunkCharBudget <= 0) return [];
	const numChunks = Math.max(1, Math.ceil(totalLength / chunkCharBudget));
	const base = Math.floor(totalLength / numChunks);
	const remainder = totalLength % numChunks;
	const lengths: number[] = [];
	for (let i = 0; i < numChunks; i++) {
		lengths.push(base + (i < remainder ? 1 : 0));
	}
	return lengths;
}

/** Renders the single user turn sent to the root LM: prior history + what's expected next. */
function buildRootUserTurn(contextTotalLength: number, contextType: string, history: RlmHistoryEntry[]): string {
	const header =
		`A Python REPL is running. The variable \`context\` already holds ${contextTotalLength} ` +
		`characters of ${contextType} content -- follow the system instructions for how to inspect, ` +
		"chunk, and search it, and call FINAL(...)/FINAL_VAR(...) once you have the answer.";

	if (history.length === 0) {
		return `${header}\n\nWrite your first \`\`\`repl fenced code block now.`;
	}

	const steps = history.map((entry) => {
		const lines = [
			`--- step ${entry.step} ---`,
			"```repl",
			entry.code,
			"```",
			`stdout: ${entry.truncatedStdout || "(empty)"}`,
		];
		if (entry.error) lines.push(`error: ${entry.error}`);
		return lines.join("\n");
	});

	return [
		header,
		"",
		"History so far:",
		"",
		...steps,
		"",
		"Continue with the next ```repl fenced code block, or call FINAL/FINAL_VAR if you already have the answer.",
	].join("\n");
}

/** Drains a `streamSimple`-shaped event stream down to its terminal `done`/`error` message. */
async function collectAssistantMessage(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> {
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") {
			final = event.message;
		} else if (event.type === "error") {
			final = event.error;
		}
	}
	if (!final) {
		throw new Error("createRouterBackedSession: router stream ended without a done/error event");
	}
	return final;
}

/** Concatenates every `text` content block of an assistant message (ignores thinking/tool-call blocks). */
function messageText(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/** Computes and appends one `CostEntry` for a completed router call. */
function logRouterCall(
	role: RlmRole,
	message: AssistantMessage,
	trajectoryId: string,
	sessionId: string,
	costLogPath: string | undefined,
): void {
	const reasoningTokens = message.usage.reasoning ?? 0;
	const estimatedCostUsd = estimateCost(
		message.provider,
		message.model,
		message.usage.input,
		message.usage.output,
		reasoningTokens,
	);
	logCost(
		{
			timestamp: new Date().toISOString(),
			role,
			provider: message.provider,
			model: message.model,
			inputTokens: message.usage.input,
			outputTokens: message.usage.output,
			...(reasoningTokens > 0 && { reasoningTokens }),
			estimatedCostUsd,
			sessionId,
			trajectoryId,
		},
		costLogPath,
	);
}

/**
 * Builds a real `@draht/router`-backed `RlmSession`: resolves the "rlm-root"
 * model to pick a prompt tier, renders that tier's system prompt with the
 * real prompt's length/chunk info, and wires `rootLlm`/`llmQuery` to call
 * `router.streamSimple("rlm-root" | "rlm-sub", ...)`, logging a cost entry
 * (tagged with one `trajectoryId` per session) after every call.
 */
export function createRouterBackedSession(opts: CreateRouterBackedSessionOptions): RlmSession {
	const trajectoryId = randomUUID();
	const sessionId = opts.sessionId ?? trajectoryId;
	const contextType = opts.contextType ?? DEFAULT_CONTEXT_TYPE;
	const maxSubCallBudget = opts.maxSubCallBudget ?? DEFAULT_MAX_SUB_CALL_BUDGET;
	const subCallCharBudget = opts.subCallCharBudget ?? DEFAULT_SUB_CALL_CHAR_BUDGET;
	const costLogPath = opts.costLogPath;

	const rootRef = opts.router.resolve("rlm-root");
	const rootModel = opts.router.resolveModel(rootRef);
	const contextWindow = rootModel?.contextWindow ?? FALLBACK_ROOT_CONTEXT_WINDOW;

	const tier = selectTier(contextWindow);
	const contextTotalLength = opts.prompt.length;
	const chunkLengths = computeChunkLengths(contextTotalLength, subCallCharBudget);

	const vars: PromptVars = {
		contextType,
		contextTotalLength,
		chunkLengths,
		maxSubCallBudget,
		subCallCharBudget,
	};
	const systemPrompt = renderPrompt(tier, vars);

	const rootLlm = async (history: RlmHistoryEntry[]): Promise<string> => {
		const context: Context = {
			systemPrompt,
			messages: [
				{
					role: "user",
					content: buildRootUserTurn(contextTotalLength, contextType, history),
					timestamp: Date.now(),
				},
			],
		};
		const message = await collectAssistantMessage(opts.router.streamSimple("rlm-root", context));
		logRouterCall("rlm-root", message, trajectoryId, sessionId, costLogPath);
		return messageText(message);
	};

	const llmQuery = async (prompt: string): Promise<string> => {
		const context: Context = {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};
		const message = await collectAssistantMessage(opts.router.streamSimple("rlm-sub", context));
		logRouterCall("rlm-sub", message, trajectoryId, sessionId, costLogPath);
		return messageText(message);
	};

	return new RlmSession({ prompt: opts.prompt, rootLlm, llmQuery });
}
