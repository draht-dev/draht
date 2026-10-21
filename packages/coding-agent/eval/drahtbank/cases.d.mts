export type PromptRole = "implementer" | "debugger" | "reviewer" | "security-auditor";

export interface BenchmarkCase {
	id: string;
	role: PromptRole;
	task: string;
	rubric: string;
	files: Record<string, string>;
	writable: string[];
	allowedNewFiles: string[];
	requiredNewFiles?: string[];
	expectedStatuses: string[];
	assertions: string;
}

export const SUITE_VERSION: "1";
export const CASES: BenchmarkCase[];
