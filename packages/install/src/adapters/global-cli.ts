import { CliError } from "../errors.ts";
import { requireHost, runOrThrow } from "./plugin-host.ts";
import type { Adapter, DelegateOutcome } from "./types.ts";

/** The only package manager this release delegates to. Others are a deferred capability, not a silent fallback. */
const PACKAGE_MANAGER = "npm";
const METHOD = "npm-global";

/**
 * Components installed globally by an external package manager rather than by
 * the engine's own file swap.
 *
 * Two honesty constraints shape this adapter:
 *
 * 1. The engine records *that* it delegated (`method`, `packageName`) and
 *    never records a file manifest it does not own — so `status`/`doctor`
 *    cannot claim hash-level knowledge of something npm controls.
 * 2. A failed delegated install is reported with the package manager's own
 *    error. The engine does not attempt — and never claims — a rollback of an
 *    external global install, because it cannot know what npm left behind.
 */
export const globalCliAdapter: Adapter = {
	kind: "global-cli",
	payload: "delegated",

	targetDir() {
		return null;
	},

	async stage() {
		throw new CliError("internal", "global-cli components are delegated and are never staged by the engine");
	},

	async register() {
		throw new CliError("internal", "global-cli components are delegated and are never registered by the engine");
	},

	async deregister() {
		throw new CliError("internal", "global-cli components are delegated and are never deregistered by the engine");
	},

	async delegateInstall(ctx, component, version): Promise<DelegateOutcome> {
		const npm = requireHost(ctx, PACKAGE_MANAGER);
		runOrThrow(ctx, npm, ["install", "--global", `${component.npmName}@${version}`]);
		return {
			method: METHOD,
			packageName: component.npmName,
			// A process already running keeps the binary it started with; the new
			// one is picked up by the next invocation.
			effectiveness: "next-session",
			notes: [`installed ${component.npmName}@${version} globally with ${PACKAGE_MANAGER}`],
		};
	},

	async delegateUninstall(ctx, component): Promise<DelegateOutcome> {
		const npm = requireHost(ctx, PACKAGE_MANAGER);
		runOrThrow(ctx, npm, ["uninstall", "--global", component.npmName]);
		return {
			method: METHOD,
			packageName: component.npmName,
			effectiveness: "next-session",
			notes: [`removed ${component.npmName} globally with ${PACKAGE_MANAGER}`],
		};
	},
};
