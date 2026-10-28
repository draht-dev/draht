export type RunnerFormat = "draht-jsonl" | "json";

export interface AdapterConfig {
	format: RunnerFormat;
	command: string[];
	provider: string;
	model: string;
	settings: Record<string, string | number | boolean>;
	timeoutMs?: number;
}

export interface InvocationPaths {
	workspace: string;
	promptFile: string;
	taskFile: string;
	prompt: string;
	task: string;
}

export interface ParsedOutput {
	finalText: string;
	usage: {
		inputTokens: number | null;
		outputTokens: number | null;
		cacheReadTokens: number | null;
		cacheWriteTokens: number | null;
		costUsd: number | null;
	};
	toolCalls: number | null;
	telemetrySource: "draht-events" | "adapter-reported";
	error: string | null;
}

export function buildInvocation(config: AdapterConfig, paths: InvocationPaths): { command: string[]; stdin: string };
export function parseOutput(format: RunnerFormat, stdout: string): ParsedOutput;
