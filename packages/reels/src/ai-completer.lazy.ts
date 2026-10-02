/**
 * Adapts `@draht/ai`'s builtin catalog + env-API-key completion into the
 * {@link ModelCompleter} shape `llmWriter` expects. Kept separate from
 * script.ts so the writer itself stays testable with a stubbed function and
 * never imports a real provider.
 */

import { completeSimple, contentText } from "@draht/ai/compat";
import { builtinModels } from "@draht/ai/providers/all";
import type { ModelCompleter } from "./script.ts";

/** `spec` is `"<provider>/<modelId>"`, e.g. `"anthropic/claude-sonnet-5"`. */
export function createAiModelCompleter(spec: string): ModelCompleter {
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

	return async (prompt: string) => {
		const message = await completeSimple(model, {
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		});
		return contentText(message.content);
	};
}
