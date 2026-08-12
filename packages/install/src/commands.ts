import type { CliArgs } from "./args.ts";
import { type CatalogComponent, loadCatalog } from "./catalog.ts";
import { type DetectionResult, detect, hostPresenceFrom } from "./detect.ts";
import { runDoctor } from "./doctor.ts";
import { type ApplyEvent, Engine, type EnginePlan } from "./engine.ts";
import { BlockedError, CliError } from "./errors.ts";
import { EXIT_CHANGES_PENDING, EXIT_ERROR, EXIT_OK, EXIT_PARTIAL } from "./exit-codes.ts";
import { createHostRunner } from "./host.ts";
import { runInit } from "./init.ts";
import { JSON_SCHEMA_VERSION, jsonDocument, renderJson, renderNdjson } from "./json.ts";
import { resolveHome, resolveInstallRoot } from "./paths.ts";
import type { CommandContext } from "./run-cli.ts";
import { resolveSelection, type SelectionResult } from "./select.ts";
import { createNpmRegistryClient } from "./sources/npm.ts";
import type { RegistryClient } from "./sources/types.ts";
import type { PlanAction, ProfileMode } from "./types.ts";

/** Everything a verb needs, resolved once from the command context. */
export interface ResolvedRuntime {
	root: string;
	home: string;
	catalog: CatalogComponent[];
	detection: DetectionResult;
	registry: RegistryClient;
	engine: Engine;
}

/** A registry that refuses every operation, making dry-run network isolation structural. */
function readOnlyRegistry(): RegistryClient {
	return {
		resolve: async () => {
			throw new CliError("internal", "a dry run attempted to resolve registry metadata; this is a bug");
		},
		fetchTarball: async () => {
			throw new CliError("internal", "a dry run attempted to download a package; this is a bug");
		},
	};
}

export function buildRuntime(ctx: CommandContext, options: { dryRun?: boolean } = {}): ResolvedRuntime {
	const home = resolveHome(ctx.env);
	const root = resolveInstallRoot(ctx.env);
	const catalog = loadCatalog();
	const detection = detect(ctx.env);
	const baseRegistry = ctx.registry ?? createNpmRegistryClient(ctx.env);
	const registry = options.dryRun ? readOnlyRegistry() : baseRegistry;
	const runHost = options.dryRun
		? () => {
				throw new CliError("internal", "a dry run attempted to call a host CLI; this is a bug");
			}
		: (ctx.hostRunner ?? createHostRunner());

	const engine = new Engine({
		root,
		home,
		env: ctx.env,
		catalog,
		registry,
		runHost,
		detection,
		channel: ctx.args.channel,
		signal: ctx.signal,
	});

	return { root, home, catalog, detection, registry, engine };
}

function profileMode(args: CliArgs): ProfileMode {
	if (args.full) return "full";
	if (args.selectors.length > 0) return "explicit";
	return "default";
}

export function selectionFor(args: CliArgs, runtime: ResolvedRuntime): SelectionResult {
	return resolveSelection({
		catalog: runtime.catalog,
		mode: profileMode(args),
		selectors: args.selectors,
		hostPresent: hostPresenceFrom(runtime.detection),
	});
}

/** Fails with exit 3 when a CI-guarded run resolved to no components at all. */
function enforceFailOnEmpty(args: CliArgs, selection: SelectionResult): void {
	if (!args.failOnEmpty || selection.components.length > 0) return;
	throw new BlockedError(
		"empty-selection",
		`the resolved component selection is empty (profile "${selection.mode}"), and --fail-on-empty was given`,
		{ skipped: selection.skipped },
	);
}

function describeAction(action: PlanAction): string {
	switch (action.type) {
		case "install":
			return `install ${action.componentId} ${action.toVersion}`;
		case "update":
			return `update ${action.componentId} ${action.fromVersion} -> ${action.toVersion}`;
		case "remove":
			return `remove ${action.componentId} ${action.fromVersion}`;
		case "delegate-install":
			return `install ${action.componentId} globally (delegated)`;
		case "delegate-uninstall":
			return `remove ${action.componentId} globally (delegated)`;
	}
}

function serializeAction(action: PlanAction): Record<string, unknown> {
	return { ...action };
}

/** Confirms a mutating command, or refuses it. Read commands never reach this. */
async function confirmMutation(ctx: CommandContext, summary: string): Promise<void> {
	if (ctx.args.yes) return;
	if (!ctx.io.isTTY || !ctx.io.confirm) {
		throw new BlockedError(
			"confirmation-required",
			`refusing to ${summary} without confirmation: re-run with --yes, or run interactively`,
		);
	}
	const approved = await ctx.io.confirm(`${summary}. Continue?`);
	if (!approved) {
		throw new BlockedError("declined", "aborted at the confirmation prompt; nothing was changed");
	}
}

