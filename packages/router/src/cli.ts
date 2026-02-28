import { loadConfig, saveConfig } from "./config.js";
import { getRoleCosts } from "./cost.js";
import { ModelRouter } from "./router.js";
import type { ModelRef, RoleConfig } from "./types.js";

/**
 * Parse "provider/model" string into ModelRef.
 */
export function parseModelRef(ref: string): ModelRef {
	const slashIndex = ref.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(`Invalid model ref "${ref}" — expected "provider/model"`);
	}
	return {
		provider: ref.slice(0, slashIndex),
		model: ref.slice(slashIndex + 1),
	};
}

/**
 * Format ModelRef as "provider/model" string.
 */
export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

/**
 * Show current router configuration.
 */
export function routerShow(projectRoot?: string): string {
	const config = loadConfig(projectRoot);
	const lines: string[] = ["Model Router Configuration", ""];

	for (const [role, roleConfig] of Object.entries(config)) {
		const primary = formatModelRef(roleConfig.primary);
		const fallbacks = roleConfig.fallbacks.map(formatModelRef);
		const chain = fallbacks.length > 0 ? `${primary} → ${fallbacks.join(" → ")}` : primary;
		lines.push(`  ${role.padEnd(14)} ${chain}`);
	}

	return lines.join("\n");
}

/**
 * Set model for a role.
 */
export function routerSet(
	role: string,
	modelRefStr: string,
	fallbackStrs: string[] = [],
	scope: "project" | "global" = "project",
	projectRoot?: string,
): void {
	const config = loadConfig(projectRoot);
	const primary = parseModelRef(modelRefStr);
	const fallbacks = fallbackStrs.map(parseModelRef);

	config[role] = { primary, fallbacks } satisfies RoleConfig;
	saveConfig(config, scope, projectRoot);
}

/**
 * Test router resolution — dry-run showing what model would be selected.
 */
export function routerTest(role?: string, projectRoot?: string): string {
	const config = loadConfig(projectRoot);
	const router = new ModelRouter(config);
	const lines: string[] = ["Router Test (dry-run)", ""];

	const roles = role ? [role] : Object.keys(config);

	for (const r of roles) {
		try {
			const primary = router.resolve(r);
			const all = router.resolveWithFallbacks(r);
			lines.push(`  ${r}: ${formatModelRef(primary)} (${all.length} total in chain)`);
		} catch (e) {
			lines.push(`  ${r}: ERROR — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return lines.join("\n");
}

/**
 * Show cost summary.
 */
export function routerCost(role?: string, logPath?: string): string {
	const config = loadConfig();
	const lines: string[] = ["Cost Summary", ""];

	const roles = role ? [role] : Object.keys(config);

	for (const r of roles) {
		const costs = getRoleCosts(r, logPath);
		if (costs.totalCost > 0) {
			lines.push(
				`  ${r.padEnd(14)} $${costs.totalCost.toFixed(4)} (${costs.totalInputTokens} in / ${costs.totalOutputTokens} out)`,
			);
		}
	}

	if (lines.length === 2) {
		lines.push("  No cost data recorded yet.");
	}

	return lines.join("\n");
}
