import { loadConfig } from "./config.js";
import { ModelRouter, isRetryableError } from "./router.js";
import type { ModelRef, RouterRole } from "./types.js";

/**
 * Task type to role mapping for automatic model selection.
 */
const TASK_TYPE_TO_ROLE: Record<string, RouterRole> = {
	planning: "architect",
	architecture: "architect",
	design: "architect",
	implementation: "implement",
	coding: "implement",
	feature: "implement",
	bugfix: "implement",
	scaffold: "boilerplate",
	boilerplate: "boilerplate",
	crud: "boilerplate",
	template: "boilerplate",
	question: "quick",
	quick: "quick",
	explain: "quick",
	review: "review",
	"pr-review": "review",
	"code-review": "review",
	documentation: "docs",
	readme: "docs",
	comments: "docs",
};

/**
 * Infer role from task description heuristically.
 */
function inferRole(taskDescription: string): RouterRole {
	const lower = taskDescription.toLowerCase();

	if (lower.includes("architect") || lower.includes("design") || lower.includes("plan")) return "architect";
	if (lower.includes("review") || lower.includes("check") || lower.includes("audit")) return "review";
	if (lower.includes("document") || lower.includes("readme") || lower.includes("comment")) return "docs";
	if (lower.includes("scaffold") || lower.includes("boilerplate") || lower.includes("crud") || lower.includes("template")) return "boilerplate";
	if (lower.includes("what") || lower.includes("how") || lower.includes("why") || lower.includes("explain")) return "quick";

	return "implement"; // default
}

/**
 * Coding agent extension for automatic model selection based on task type.
 * Integrates with @draht/ai's model registry and streaming API.
 */
export function createRouterExtension(sessionId?: string) {
	const config = loadConfig();
	const router = new ModelRouter(config, sessionId);

	return {
		name: "model-router",
		description: "Role-based model routing with automatic fallback",

		/**
		 * Select the best model for a given task type or description.
		 */
		selectModel(taskTypeOrDescription: string): ModelRef {
			const role = TASK_TYPE_TO_ROLE[taskTypeOrDescription.toLowerCase()] ?? inferRole(taskTypeOrDescription);
			return router.resolve(role);
		},

		/**
		 * Select model with full fallback chain.
		 */
		selectModelWithFallbacks(taskTypeOrDescription: string): ModelRef[] {
			const role = TASK_TYPE_TO_ROLE[taskTypeOrDescription.toLowerCase()] ?? inferRole(taskTypeOrDescription);
			return router.resolveWithFallbacks(role);
		},

		/**
		 * Get the router instance for direct streaming usage.
		 */
		getRouter(): ModelRouter {
			return router;
		},

		/**
		 * Check if an error should trigger fallback.
		 */
		shouldFallback: isRetryableError,
	};
}
