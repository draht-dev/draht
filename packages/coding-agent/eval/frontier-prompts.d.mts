export type Variant = "baseline" | "candidate";
export type CaseName = "feature" | "regression" | "multi-file" | "docs-only" | "failing-verification";

export interface Manifest {
	baseRef: string;
	promptPath: string;
	variants: Array<{ variant: Variant; promptBytes: number }>;
	cases: CaseName[];
}

export interface Grade {
	variant: Variant;
	case: CaseName;
	accepted: boolean;
	reportMatches: boolean;
	checkUnchanged: boolean;
	docsOnly: boolean;
	acceptanceExit: number | null;
	stderr: string | null;
	report: unknown;
}

export function prepare(output: string, baseRef?: string): Manifest;
export function grade(output: string): Grade[];
