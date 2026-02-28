/**
 * Built-in router roles. Extensible via string type.
 */
export type RouterRole = "architect" | "implement" | "boilerplate" | "quick" | "review" | "docs" | (string & {});

/**
 * Reference to a specific provider/model combination.
 */
export interface ModelRef {
	provider: string;
	model: string;
}

/**
 * Configuration for a single role: primary model + ordered fallback chain.
 */
export interface RoleConfig {
	primary: ModelRef;
	fallbacks: ModelRef[];
}

/**
 * Full router configuration mapping roles to model configs.
 */
export type RouterConfig = Record<string, RoleConfig>;

/**
 * Cost tracking entry written to .draht/cost-log.jsonl.
 */
export interface CostEntry {
	timestamp: string;
	role: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
	sessionId: string;
}

/**
 * Default role→model configuration.
 */
export const DEFAULT_CONFIG: RouterConfig = {
	architect: {
		primary: { provider: "anthropic", model: "claude-opus-4-6" },
		fallbacks: [{ provider: "google", model: "gemini-2.5-pro" }],
	},
	implement: {
		primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
		fallbacks: [
			{ provider: "openai", model: "gpt-5.2" },
			{ provider: "deepseek", model: "deepseek-v3" },
		],
	},
	boilerplate: {
		primary: { provider: "deepseek", model: "deepseek-v3" },
		fallbacks: [{ provider: "google", model: "gemini-2.5-flash" }],
	},
	quick: {
		primary: { provider: "google", model: "gemini-2.5-flash" },
		fallbacks: [{ provider: "deepseek", model: "deepseek-v3" }],
	},
	review: {
		primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
		fallbacks: [],
	},
	docs: {
		primary: { provider: "openai", model: "gpt-5.2" },
		fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
	},
};
