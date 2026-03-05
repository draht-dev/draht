// GSD Planning module — phase/plan/task file system operations.
// Stub implementation — tests are expected to FAIL until green phase.

export interface PlanDiscovery {
	plans: Array<{ file: string; deps: string[] }>;
	incomplete: string[];
	fixPlans: string[];
}

export interface PhaseVerification {
	plans: number;
	summaries: number;
	complete: boolean;
}

export function createPlan(_cwd: string, _phaseNum: number, _planNum: number, _title?: string): string {
	throw new Error("not implemented");
}

export function discoverPlans(_cwd: string, _phaseNum: number): PlanDiscovery {
	throw new Error("not implemented");
}

export function readPlan(_cwd: string, _phaseNum: number, _planNum: number): string {
	throw new Error("not implemented");
}

export function writeSummary(_cwd: string, _phaseNum: number, _planNum: number): string {
	throw new Error("not implemented");
}

export function verifyPhase(_cwd: string, _phaseNum: number): PhaseVerification {
	throw new Error("not implemented");
}

export function updateState(_cwd: string): void {
	throw new Error("not implemented");
}