export async function executeCommand(ctx: CommandContext): Promise<number> {
	switch (ctx.args.command) {
		case "plan":
			return await commandPlan(ctx);
		case "install":
			return await commandApply(ctx, "install");
		case "update":
			return await commandApply(ctx, "update");
		case "uninstall":
			return await commandUninstall(ctx);
		case "status":
			return await commandStatus(ctx);
		case "doctor":
			return await commandDoctor(ctx);
		case "init":
			return await runInit(ctx);
	}
}

async function commandPlan(ctx: CommandContext): Promise<number> {
	const runtime = buildRuntime(ctx);
	const selection = selectionFor(ctx.args, runtime);
	enforceFailOnEmpty(ctx.args, selection);

	await runtime.engine.prepareDiskHashes();
	const plan = await runtime.engine.resolvePlan(selection);

	if (ctx.args.json) {
		ctx.io.stdout(
			renderJson(
				jsonDocument("plan", {
					ok: true,
					channel: ctx.args.channel,
					profile: selection.mode,
					actions: plan.actions.map(serializeAction),
					blocked: plan.blocked,
					skipped: selection.skipped,
					hostMissing: selection.hostMissing,
				}),
			),
		);
	} else {
		ctx.io.stdout(renderPlanText(plan, selection));
	}

	if (plan.blocked.length > 0) return EXIT_PARTIAL;
	return plan.actions.length > 0 ? EXIT_CHANGES_PENDING : EXIT_OK;
}

function renderPlanText(plan: EnginePlan, selection: SelectionResult): string {
	const lines: string[] = [];
	lines.push(`profile: ${selection.mode}`);
	for (const skipped of selection.skipped) {
		lines.push(`  skipped ${skipped.id}: host "${skipped.host}" is not installed`);
	}
	for (const missing of selection.hostMissing) {
		lines.push(`  warning ${missing.id}: host "${missing.host}" is not installed`);
	}
	if (plan.actions.length === 0) {
		lines.push("nothing to do: every selected component is already up to date");
	} else {
		lines.push(`${plan.actions.length} change(s) pending:`);
		for (const action of plan.actions) lines.push(`  ${describeAction(action)}`);
	}
	for (const blocked of plan.blocked) {
		lines.push(`  blocked ${blocked.componentId}: refusing to downgrade ${blocked.from} -> ${blocked.to}`);
	}
	return `${lines.join("\n")}\n`;
}

async function commandApply(ctx: CommandContext, verb: "install" | "update"): Promise<number> {
	const runtime = buildRuntime(ctx, { dryRun: ctx.args.dryRun });
	const selection = selectionFor(ctx.args, runtime);
	enforceFailOnEmpty(ctx.args, selection);

	await runtime.engine.prepareDiskHashes();
	const plan = ctx.args.dryRun
		? await runtime.engine.resolveDryRunPlan(selection, { force: ctx.args.force, update: verb === "update" })
		: await runtime.engine.resolvePlan(selection, { force: ctx.args.force });

	if (ctx.args.dryRun) {
		const summary = { ok: true, dryRun: true, actions: plan.actions.map(serializeAction), blocked: plan.blocked };
		if (ctx.args.json) {
			ctx.io.stdout(
				renderNdjson({ schemaVersion: JSON_SCHEMA_VERSION, event: "summary", command: verb, ...summary }),
			);
		} else {
			ctx.io.stdout(
				`dry run: no changes were made\n${
					plan.actions.length === 0
						? "  nothing to do\n"
						: `${plan.actions.map((action) => `  would ${describeAction(action)}`).join("\n")}\n`
				}`,
			);
		}
		return plan.blocked.length > 0 ? EXIT_PARTIAL : EXIT_OK;
	}

	if (plan.actions.length === 0) {
		if (ctx.args.json) {
			ctx.io.stdout(
				renderNdjson({
					schemaVersion: JSON_SCHEMA_VERSION,
					event: "summary",
					command: verb,
					ok: true,
					actions: [],
					blocked: plan.blocked,
				}),
			);
		} else {
			ctx.io.stdout("nothing to do: every selected component is already up to date\n");
		}
		return plan.blocked.length > 0 ? EXIT_PARTIAL : EXIT_OK;
	}

	await confirmMutation(ctx, `${verb} ${plan.actions.length} component change(s)`);

	const emit = ndjsonEmitter(ctx, verb);
	const outcome = await runtime.engine.apply(plan, { command: verb, onEvent: emit });

	if (ctx.args.json) {
		ctx.io.stdout(
			renderNdjson({
				schemaVersion: JSON_SCHEMA_VERSION,
				event: "summary",
				command: verb,
				ok: true,
				tx: outcome.tx,
				actions: outcome.applied.map(serializeAction),
				blocked: outcome.blocked,
				notes: outcome.notes,
			}),
		);
	} else {
		const lines = outcome.applied.map((action) => `  ${describeAction(action)}`);
		ctx.io.stdout(`applied ${outcome.applied.length} change(s):\n${lines.join("\n")}\n`);
		for (const note of outcome.notes) ctx.io.stdout(`  note: ${note}\n`);
		for (const blocked of outcome.blocked) {
			ctx.io.stdout(`  blocked ${blocked.componentId}: refusing to downgrade ${blocked.from} -> ${blocked.to}\n`);
		}
	}

	return outcome.blocked.length > 0 ? EXIT_PARTIAL : EXIT_OK;
}

