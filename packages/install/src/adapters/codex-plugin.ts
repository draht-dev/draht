import { join } from "node:path";
import { CliError } from "../errors.ts";
import { marketplaceRoot } from "../paths.ts";
import {
	codexMarketplaceManifest,
	MARKETPLACE_NAME,
	PLUGIN_SPEC,
	pluginListEntryMatches,
	readPayloadManifest,
	requireHost,
	runJson,
	runOrThrow,
	stagePayload,
	writeStagedManifest,
} from "./plugin-host.ts";
import type { Adapter, AdapterContext, DeregisterOutcome, RegisterOutcome } from "./types.ts";

const HOST = "codex";

function marketplaceRegistered(ctx: AdapterContext, codex: string): boolean {
	const output = runJson(ctx, codex, ["plugin", "marketplace", "list", "--json"]);
	const marketplaces = (output as { marketplaces?: unknown })?.marketplaces;
	if (!Array.isArray(marketplaces)) {
		throw new CliError("host-failed", "codex plugin marketplace list returned an unexpected JSON shape");
	}
	return marketplaces.some(
		(entry) => entry && typeof entry === "object" && (entry as { name?: unknown }).name === MARKETPLACE_NAME,
	);
}

function pluginInstalled(ctx: AdapterContext, codex: string): boolean {
	const output = runJson(ctx, codex, ["plugin", "list", "--json"]);
	const installed = (output as { installed?: unknown })?.installed;
	if (!Array.isArray(installed)) {
		throw new CliError("host-failed", "codex plugin list returned an unexpected JSON shape");
	}
	return installed.some((entry) => pluginListEntryMatches(entry));
}

/**
 * Codex plugin payloads.
 *
 * Mirrors `packages/draht-codex/cli.mjs`. Codex has no `validate` step and no
 * enable/disable pair, and its marketplace registration is always `add` —
 * differences that are pinned by the adapter tests rather than assumed
 * symmetric with Claude.
 *
 * Effectiveness stays `unknown`: Codex's reload semantics were never verified
 * (spec §1), and reporting anything more definite would be a claim this engine
 * cannot support.
 */
export const codexPluginAdapter: Adapter = {
	kind: "codex-plugin",
	payload: "files",

	targetDir(ctx) {
		return marketplaceRoot(ctx.home, HOST);
	},

	async stage(_ctx, _component, payloadDir, stagingDir) {
		stagePayload(payloadDir, stagingDir);
		writeStagedManifest(
			stagingDir,
			join(".agents", "plugins", "marketplace.json"),
			codexMarketplaceManifest(readPayloadManifest(payloadDir)),
		);
	},

	async register(ctx, _component, targetDir): Promise<RegisterOutcome> {
		const codex = requireHost(ctx, HOST);
		const notes: string[] = [];

		// Probed before any destructive call, matching the plugin CLI's ordering.
		marketplaceRegistered(ctx, codex);
		const wasInstalled = pluginInstalled(ctx, codex);

		runOrThrow(ctx, codex, ["plugin", "marketplace", "add", targetDir]);

		if (wasInstalled) {
			runOrThrow(ctx, codex, ["plugin", "remove", PLUGIN_SPEC]);
			notes.push("removed the previously installed plugin cache before re-adding");
		}
		runOrThrow(ctx, codex, ["plugin", "add", PLUGIN_SPEC]);

		if (!pluginInstalled(ctx, codex)) {
			throw new CliError("host-failed", "codex does not list the plugin as installed after adding it");
		}

		return { registered: true, effectiveness: "unknown", notes };
	},

	async deregister(ctx, _component, _targetDir): Promise<DeregisterOutcome> {
		const codex = ctx.hostPath(HOST);
		if (!codex) {
			return {
				deregistered: true,
				notes: [`the ${HOST} CLI is not present, so there is no host registration to remove`],
			};
		}

		const notes: string[] = [];
		for (const args of [
			["plugin", "remove", PLUGIN_SPEC],
			["plugin", "marketplace", "remove", MARKETPLACE_NAME],
		]) {
			const result = ctx.runHost(codex, args, { cwd: ctx.home, env: ctx.env });
			if (result.status !== 0)
				notes.push(`"codex ${args.join(" ")}" reported failure; verifying host state directly`);
		}

		let stillInstalled: boolean;
		let stillRegistered: boolean;
		try {
			stillInstalled = pluginInstalled(ctx, codex);
			stillRegistered = marketplaceRegistered(ctx, codex);
		} catch (error) {
			return {
				deregistered: false,
				notes: [
					...notes,
					`could not verify that codex released the plugin: ${(error as Error).message}. The local payload was left in place.`,
				],
			};
		}

		if (stillInstalled) notes.push("codex still lists the plugin as installed");
		if (stillRegistered) notes.push("codex still lists the draht marketplace as registered");

		return { deregistered: !stillInstalled && !stillRegistered, notes };
	},
};
