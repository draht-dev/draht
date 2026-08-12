import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { buildRuntime, selectionFor } from "./commands.ts";
import { BlockedError, CliError } from "./errors.ts";
import { EXIT_OK } from "./exit-codes.ts";
import { JSON_SCHEMA_VERSION, renderNdjson } from "./json.ts";
import type { CommandContext } from "./run-cli.ts";
import { packageRoot } from "./version.ts";

/**
 * Directory entries that do not make a target "non-empty" for scaffolding
 * purposes. A freshly-created git repository is the normal starting point for
 * a new project, so its metadata directory does not count as a collision.
 */
const IGNORABLE_ENTRIES = new Set([".git", ".gitkeep", ".DS_Store"]);

/** The planning tree `draht-tools` creates. Never overwritten — not even under `--force`. */
const PLANNING_DIR = ".planning";

/**
 * Locates the `draht-tools` entry script.
 *
 * `DRAHT_TOOLS_BIN` wins for tests and for anyone pinning a specific build.
 * Otherwise the bundled dependency is resolved relative to this package —
 * both in the published layout (`node_modules/@draht/tools`) and in the
 * monorepo (`packages/draht-tools`), so init works from a checkout and from a
 * packed tarball alike.
 */
export function resolveDrahtToolsBin(env: NodeJS.ProcessEnv): string {
	const override = env.DRAHT_TOOLS_BIN;
	if (override) return override;

	const root = packageRoot();
	const candidates = [
		join(root, "node_modules", "@draht", "tools", "bin", "draht-tools.cjs"),
		join(root, "..", "draht-tools", "bin", "draht-tools.cjs"),
		join(root, "..", "..", "node_modules", "@draht", "tools", "bin", "draht-tools.cjs"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return resolve(candidate);
	}
	throw new CliError(
		"tools-missing",
		`could not locate the bundled draht-tools CLI (looked in: ${candidates.join(", ")}). Set DRAHT_TOOLS_BIN to override.`,
	);
}

/** Whether the directory is safe to scaffold into without `--force`. */
function isEffectivelyEmpty(dir: string): boolean {
	if (!existsSync(dir)) return true;
	return readdirSync(dir).every((entry) => IGNORABLE_ENTRIES.has(entry));
}

/**
 * Runs one `draht-tools` subcommand.
 *
 * The scaffolder is invoked through argv with `shell: false`, so a project
 * directory or name containing shell metacharacters is passed as data and can
 * never become a second command. `process.execPath` runs it, so init does not
 * depend on a `draht-tools` bin being on PATH.
 */
function runDrahtTools(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd,
		env,
		encoding: "utf8",
		shell: false,
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) {
		throw new CliError("scaffold-failed", `could not run draht-tools ${args[0]}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
		throw new CliError("scaffold-failed", `draht-tools ${args[0]} failed: ${detail}`, {
			detail: { command: args, status: result.status },
		});
	}
}

/**
 * `draht-init`: ensure the requested components through the same engine
 * `draht-install` uses, then scaffold a project's planning tree.
 *
 * Deliberately does NOT launch an agent. Spawning an interactive AI session as
 * a side effect of a bootstrap command is not behavior this engine can prove
 * safe, so the handoff command is printed for the operator to run.
 */
export async function runInit(ctx: CommandContext): Promise<number> {
	const { args, io } = ctx;
	const targetArg = args.positionals[0] ?? ctx.cwd;
	const project = isAbsolute(targetArg) ? resolve(targetArg) : resolve(ctx.cwd, targetArg);
	const projectName = basename(project);
	const emit = (record: Record<string, unknown>): void => {
		if (args.json) io.stdout(renderNdjson({ schemaVersion: JSON_SCHEMA_VERSION, ...record, command: "init" }));
	};

	// Collision checks run before anything is created, so a refusal leaves the
	// filesystem exactly as it was found.
	if (existsSync(join(project, PLANNING_DIR))) {
		throw new BlockedError(
			"planning-exists",
			`refusing to scaffold ${project}: it already has a ${PLANNING_DIR}/ directory, which draht-init never overwrites`,
			{ project },
		);
	}
	if (!isEffectivelyEmpty(project) && !args.force) {
		throw new BlockedError(
			"directory-not-empty",
			`refusing to scaffold ${project}: the directory is not empty. Re-run with --force to scaffold alongside existing files.`,
			{ project },
		);
	}

	const runtime = buildRuntime(ctx, { dryRun: args.dryRun });
	const selection = selectionFor(args, runtime);
	if (args.failOnEmpty && selection.components.length === 0) {
		throw new BlockedError(
			"empty-selection",
			`the resolved component selection is empty (profile "${selection.mode}"), and --fail-on-empty was given`,
			{ skipped: selection.skipped },
		);
	}

	const toolsBin = resolveDrahtToolsBin(ctx.env);

	if (args.dryRun) {
		await runtime.engine.prepareDiskHashes();
		const plan = await runtime.engine.resolveDryRunPlan(selection);
		emit({ event: "summary", ok: true, dryRun: true, project, actions: plan.actions });
		if (!args.json) {
			io.stdout(
				`dry run: no changes were made\n  would ensure ${plan.actions.length} component change(s)\n  would scaffold ${project}\n`,
			);
		}
		return EXIT_OK;
	}

	if (!args.yes) {
		if (!io.isTTY || !io.confirm) {
			throw new BlockedError(
				"confirmation-required",
				`refusing to bootstrap ${project} without confirmation: re-run with --yes, or run interactively`,
			);
		}
		if (!(await io.confirm(`Bootstrap a Draht project in ${project}. Continue?`))) {
			throw new BlockedError("declined", "aborted at the confirmation prompt; nothing was changed");
		}
	}

	// 1. Components, through exactly the engine draht-install uses.
	await runtime.engine.prepareDiskHashes();
	const plan = await runtime.engine.resolvePlan(selection);
	if (plan.blocked.length > 0) {
		throw new BlockedError(
			"blocked-plan",
			`refusing to scaffold ${project}: ${plan.blocked.length} selected component action(s) are blocked (${plan.blocked.map((item) => item.reason).join("; ")})`,
			{ project, blocked: plan.blocked },
		);
	}
	if (plan.actions.length > 0) {
		const outcome = await runtime.engine.apply(plan, {
			command: "init",
			onEvent: args.json ? (event) => emit({ ...event }) : undefined,
		});
		if (!args.json) io.stdout(`ensured ${outcome.applied.length} component change(s)\n`);
	} else if (!args.json) {
		io.stdout("components are already up to date\n");
	}

	// 2. Scaffolding, only once components are settled.
	mkdirSync(project, { recursive: true });
	for (const command of [["create-project", projectName], ["init-state"]]) {
		emit({ event: "scaffold-start", argv: command });
		runDrahtTools(toolsBin, command, project, ctx.env);
	}

	const handoff = `cd ${project} && draht`;
	emit({ event: "summary", ok: true, project, handoff });
	if (!args.json) {
		io.stdout(`scaffolded ${join(project, PLANNING_DIR)}\n`);
		io.stdout(`next: ${handoff}\n`);
		io.stdout("  then start with /new-project (or /init-project for an existing codebase)\n");
	}

	return EXIT_OK;
}
