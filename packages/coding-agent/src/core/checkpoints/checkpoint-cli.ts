/**
 * `draht checkpoint ...` CLI subcommand (Phase 41: `prune`).
 *
 * Follows the `handleRlmCommand` dispatch contract: returns `false`
 * immediately (no side effects) when `args[0]` is not `"checkpoint"`,
 * otherwise always returns `true` after setting `process.exitCode`.
 */

import chalk from "chalk";
import type { SettingsManager } from "../settings-manager.ts";
import { CheckpointManager } from "./checkpoint-manager.ts";

export const CHECKPOINT_COMMAND_USAGE = "draht checkpoint prune [--days <n>] [--max-per-session <n>] [--dry-run]";

export interface CheckpointCommandOptions {
	/** Repository directory to operate on. Defaults to process.cwd(). */
	cwd?: string;
	/** Settings source for the retention policy. Defaults to the real settings files. */
	settingsManager?: SettingsManager;
}

function fail(message: string): true {
	console.error(chalk.red(message));
	console.error(chalk.dim(`Usage: ${CHECKPOINT_COMMAND_USAGE}`));
	process.exitCode = 1;
	return true;
}

/** Parse a non-negative integer flag value. Returns undefined when invalid. */
function parseCount(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function handleCheckpointCommand(
	args: string[],
	options: CheckpointCommandOptions = {},
): Promise<boolean> {
	const [command, subcommand, ...rest] = args;
	if (command !== "checkpoint") {
		return false;
	}

	if (subcommand !== "prune") {
		return fail(
			subcommand === undefined
				? 'Missing subcommand for "checkpoint".'
				: `Unknown subcommand "${subcommand}" for "checkpoint".`,
		);
	}

	let days: number | undefined;
	let maxPerSession: number | undefined;
	let dryRun = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--days" || arg === "--max-per-session") {
			const value = rest[++i];
			if (value === undefined) return fail(`Missing value for ${arg}.`);
			const parsed = parseCount(value);
			if (parsed === undefined) return fail(`Invalid ${arg} value "${value}" (must be a non-negative integer).`);
			if (arg === "--days") days = parsed;
			else maxPerSession = parsed;
			continue;
		}
		return fail(`Unknown option ${arg} for "checkpoint prune".`);
	}

	const cwd = options.cwd ?? process.cwd();
	let configured: { retentionDays: number; maxPerSession: number | undefined };
	if (options.settingsManager) {
		configured = options.settingsManager.getCheckpointSettings();
	} else {
		const { SettingsManager } = await import("../settings-manager.ts");
		configured = SettingsManager.create(cwd).getCheckpointSettings();
	}

	const result = await CheckpointManager.pruneRepository(cwd, {
		retentionDays: days ?? configured.retentionDays,
		maxPerSession: maxPerSession ?? configured.maxPerSession,
		dryRun,
	});

	const verb = dryRun ? "Would delete" : "Deleted";
	console.log(`Examined ${result.examined} checkpoint ref(s). ${verb} ${result.deleted.length}.`);
	for (const ref of result.deleted) {
		console.log(chalk.dim(`  ${ref}`));
	}

	process.exitCode = 0;
	return true;
}
