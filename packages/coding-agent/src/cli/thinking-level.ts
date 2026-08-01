import type { ThinkingLevel } from "@draht/agent-core";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}
