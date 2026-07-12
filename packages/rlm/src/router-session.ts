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
import { appendTrajectoryEntry } from "./trajectory.js";
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
	/**
	 * Directory the trajectory JSONL log (`.draht/rlm/<trajectoryId>.jsonl`)
	 * is written under (Phase 30, `trajectory.ts`). Passed straight through to
	 * `appendTrajectoryEntry`'s `logDir` param; defaults to `.draht/rlm/`.
	 */
	trajectoryLogDir?: string;
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

/** Computes and appends one `CostEntry` for a completed router call, returning its `estimatedCostUsd`. */
function logRouterCall(
	role: RlmRole,
	message: AssistantMessage,
	trajectoryId: string,
	sessionId: string,
	costLogPath: string | undefined,
): number {
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
	return estimatedCostUsd;
}

/** A trajectory step's cost tally, accumulated between one `rootLlm` call and the next. */
interface StepCostAccumulator {
	rootCostUsd: number;
	subCalls: Array<{ costUsd: number; provider: string; model: string }>;
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
	const trajectoryLogDir = opts.trajectoryLogDir;

	// Trajectory JSONL logging (Phase 30, trajectory.ts): `rootLlm` is called
	// once per step, always *before* that step's own `llm_query` sub-calls
	// happen (they occur later, inside the driver's `runExec`, which
	// `session.ts` only invokes after `rootLlm` resolves -- see session.ts's
	// `step()`). So a step's sub-calls always land between one `rootLlm` call
	// and the next, and the simplest correct way to correlate them without
	// touching session.ts's core loop is: accumulate sub-call costs into
	// `pendingStep` as they happen, and finalize+append the *previous* step's
	// `TrajectoryStepEntry` the moment the *next* `rootLlm` call (or the final
	// `run()` resolution, for the very last step) tells us -- via the
	// `history` array it's handed -- that the previous step actually
	// completed.
	let pendingStep: StepCostAccumulator | null = null;
	let finalizedThroughStep = 0;
	let totalCostUsd = 0;

	function finalizeStepIfPending(history: RlmHistoryEntry[]): void {
		if (!pendingStep) return;
		const entry = history[history.length - 1];
		// No new completed entry since the last finalize (e.g. the step that
		// started this accumulator never finished -- a hard-killed/errored
		// step never gets pushed to `history`): nothing to log, and don't
		// double-log the previous step either.
		if (!entry || entry.step <= finalizedThroughStep) return;
		const stepCostUsd = pendingStep.rootCostUsd + pendingStep.subCalls.reduce((sum, sub) => sum + sub.costUsd, 0);
		totalCostUsd += stepCostUsd;
		appendTrajectoryEntry(
			trajectoryId,
			{
				type: "step",
				trajectoryId,
				step: entry.step,
				code: entry.code,
				truncatedStdout: entry.truncatedStdout,
				error: entry.error,
				subCalls: pendingStep.subCalls,
				costUsd: stepCostUsd,
				timestamp: entry.timestamp,
			},
			trajectoryLogDir,
		);
		finalizedThroughStep = entry.step;
		pendingStep = null;
	}

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
		// `history` reflects every step completed *before* this one -- so if a
		// previous step's accumulator is still pending, this call is exactly
		// the signal that it (and only it) has now fully completed (its own
		// root call plus every sub-call it triggered).
		finalizeStepIfPending(history);
		pendingStep = { rootCostUsd: 0, subCalls: [] };
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
		const costUsd = logRouterCall("rlm-root", message, trajectoryId, sessionId, costLogPath);
		pendingStep.rootCostUsd = costUsd;
		return messageText(message);
	};

	const llmQuery = async (prompt: string): Promise<string> => {
		const context: Context = {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};
		const message = await collectAssistantMessage(opts.router.streamSimple("rlm-sub", context));
		const costUsd = logRouterCall("rlm-sub", message, trajectoryId, sessionId, costLogPath);
		// A sub-call always happens after `rootLlm` resolved for the step that
		// triggered it (and before the next `rootLlm` call) -- see session.ts's
		// `step()`/`runExec` -- so `pendingStep` is always the right step to
		// attribute this cost to. `pendingStep` is only ever null before the
		// very first `rootLlm` call, at which point no `llm_query` could have
		// been dispatched yet either.
		pendingStep?.subCalls.push({ costUsd, provider: message.provider, model: message.model });
		return messageText(message);
	};

	const session = new RlmSession({ prompt: opts.prompt, rootLlm, llmQuery });

	// Wrap (not replace the class's core loop -- session.ts is untouched)
	// `run()` so the trajectory's last step and its terminal
	// `TrajectoryFinalEntry` get logged once the whole session resolves.
	// There's no other hook to observe "the session is done" from outside
	// session.ts: `rootLlm` is never called again after the last step, so
	// nothing else would ever finalize that step's accumulator.
	const originalRun = session.run.bind(session);
	session.run = async () => {
		const result = await originalRun();
		finalizeStepIfPending(result.history);
		appendTrajectoryEntry(
			trajectoryId,
			{
				type: "final",
				trajectoryId,
				kind: result.kind,
				value: result.value,
				totalCostUsd,
				totalSteps: result.steps,
				timestamp: new Date().toISOString(),
			},
			trajectoryLogDir,
		);
		return result;
	};

	return session;
}