function ndjsonEmitter(ctx: CommandContext, command: string): ((event: ApplyEvent) => void) | undefined {
	if (!ctx.args.json) return undefined;
	return (event) => {
		ctx.io.stdout(renderNdjson({ schemaVersion: JSON_SCHEMA_VERSION, command, ...event }));
	};
}

async function commandUninstall(ctx: CommandContext): Promise<number> {
	const runtime = buildRuntime(ctx, { dryRun: ctx.args.dryRun });
	const plan = runtime.engine.uninstallPlan(ctx.args.all ? [] : ctx.args.selectors);

	if (plan.actions.length === 0) {
		ctx.io.stdout(
			ctx.args.json
				? renderNdjson({
						schemaVersion: JSON_SCHEMA_VERSION,
						event: "summary",
						command: "uninstall",
						ok: true,
						actions: [],
					})
				: "nothing to do: none of the requested components are installed\n",
		);
		return EXIT_OK;
	}

	if (ctx.args.dryRun) {
		ctx.io.stdout(
			ctx.args.json
				? renderNdjson({
						schemaVersion: JSON_SCHEMA_VERSION,
						event: "summary",
						command: "uninstall",
						ok: true,
						dryRun: true,
						actions: plan.actions.map(serializeAction),
					})
				: `dry run: no changes were made\n${plan.actions.map((action) => `  would ${describeAction(action)}`).join("\n")}\n`,
		);
		return EXIT_OK;
	}

	await confirmMutation(ctx, `remove ${plan.actions.length} component(s)`);

	const outcome = await runtime.engine.apply(plan, { command: "uninstall", onEvent: ndjsonEmitter(ctx, "uninstall") });

	if (ctx.args.json) {
		ctx.io.stdout(
			renderNdjson({
				schemaVersion: JSON_SCHEMA_VERSION,
				event: "summary",
				command: "uninstall",
				ok: true,
				tx: outcome.tx,
				actions: outcome.applied.map(serializeAction),
				notes: outcome.notes,
			}),
		);
	} else {
		ctx.io.stdout(`removed ${outcome.applied.length} component(s)\n`);
		for (const note of outcome.notes) ctx.io.stdout(`  note: ${note}\n`);
	}
	return EXIT_OK;
}

async function commandStatus(ctx: CommandContext): Promise<number> {
	const runtime = buildRuntime(ctx);
	const components = await runtime.engine.status();
	const pending = components.filter((component) => component.drift === "drifted" || component.drift === "missing");

	if (ctx.args.json) {
		ctx.io.stdout(
			renderJson(
				jsonDocument("status", {
					ok: true,
					channel: ctx.args.channel,
					root: runtime.root,
					components,
					pendingChanges: pending.length,
				}),
			),
		);
	} else if (components.length === 0) {
		ctx.io.stdout("no components are installed\n");
	} else {
		const lines = components.map(
			(component) =>
				`  ${component.id.padEnd(14)} ${component.version.padEnd(14)} ${component.drift.padEnd(10)} ${component.effectiveness}`,
		);
		ctx.io.stdout(`state root: ${runtime.root}\n${lines.join("\n")}\n`);
	}

	if (ctx.args.check && pending.length > 0) return EXIT_CHANGES_PENDING;
	return EXIT_OK;
}

async function commandDoctor(ctx: CommandContext): Promise<number> {
	const runtime = buildRuntime(ctx);
	const findings = await runDoctor({
		root: runtime.root,
		home: runtime.home,
		catalog: runtime.catalog,
		detection: runtime.detection,
		targetDirFor: (component) => runtime.engine.targetDirFor(component),
	});

	if (ctx.args.json) {
		ctx.io.stdout(renderJson(jsonDocument("doctor", { ok: true, root: runtime.root, findings })));
	} else if (findings.length === 0) {
		ctx.io.stdout("no problems found\n");
	} else {
		const lines = findings.map((finding) => `  [${finding.severity}] ${finding.id}: ${finding.message}`);
		ctx.io.stdout(`${findings.length} finding(s):\n${lines.join("\n")}\n`);
	}

	return findings.some((finding) => finding.severity === "error") ? EXIT_ERROR : EXIT_OK;
}
