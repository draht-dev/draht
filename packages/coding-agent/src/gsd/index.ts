// GSD index — re-exports all GSD module functions.
// Import from @draht/coding-agent for use in extensions.

export { createDomainModel, mapCodebase } from "./domain.js";
export type { CommitResult } from "./git.js";
export { commitDocs, commitTask, hasTestFiles } from "./git.js";
export type { PhaseVerification, PlanDiscovery } from "./planning.js";
export {
	createPlan,
	discoverPlans,
	readPlan,
	updateState,
	verifyPhase,
	writeSummary,
} from "./planning.js";
