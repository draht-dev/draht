import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../errors.ts";
import type { HostRunResult } from "../host.ts";
import type { AdapterContext } from "./types.ts";

/**
 * The local marketplace and plugin names both host CLIs use. Pinned here
 * because the engine must produce a layout the existing `draht-claude` /
 * `draht-codex` CLIs would also recognize — a mismatch would silently create a
 * second, competing registration.
 */
export const MARKETPLACE_NAME = "draht";
export const PLUGIN_NAME = "draht";
export const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Subdirectory of the marketplace holding the payload itself. */
export const PLUGIN_SUBDIR = join("plugins", PLUGIN_NAME);

/** Resolves a required host executable, or fails with an actionable message. */
export function requireHost(ctx: AdapterContext, name: string): string {
	const path = ctx.hostPath(name);
	if (!path) {
		throw new CliError("host-missing", `the "${name}" CLI is not on PATH, so this component cannot be registered`, {
			detail: { host: name },
		});
	}
	return path;
}

function describe(file: string, args: string[]): string {
	return `${file} ${args.join(" ")}`;
}

/** Runs a host call and throws with the host's own stderr when it fails. */
export function runOrThrow(ctx: AdapterContext, file: string, args: string[]): HostRunResult {
	const result = ctx.runHost(file, args, { cwd: ctx.home, env: ctx.env });
	if (result.spawnError) {
		throw new CliError("host-failed", `could not run "${describe(file, args)}": ${result.spawnError.message}`, {
			detail: { command: describe(file, args) },
		});
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
		throw new CliError("host-failed", `"${describe(file, args)}" failed: ${detail}`, {
			detail: { command: describe(file, args), status: result.status },
		});
	}
	return result;
}

/** Runs a host call and parses its stdout as JSON, refusing to guess when the shape is not what was asked for. */
export function runJson(ctx: AdapterContext, file: string, args: string[]): unknown {
	const result = runOrThrow(ctx, file, args);
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new CliError("host-failed", `"${describe(file, args)}" returned invalid JSON`, {
			detail: { command: describe(file, args) },
			cause: error,
		});
	}
}

/**
 * The tolerant entry matcher both plugin CLIs use, mirrored so the engine's
 * view of "is this installed" cannot diverge from theirs across host output
 * format changes.
 */
export function pluginListEntryMatches(entry: unknown): boolean {
	if (entry === PLUGIN_SPEC) return true;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const record = entry as Record<string, unknown>;
	for (const key of ["id", "pluginId", "plugin_id", "spec", "name"]) {
		if (record[key] === PLUGIN_SPEC) return true;
	}
	const names = [record.name, record.plugin, record.pluginName, record.plugin_name];
	const marketplaces = [record.marketplace, record.marketplaceName, record.marketplace_name, record.source];
	return names.includes(PLUGIN_NAME) && marketplaces.includes(MARKETPLACE_NAME);
}

/** Reads the payload's own `package.json`, used only to fill descriptive manifest fields. */
export function readPayloadManifest(payloadDir: string): Record<string, unknown> {
	const path = join(payloadDir, "package.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Copies the extracted npm payload into `<stagingDir>/plugins/draht`.
 *
 * The archive extractor has already rejected links and special files, so the
 * cached payload is regular files and directories only — a recursive copy
 * cannot follow anything out of the tree.
 */
export function stagePayload(payloadDir: string, stagingDir: string): void {
	const dest = join(stagingDir, PLUGIN_SUBDIR);
	mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
	cpSync(payloadDir, dest, { recursive: true, dereference: false, errorOnExist: false });
}

/** Writes a marketplace manifest into the staged tree. */
export function writeStagedManifest(stagingDir: string, relativePath: string, manifest: unknown): void {
	const path = join(stagingDir, relativePath);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function stringField(manifest: Record<string, unknown>, key: string): string | undefined {
	const value = manifest[key];
	return typeof value === "string" ? value : undefined;
}

/** The Claude Code local-marketplace manifest, shaped exactly as `draht-claude` writes it. */
export function claudeMarketplaceManifest(payloadManifest: Record<string, unknown>): unknown {
	const author = payloadManifest.author;
	const authorName =
		author && typeof author === "object" && typeof (author as Record<string, unknown>).name === "string"
			? ((author as Record<string, unknown>).name as string)
			: "draht";
	const homepage = stringField(payloadManifest, "homepage") ?? "https://draht.dev";
	return {
		$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
		name: MARKETPLACE_NAME,
		description: "Local marketplace for the Draht Claude Code plugin. Managed by draht-install.",
		owner: { name: authorName, url: homepage },
		plugins: [
			{
				name: PLUGIN_NAME,
				description:
					stringField(payloadManifest, "description") ??
					"Draht GSD, multi-agent, TDD and DDD workflows as a Claude Code plugin",
				source: `./${PLUGIN_SUBDIR.split("\\").join("/")}`,
				category: "workflow",
				homepage,
			},
		],
	};
}

/** The Codex local-marketplace manifest, shaped exactly as `draht-codex` writes it. */
export function codexMarketplaceManifest(payloadManifest: Record<string, unknown>): unknown {
	const iface = payloadManifest.interface;
	const category =
		iface && typeof iface === "object" && typeof (iface as Record<string, unknown>).category === "string"
			? ((iface as Record<string, unknown>).category as string)
			: "Coding";
	return {
		name: MARKETPLACE_NAME,
		interface: { displayName: "Draht" },
		plugins: [
			{
				name: PLUGIN_NAME,
				source: { source: "local", path: `./${PLUGIN_SUBDIR.split("\\").join("/")}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category,
			},
		],
	};
}
