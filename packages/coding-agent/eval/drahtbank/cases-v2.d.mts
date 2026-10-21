import type { BenchmarkCase } from "./cases.mjs";
export { gradeResponse } from "./grading-v2.mjs";
export type { ResponseGrade, ResponseInput } from "./grading-v2.mjs";

export interface EvidenceRequirement {
	id: string;
	command: string;
	exitCode: number;
	afterEdits: boolean;
	outputLine?: string;
	outputJson?: Record<string, unknown>;
}
export interface BenchmarkCaseV2 extends BenchmarkCase {
	split: "screen" | "holdout";
	promptKind: "agent" | "skill" | "command";
	promptName: string;
	outputContract: "status" | "triage";
	responseInstructions: string;
	evidenceRequirements: EvidenceRequirement[];
	responseContract?: {
		verdict: string;
		findings: { file: string; line: number }[];
		facts: Record<string, unknown>;
	};
}
export const SUITE_VERSION: "2";
export const GRADING_SOURCES: string[];
export const CASES: BenchmarkCaseV2[];
