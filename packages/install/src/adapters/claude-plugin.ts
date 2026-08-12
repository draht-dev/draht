import { join } from "node:path";
import { CliError } from "../errors.ts";
import { marketplaceRoot } from "../paths.ts";
import {
	claudeMarketplaceManifest,
	MARKETPLACE_NAME,
	PLUGIN_SPEC,
	PLUGIN_SUBDIR,
	pluginListEntryMatches,
	readPayloadManifest,
	requireHost,
	runJson,
	runOrThrow,
	stagePayload,
	writeStagedManifest,
} from "./plugin-host.ts";
import type { Adapter, AdapterContext, DeregisterOutcome, RegisterOutcome } from "./types.ts";

const HOST = "claude";

interface PluginState {
	installed: boolean;
	enabled: boolean;
}

function marketplaceRegistered(ctx: AdapterContext, claude: string): boolean {
	const entries = runJson(ctx, claude, ["plugin", "marketplace", "list", "--json"]);
	if (!Array.isArray(entries)) {
		throw new CliError("host-failed", "claude plugin marketplace list returned an unexpected JSON shape");
	}
	return entries.some(
		(entry) => entry && typeof entry === "object" && (entry as { name?: unknown }).name === MARKETPLACE_NAME,
	);
}

function pluginState(ctx: AdapterContext, claude: string): PluginState {
	const entries = runJson(ctx, claude, ["plugin", "list", "--json"]);
	if (!Array.isArray(entries)) {
		throw new CliError("host-failed", "claude plugin list returned an unexpected JSON shape");
	}
	const entry = entries.find((candidate) => pluginListEntryMatches(candidate));
	if (!entry) return { installed: false, enabled: false };
	const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
	const status = typeof record.status === "string" ? record.status.toLowerCase() : null;
	return { installed: true, enabled: record.enabled !== false && status !== "disabled" };
}

/**
 * Claude Code plugin payloads.
 *
 * The call sequence mirrors `packages/draht-claude/cli.mjs` exactly, and the
 * adapter tests assert it verbatim so any drift in the plugin CLI shows up as
 * a failing test rather than a silently divergent second implementation.
 *
 * Effectiveness is `restart-required`: the plugin CLI's own post-install
 * instructions tell the user to restart Claude Code, and nothing observed here
 * justifies a stronger claim.
 */
export const claudePluginAdapter: Adapter = {
	kind: "claude-plugin",
	payload: "files",

	targetDir(ctx) {
		return marketplaceRoot(ctx.home, HOST);
	},

	async stage(_ctx, _component, payloadDir, stagingDir) {
		stagePayload(payloadDir, stagingDir);
		writeStagedManifest(
			stagingDir,
			join(".claude-plugin", "marketplace.json"),
			claudeMarketplaceManifest(readPayloadManifest(payloadDir)),
		);
	},

	async register(ctx, _component, targetDir): Promise<RegisterOutcome> {
		const claude = requireHost(ctx, HOST);
		const notes: string[] = [];

		// Capture prior state before any destructive call, exactly as the plugin
		// CLI does: the decision between `marketplace add` and `marketplace
		// update`, and whether the plugin ends up enabled, both depend on it.
		const registered = marketplaceRegistered(ctx, claude);
		const previous = pluginState(ctx, claude);

		runOrThrow(ctx, claude, ["plugin", "validate", join(targetDir, PLUGIN_SUBDIR)]);
		runOrThrow(
			ctx,
			claude,
			registered
				? ["plugin", "marketplace", "update", MARKETPLACE_NAME]
				: ["plugin", "marketplace", "add", targetDir],
		);

		if (previous.installed) {
			// Claude Code copies plugin files at install time, so a stale install
			// must be removed for the new payload to be picked up.
			runOrThrow(ctx, claude, ["plugin", "uninstall", PLUGIN_SPEC]);
			notes.push("removed the previously installed plugin so Claude Code re-copies the new payload");
		}

		runOrThrow(ctx, claude, ["plugin", "install", PLUGIN_SPEC, "--scope", "user"]);

		const shouldEnable = previous.installed ? previous.enabled : true;
		runOrThrow(ctx, claude, ["plugin", shouldEnable ? "enable" : "disable", PLUGIN_SPEC]);
		if (!shouldEnable) notes.push("preserved the previously disabled plugin state");

		const verified = pluginState(ctx, claude);
		if (!verified.installed || verified.enabled !== shouldEnable) {
			throw new CliError("host-failed", "claude reports the plugin is not in the expected state after install", {
				detail: { expected: { installed: true, enabled: shouldEnable }, actual: verified },
			});
		}

		return { registered: true, effectiveness: "restart-required", notes };
	},

	async deregister(ctx, _component, _targetDir): Promise<DeregisterOutcome> {
		const claude = ctx.hostPath(HOST);
		if (!claude) {
			// Nothing to unwire: without the host there is no registry holding a
			// reference, so removing the local payload is safe.
			return {
				deregistered: true,
				notes: [`the ${HOST} CLI is not present, so there is no host registration to remove`],
			};
		}

		const notes: string[] = [];
		// Each removal is best-effort — a host that has already forgotten the
		// plugin fails these — but the *verification* below is not.
		for (const args of [
			["plugin", "disable", PLUGIN_SPEC],
			["plugin", "uninstall", PLUGIN_SPEC],
			["plugin", "marketplace", "remove", MARKETPLACE_NAME],
		]) {
			const result = ctx.runHost(claude, args, { cwd: ctx.home, env: ctx.env });
			if (result.status !== 0)
				notes.push(`"claude ${args.join(" ")}" reported failure; verifying host state directly`);
		}

		let stillInstalled: boolean;
		let stillRegistered: boolean;
		try {
			stillInstalled = pluginState(ctx, claude).installed;
			stillRegistered = marketplaceRegistered(ctx, claude);
		} catch (error) {
			return {
				deregistered: false,
				notes: [
					...notes,
					`could not verify that claude released the plugin: ${(error as Error).message}. The local payload was left in place.`,
				],
			};
		}

		if (stillInstalled) notes.push("claude still lists the plugin as installed");
		if (stillRegistered) notes.push("claude still lists the draht marketplace as registered");

		return { deregistered: !stillInstalled && !stillRegistered, notes };
	},
};
