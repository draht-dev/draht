import type { Models, RetryPolicy } from "@draht/ai";
import type { MissingIdentityInfo } from "./agent-harness.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import type { LaneConfiguration } from "./session/types.ts";

export const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1_000 };

export function validateToolNames(tools: readonly { name: string }[]): void {
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) throw new TypeError(`Duplicate tool name: ${JSON.stringify(tool.name)}`);
		names.add(tool.name);
	}
}

export function validateRetryPolicy(policy: RetryPolicy): void {
	if (
		!Number.isSafeInteger(policy.maxRetries) ||
		policy.maxRetries < 0 ||
		policy.maxRetries === Number.MAX_SAFE_INTEGER ||
		!Number.isSafeInteger(policy.baseDelayMs) ||
		policy.baseDelayMs < 0
	) {
		throw new RangeError("Retry policy values must be finite non-negative safe integers");
	}
}

export function hasMissingIdentities(info: MissingIdentityInfo): boolean {
	return info.tools.length !== 0 || info.model !== undefined;
}

export function missingIdentities(
	models: Models,
	configuration: LaneConfiguration,
	tools: readonly { name: string }[],
): MissingIdentityInfo {
	const model = models.getModel(configuration.model.provider, configuration.model.modelId);
	return {
		tools: missingToolIdentities(configuration, tools),
		...(model === undefined ? { model: `${configuration.model.provider}/${configuration.model.modelId}` } : {}),
	};
}

export function missingToolIdentities(configuration: LaneConfiguration, tools: readonly { name: string }[]): string[] {
	const availableTools = new Set(tools.map((tool) => tool.name));
	return configuration.activeToolNames.filter((name) => !availableTools.has(name));
}

export function validateCompactionSettings(settings: CompactionSettings): void {
	if (
		!Number.isSafeInteger(settings.reserveTokens) ||
		settings.reserveTokens < 0 ||
		!Number.isSafeInteger(settings.keepRecentTokens) ||
		settings.keepRecentTokens < 0
	) {
		throw new RangeError("Compaction token counts must be finite non-negative safe integers");
	}
}
