export type Host = "coding-agent" | "draht-claude" | "draht-codex";
export interface PromptVariant { id: string; ref: string | null; }
export interface PrepareOptions {
	root?: string;
	baseline?: string;
	candidate?: string;
	hosts?: Host[];
	cases?: string[];
	repeats?: number;
	prompt?: string;
	suite?: "1" | "2";
	split?: "screen" | "holdout" | "all";
	variants?: PromptVariant[];
	orderOffset?: number;
}
export interface Trial {
	id: string;
	host: Host;
	caseId: string;
	repetition: number;
	variant: string;
	promptCommit?: string | null;
	promptSurface?: "canonical-skill" | "package-asset";
	split?: "screen" | "holdout";
	promptPath: string;
	promptSha256: string;
	promptBytes: number;
	taskSha256: string;
	initialWorkspaceSha256: string;
}
export interface Manifest {
	schemaVersion: 1 | 2;
	suiteVersion: string;
	suiteSha256: string;
	root: string;
	baselineCommit: string;
	candidateCommit: string | null;
	hosts: Host[];
	caseIds: string[];
	repeats: number;
	trials: Trial[];
	variants?: PromptVariant[];
	orderOffset?: number;
	split?: "screen" | "holdout" | "all";
}
export interface Adapter {
	format: "json" | "draht-jsonl";
	command: string[];
	provider: string;
	model: string;
	settings?: Record<string, string | number | boolean>;
	timeoutMs?: number;
}
export interface ProcessResult {
	exitCode: number | null;
	signal: string | null;
	error: string | null;
	timedOut: boolean;
	elapsedMs: number;
	stdout: string;
	stderr: string;
	gitEnvironment: { policy: "fixture-ceiling-v1"; ceilingDirectory: string };
	isolation?: unknown;
}
export interface Grade extends Trial {
	passed: boolean;
	executionPassed: boolean;
	evidenceIntact: boolean;
	acceptancePassed: boolean;
	statusPassed: boolean;
	status: string | null;
	scopePassed: boolean;
	scopeViolations: string[];
	failure: string | null;
	acceptance: ProcessResult | null;
	elapsedMs: number | null;
	usage: Record<string, number | null> | null;
	toolCalls: number | null;
	telemetrySource: string | null;
	adapter: Adapter | null;
	behaviorPassed?: boolean | null;
	evidencePassed?: boolean | null;
	statusSyntaxPassed?: boolean;
	statusSemanticPassed?: boolean;
	responseFormatPassed?: boolean;
	findingsPassed?: boolean | null;
	auditEligible?: boolean;
	auditReasons?: string[];
	identity?: { passed: boolean | null; observed: number; mismatches: unknown[]; note: string };
	isolation?: { passed: boolean | null; note: string; receipt?: unknown };
}
export interface Metric { observed: number; total: number | null; median: number | null; }
export interface Pair { host: Host; caseId: string; repetition: number; baselinePassed: boolean; candidatePassed: boolean; elapsedDeltaMs: number | null; }
export interface PairSummary {
	total: number;
	bothPassed: number;
	regressions: Pair[];
	improvements: Pair[];
	medianElapsedDeltaMsOnPairedPasses: number | null;
}
export interface AxisComparison extends PairSummary {
	bothFailed: number;
	unknownOrNotApplicable: number;
}
export interface VariantComparison {
	baselineVariant: string;
	candidateVariant: string;
	matchedPairs: number;
	unpairedBaseline: number;
	unpairedCandidate: number;
	strict: PairSummary;
	axes: Record<string, AxisComparison>;
}
export interface Summary {
	variants: Record<string, { passed: number; total: number; promptBytes: number; metrics: Record<string, Metric>; axes?: Record<string, {passed: number; failed: number; unknownOrNotApplicable: number}> }>;
	paired: PairSummary;
	comparisons: VariantComparison[];
	comparableRunner: boolean;
	limits: string[];
}
export interface Report {
	schemaVersion: 1 | 2;
	suiteVersion: string;
	suiteSha256: string;
	baselineCommit: string;
	candidateCommit: string | null;
	gradedAt: string;
	gradingEnvironment: {node: string; platform: string; arch: string};
	results: Grade[];
	summary: Summary;
	variants?: PromptVariant[];
	split?: "screen" | "holdout" | "all";
}
export const HOSTS: Host[];
export function prepareBank(output: string, options?: PrepareOptions): Manifest;
export function readManifest(output: string): Manifest;
export function validateAdapter(config: unknown): Adapter & { settings: Record<string, string | number | boolean>; timeoutMs: number };
export function runProcess(command: string[], options: {cwd: string; timeoutMs: number; stdin?: string; env?: Record<string,string>}): Promise<ProcessResult>;
export function runBank(output: string, config: Adapter, onProgress?: (progress: { index: number; total: number; trial: Trial }) => void): Promise<Report>;
export function gradeBank(output: string): Promise<Report>;
export function summarize(results: Grade[], variantIds?: string[]): Summary;
