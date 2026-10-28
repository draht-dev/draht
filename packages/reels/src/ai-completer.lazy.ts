/**
 * Adapts `@draht/ai`'s builtin catalog + env-API-key completion into the
 * {@link ModelCompleter} shape `llmWriter` and `story-writer.ts` expect. Kept
 * separate from `script.ts` so the writer itself stays testable with a
 * stubbed function and never imports a real provider.
 */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@draht/ai";
import { completeSimple, contentText } from "@draht/ai/compat";
import { builtinModels } from "@draht/ai/providers/all";
import type { ModelCompleter, ModelCompletionRequest, ModelCompletionResult } from "./script.ts";

export interface ModelLimits {
	contextWindow: number;
	maxTokens: number;
}

type CompleteFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;

function resolveModel(spec: string): Model<Api> {
	const slash = spec.indexOf("/");
	if (slash === -1) {
		throw new Error(`--model must be "<provider>/<modelId>", got "${spec}"`);
	}
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1);
	const model = builtinModels().getModel(provider, modelId);
	if (!model) {
		throw new Error(`Unknown model "${spec}". Check the provider and model id.`);
	}
	return model;
}

/**
 * Builds a {@link ModelCompleter} from an already-resolved model, with the
 * actual completion call injectable so it can be tested with a model stub
 * instead of a real provider (see `test/ai-completer.test.ts`).
 */
export function createCompleter(model: Model<Api>, completeFn: CompleteFn = completeSimple): ModelCompleter {
	return async (request: ModelCompletionRequest): Promise<ModelCompletionResult> => {
		const message = await completeFn(
			model,
			{
				systemPrompt: request.systemPrompt,
				messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
			},
			{ maxTokens: request.maxTokens },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(
				`model call failed: ${message.stopReason}${message.errorMessage ? ` ${message.errorMessage}` : ""}`,
			);
		}
		return {
			text: contentText(message.content),
			usage: {
				input: message.usage.input,
				output: message.usage.output,
				costUsd: message.usage.cost.total,
			},
		};
	};
}

/** `spec` is `"<provider>/<modelId>"`, e.g. `"anthropic/claude-sonnet-5"`. */
export function createAiModelCompleter(spec: string): ModelCompleter {
	return createCompleter(resolveModel(spec));
}

/** The model's own context window and max output tokens, for `context.ts`'s budget clamp. */
export function resolveModelLimits(spec: string): ModelLimits {
	const model = resolveModel(spec);
	return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}
