import { loadConfig } from "./config.js";
import { ModelRouter } from "./router.js";
import type { ModelRef, RouterRole } from "./types.js";

/**
 * Task type to role mapping for automatic model selection.
 */
const TASK_TYPE_TO_ROLE: Record<string, RouterRole> = {
	planning: "architect",
	architecture: "architect",
	implementation: "implement",
	coding: "implement",
	scaffold: "boilerplate",
	boilerplate: "boilerplate",
	question: "quick",
	quick: "quick",
	review: "review",
	"pr-review": "review",
	documentation: "docs",
	readme: "docs",
};

/**
 * Coding agent extension for automatic model selection based on task type.
 */
export function createRouterExtension() {
	const config = loadConfig();
	const router = new ModelRouter(config);

	return {
		name: "model-router",
		description: "Automatic model selection based on task type",

		/**
		 * Select the best model for a given task type.
		 */
		selectModel(taskType: string): ModelRef {
			const role = TASK_TYPE_TO_ROLE[taskType.toLowerCase()] ?? "implement";
			return router.resolve(role);
		},

		/**
		 * Select model with full fallback chain.
		 */
		selectModelWithFallbacks(taskType: string): ModelRef[] {
			const role = TASK_TYPE_TO_ROLE[taskType.toLowerCase()] ?? "implement";
			return router.resolveWithFallbacks(role);
		},

		/**
		 * Get the router instance for direct usage.
		 */
		getRouter(): ModelRouter {
			return router;
		},
	};
}
