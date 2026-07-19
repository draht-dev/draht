import type { Api, Model } from "@draht/ai/compat";

const OPENAI_STANDARD_CONTEXT_WINDOW = 272000;
const OPENAI_CODEX_STANDARD_CONTEXT_WINDOW = 372000;
const OPENAI_EXTENDED_CONTEXT_WINDOW = 1050000;
const OPENAI_GPT_56_MODEL_IDS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
const OPENAI_EXTENDED_CONTEXT_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.5", ...OPENAI_GPT_56_MODEL_IDS]);

/** Return the context-window sizes that draht can safely select for a model. */
export function getAvailableContextWindows<TApi extends Api>(model: Model<TApi>): number[] {
	let windows: number[];
	if (model.provider === "openai" && OPENAI_EXTENDED_CONTEXT_MODEL_IDS.has(model.id)) {
		windows = [OPENAI_STANDARD_CONTEXT_WINDOW, OPENAI_EXTENDED_CONTEXT_WINDOW];
	} else if (model.provider === "openai-codex" && OPENAI_GPT_56_MODEL_IDS.has(model.id)) {
		windows = [OPENAI_CODEX_STANDARD_CONTEXT_WINDOW, OPENAI_EXTENDED_CONTEXT_WINDOW];
	} else {
		windows = [model.contextWindow];
	}

	return [...new Set([...windows, model.contextWindow])].filter((value) => value > 0).sort((a, b) => a - b);
}

/** Apply a saved context window only when it is still supported by the current model catalog. */
export function applyContextWindow<TApi extends Api>(
	model: Model<TApi>,
	contextWindow: number | undefined,
): Model<TApi> {
	if (contextWindow === undefined || contextWindow === model.contextWindow) return model;
	if (!getAvailableContextWindows(model).includes(contextWindow)) return model;
	return { ...model, contextWindow };
}

export function formatContextWindow(contextWindow: number): string {
	if (contextWindow < 1000) return contextWindow.toString();
	if (contextWindow < 1000000) return `${Math.round(contextWindow / 1000)}k`;
	return `${Number((contextWindow / 1000000).toFixed(2))}M`;
}
