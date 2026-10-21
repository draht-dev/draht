import type { BenchmarkCaseV2 } from "./cases-v2.mjs";

export interface ResponseInput {
	finalText: string;
	stdout: string;
	format?: "draht-jsonl" | "json";
	workspace: string;
}
export interface ResponseGrade {
	status: string | null;
	statusSyntaxPassed: boolean;
	statusSemanticPassed: boolean;
	responseFormatPassed: boolean;
	findingsPassed: boolean | null;
	evidencePassed: boolean | null;
	evidence: {
		matched: { id: string; toolCallId: string }[];
		missing: string[];
		denied: { toolCallId: string; tool: string }[];
		unverifiable: string[];
	};
	traceScopeViolations: string[];
	auditEligible: boolean;
	auditReasons: string[];
}
export function gradeResponse(entry: BenchmarkCaseV2, input: ResponseInput): ResponseGrade;
