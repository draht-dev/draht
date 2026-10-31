export interface RuntimeProof { id: string; file: string; requiredTests: string[]; }
export interface RuntimeResult { id: string; file: string; status: string; tests: number; requiredProofs: number; failures: Array<{name: string; messages: unknown}>; }
export interface RuntimeAssessment { complete: boolean; passed: boolean; tests: number; results: RuntimeResult[]; errors: string[]; }
export interface RuntimeReport {
	schemaVersion: 1; lane: "runtime-checks"; startedAt: string; completedAt: string; complete: boolean; passed: boolean; modelCalls: 0;
	root: string; packageRoot: string; identity: {node: string; platform: string; arch: string; nodeSha256: string; evaluatorPath: string; evaluatorSha256: string; tsxSha256: string; vitestSha256: string; tsxVersion: string; vitestVersion: string; commit: string; sourceChanges: string};
	command: string[]; environment: {offline: boolean; packageDirectory: string; isolatedAgentDirectory: boolean; inheritedGitOverridesRemoved: boolean; inheritedNodeOptionsRemoved: boolean};
	sourcesBefore: Record<string,string>; sourcesAfter: Record<string,string> | null; sourcesStable: boolean;
	process: {exitCode: number | null; signal: string | null; error: string | null; elapsedMs: number};
	stdoutSha256: string; stderrSha256: string; vitestSha256: string | null; reportError: string | null;
	tests: number; results: RuntimeResult[]; errors: string[]; limits: string[];
}
export const RUNTIME_CHECKS: RuntimeProof[];
export function assessRuntimeChecks(value: unknown, packageRoot: string): RuntimeAssessment;
export function runRuntimeChecks(output: string, options?: {root?: string; timeoutMs?: number}): Promise<RuntimeReport>;
