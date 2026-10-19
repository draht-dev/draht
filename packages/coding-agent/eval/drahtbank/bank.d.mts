export type Host = "coding-agent" | "draht-claude" | "draht-codex";
export interface PrepareOptions {
	root?: string;
	baseline?: string;
	candidate?: string;
	hosts?: Host[];
	cases?: string[];
	repeats?: number;
	prompt?: string;
}
export interface Trial {
	id: string;
	host: Host;
	caseId: string;
	repetition: number;
	variant: "baseline" | "candidate";
	promptPath: string;
	promptSha256: string;
	promptBytes: number;
	taskSha256: string;
	initialWorkspaceSha256: string;
}
export interface Manifest {
	schemaVersion: 1;
	suiteVersion: string;
	suiteSha256: string;
	root: string;
	baselineCommit: string;
	candidateCommit: string | null;
	hosts: Host[];
	caseIds: string[];
	repeats: number;
	trials: Trial[];
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
}
export interface Metric { observed: number; total: number | null; median: number | null; }
export interface Pair { host: Host; caseId: string; repetition: number; baselinePassed: boolean; candidatePassed: boolean; elapsedDeltaMs: number | null; }
export interface Summary {
	variants: Record<"baseline" | "candidate", { passed: number; total: number; promptBytes: number; metrics: Record<string, Metric> }>;
	paired: { total: number; bothPassed: number; regressions: Pair[]; improvements: Pair[]; medianElapsedDeltaMsOnPairedPasses: number | null };
	comparableRunner: boolean;
	limits: string[];
}
export interface Report {
	schemaVersion: 1;
	suiteVersion: string;
	suiteSha256: string;
	baselineCommit: string;
	candidateCommit: string | null;
	gradedAt: string;
	gradingEnvironment: {node: string; platform: string; arch: string};
	results: Grade[];
	summary: Summary;
}
export const HOSTS: Host[];
export function prepareBank(output: string, options?: PrepareOptions): Manifest;
export function readManifest(output: string): Manifest;
export function validateAdapter(config: unknown): Adapter & { settings: Record<string, string | number | boolean>; timeoutMs: number };
export function runProcess(command: string[], options: {cwd: string; timeoutMs: number; stdin?: string; env?: Record<string,string>}): Promise<ProcessResult>;
export function runBank(output: string, config: Adapter, onProgress?: (progress: { index: number; total: number; trial: Trial }) => void): Promise<Report>;
export function gradeBank(output: string): Promise<Report>;
export function summarize(results: Grade[]): Summary;
