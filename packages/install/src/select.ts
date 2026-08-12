import { type CatalogComponent, isKnownKind } from "./catalog.ts";
import { CliError, UsageError } from "./errors.ts";
import type { ProfileMode } from "./types.ts";

export interface SelectionInput {
	catalog: CatalogComponent[];
	mode: ProfileMode;
	/** Explicit component ids, already deduplicated by the parser. Only consulted in `explicit` mode. */
	selectors: string[];
	/** Whether a host CLI is present on the controlled PATH. */
	hostPresent: (host: string) => boolean;
}

export interface SelectionResult {
	mode: ProfileMode;
	/** The components to act on, in a deterministic order. */
	components: CatalogComponent[];
	/** Components the default profile dropped because their host CLI is absent. */
	skipped: Array<{ id: string; reason: "host-absent"; host: string }>;
	/** Explicitly-selected components whose host CLI is absent — selected anyway, but reported. */
	hostMissing: Array<{ id: string; host: string }>;
}

/**
 * Resolves the desired component set.
 *
 * - `default` — every `defaultProfile` component whose `requiresHost` (if any)
 *   is actually on PATH. Absent hosts are dropped and reported, never
 *   installed for a harness that is not there.
 * - `full` — every catalog component, host presence irrelevant.
 * - `explicit` — exactly the given ids, in the order given. An explicit
 *   selection replaces the default set completely; an unknown id is a usage
 *   error rather than a silent no-op.
 *
 * An unknown `kind` is only fatal for components that end up selected: the
 * catalog may legitimately carry entries this engine build has no adapter for.
 */
export function resolveSelection(input: SelectionInput): SelectionResult {
	const { catalog, mode, selectors, hostPresent } = input;
	const byId = new Map(catalog.map((component) => [component.id, component]));
	const skipped: SelectionResult["skipped"] = [];
	const hostMissing: SelectionResult["hostMissing"] = [];
	let components: CatalogComponent[];

	if (mode === "explicit") {
		const seen = new Set<string>();
		components = [];
		for (const id of selectors) {
			if (seen.has(id)) continue;
			seen.add(id);
			const component = byId.get(id);
			if (!component) {
				throw new UsageError(`unknown component "${id}" (known: ${[...byId.keys()].sort().join(", ")})`, {
					component: id,
				});
			}
			components.push(component);
			if (component.requiresHost && !hostPresent(component.requiresHost)) {
				hostMissing.push({ id: component.id, host: component.requiresHost });
			}
		}
	} else if (mode === "full") {
		components = [...catalog].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	} else {
		components = [];
		for (const component of [...catalog].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			if (!component.defaultProfile) continue;
			if (component.requiresHost && !hostPresent(component.requiresHost)) {
				skipped.push({ id: component.id, reason: "host-absent", host: component.requiresHost });
				continue;
			}
			components.push(component);
		}
	}

	for (const component of components) {
		if (!isKnownKind(component.kind)) {
			throw new CliError(
				"unknown-kind",
				`component "${component.id}" declares kind "${component.kind}", which this engine has no adapter for`,
				{ detail: { component: component.id, kind: component.kind } },
			);
		}
	}

	return { mode, components, skipped, hostMissing };
}
