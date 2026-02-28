import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CostEntry } from "./types.js";

const DEFAULT_LOG_PATH = ".draht/cost-log.jsonl";

/**
 * Rough cost estimates per million tokens (input/output) by provider.
 */
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
	"anthropic/claude-opus-4-6": { input: 15, output: 75 },
	"anthropic/claude-sonnet-4-6": { input: 3, output: 15 },
	"google/gemini-2.5-pro": { input: 1.25, output: 10 },
	"google/gemini-2.5-flash": { input: 0.15, output: 0.6 },
	"openai/gpt-5.2": { input: 5, output: 15 },
	"deepseek/deepseek-v3": { input: 0.27, output: 1.1 },
};

/**
 * Estimate cost for a request.
 */
export function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
	const key = `${provider}/${model}`;
	const rates = COST_PER_MILLION[key] ?? { input: 3, output: 15 }; // default estimate
	return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

/**
 * Append a cost entry to the JSONL log.
 */
export function logCost(entry: CostEntry, logPath?: string): void {
	const path = resolve(logPath ?? DEFAULT_LOG_PATH);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Read all cost entries from the log.
 */
export function readCostLog(logPath?: string): CostEntry[] {
	const path = resolve(logPath ?? DEFAULT_LOG_PATH);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CostEntry);
}

/**
 * Get costs filtered by session ID.
 */
export function getSessionCosts(sessionId: string, logPath?: string): CostEntry[] {
	return readCostLog(logPath).filter((e) => e.sessionId === sessionId);
}

/**
 * Aggregate costs by role.
 */
export function getRoleCosts(
	role: string,
	logPath?: string,
): { totalCost: number; totalInputTokens: number; totalOutputTokens: number } {
	const entries = readCostLog(logPath).filter((e) => e.role === role);
	return {
		totalCost: entries.reduce((sum, e) => sum + e.estimatedCostUsd, 0),
		totalInputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
		totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
	};
}
