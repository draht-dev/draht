/**
 * Deploy Guardian coding agent extension.
 * Provides pre-deployment checks, Lighthouse, rollback, and SST deploy blocking.
 */

import type { ExtensionFactory } from "@draht/coding-agent";
import {
	type CheckResult,
	getDeployTags,
	rollbackTo,
	runLighthouse,
	runPreDeployChecks,
	tagDeployment,
} from "./checks.js";

export const deployGuardianExtension: ExtensionFactory = (pi) => {
	// Block sst deploy commands
	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") {
			const command = String((event as any).input?.command ?? "");
			if (/\bsst\s+deploy\b/i.test(command)) {
				return {
					block: true,
					reason: "🛡️ Deploy Guardian: `sst deploy` is blocked. Deployments must be done manually with verification.",
				};
			}
		}
		return undefined;
	});

	pi.registerCommand("deploy", {
		description: "Deploy Guardian: check, lighthouse, tag, rollback",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] || "check";
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "check": {
					ctx.ui.notify("🛡️ Running pre-deployment checks...", "info");
					const results = runPreDeployChecks(ctx.cwd);
					const formatted = formatChecks(results);
					ctx.ui.notify(formatted, "info");

					const failures = results.filter((r) => r.severity === "fail");
					if (failures.length > 0) {
						ctx.ui.notify(`❌ ${failures.length} check(s) failed — fix before deploying`, "error");
					} else {
						ctx.ui.notify("✅ All critical checks passed", "info");
					}
					break;
				}

				case "lighthouse": {
					const url = rest || "http://localhost:3000";
					ctx.ui.notify(`🔦 Running Lighthouse on ${url}...`, "info");
					const result = await runLighthouse(url);
					ctx.ui.notify(`${severityIcon(result.severity)} ${result.name}: ${result.message}`, "info");
					break;
				}

				case "tag": {
					try {
						const tag = tagDeployment(ctx.cwd, rest || undefined);
						ctx.ui.notify(`🏷️ Tagged: ${tag}`, "info");
					} catch (error) {
						ctx.ui.notify(`Failed to tag: ${error instanceof Error ? error.message : error}`, "error");
					}
					break;
				}

				case "rollback": {
					if (!rest) {
						const tags = getDeployTags(ctx.cwd);
						if (tags.length === 0) {
							ctx.ui.notify("No deployment tags found. Use `/deploy tag` first.", "warning");
							return;
						}
						ctx.ui.notify(`Recent tags:\n${tags.map((t) => `  ${t}`).join("\n")}\n\nUsage: /deploy rollback <tag>`, "info");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Rollback",
						`Are you sure you want to rollback to ${rest}?`,
					);
					if (!confirmed) return;
					try {
						rollbackTo(ctx.cwd, rest);
						ctx.ui.notify(`⏮️ Rolled back to: ${rest}`, "info");
					} catch (error) {
						ctx.ui.notify(`Rollback failed: ${error instanceof Error ? error.message : error}`, "error");
					}
					break;
				}

				default:
					ctx.ui.notify(
						"🛡️ Deploy Guardian\n\n  /deploy check      — Run pre-deployment checks\n  /deploy lighthouse  — Run Lighthouse audit\n  /deploy tag [name]  — Tag current state\n  /deploy rollback    — Rollback to tagged state",
						"info",
					);
			}
		},
	});
};

function formatChecks(results: CheckResult[]): string {
	return results
		.map((r) => `${severityIcon(r.severity)} ${r.name}: ${r.message}`)
		.join("\n");
}

function severityIcon(severity: string): string {
	switch (severity) {
		case "pass": return "✅";
		case "warning": return "⚠️";
		case "fail": return "❌";
		default: return "❓";
	}
}
