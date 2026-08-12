import type { KnownKind } from "../catalog.ts";
import { CliError } from "../errors.ts";
import { claudePluginAdapter } from "./claude-plugin.ts";
import { codexPluginAdapter } from "./codex-plugin.ts";
import { globalCliAdapter } from "./global-cli.ts";
import type { Adapter } from "./types.ts";

/**
 * The adapter table, keyed by component **kind**. Adding a component of an
 * existing kind is a catalog data change with no code here; adding a new kind
 * is the only case that touches this file.
 */
const ADAPTERS: Record<KnownKind, Adapter> = {
	"claude-plugin": claudePluginAdapter,
	"codex-plugin": codexPluginAdapter,
	"global-cli": globalCliAdapter,
};

export const KNOWN_ADAPTER_KINDS = Object.keys(ADAPTERS) as KnownKind[];

/** Resolves the adapter for a kind, failing closed on anything unrecognized. */
export function adapterFor(kind: string): Adapter {
	const adapter = ADAPTERS[kind as KnownKind];
	if (!adapter) {
		throw new CliError("unknown-kind", `no adapter is shipped for component kind "${kind}"`, { detail: { kind } });
	}
	return adapter;
}

export type {
	Adapter,
	AdapterComponent,
	AdapterContext,
	DelegateOutcome,
	DeregisterOutcome,
	RegisterOutcome,
} from "./types.ts";
