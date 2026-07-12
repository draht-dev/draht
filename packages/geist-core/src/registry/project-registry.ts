import type { GeistConfig } from "@draht/geist-protocol";
import type { Project } from "../project.js";
import { InMemoryRecentsStore, type RecentsStore, touchRecents } from "./recents-store.js";
import { discoverWorkspaceProjects } from "./workspace-discovery.js";

/** The slice of `GeistConfig` the registry actually reads — see `project-registry.ts` module doc. */
export type ProjectRegistryConfig = Pick<GeistConfig, "projects" | "workspaceRoots">;

export interface ProjectRegistryOptions {
	/**
	 * Parsed `geist.yaml` (or equivalent) — supplies `projects` (the "yaml"
	 * source) and `workspaceRoots` (the "workspaceRoots discovery" source).
	 * Omit entirely for a registry fed only by recents.
	 */
	config?: ProjectRegistryConfig;
	/** Recents persistence port. Defaults to `InMemoryRecentsStore` (nothing persisted across process restarts). */
	recentsStore?: RecentsStore;
}

/** Projects declared explicitly in `GeistConfig.projects` (spec §3 "yaml" source). Slug = the map key. */
function yamlProjects(config: ProjectRegistryConfig | undefined): Project[] {
	const declared = config?.projects ?? {};
	return Object.entries(declared).map(([slug, entry]) => ({
		slug,
		name: entry.name ?? slug,
		root: entry.root,
	}));
}

/**
 * `ProjectRegistry` (spec §3: "registry = yaml ∪ workspaceRoots discovery ∪
 * recents"): merges the three sources described there into one
 * deduplicated `Project` list, keyed by `slug`.
 *
 * Dedup/conflict rule: when the same slug appears in more than one source,
 * the more authoritative source wins outright (its fields replace the
 * other's, not merged field-by-field) — **yaml > workspaceRoots discovery >
 * recents**. Yaml is the most deliberate, explicit source, so it wins any
 * disagreement (per the task's dedup rule: "yaml wins on conflicting
 * fields"). Between the remaining two, live discovery beats a recents entry,
 * which is just a historical cache and may be stale (renamed project, moved
 * repo, etc).
 *
 * Harness-free by construction: this module touches only `node:fs` (via
 * `workspace-discovery.ts`) and the injectable `RecentsStore` port — no ACP,
 * no `@draht/*` beyond the sibling `geist-protocol` package (spec §17.1).
 */
export class ProjectRegistry {
	private readonly config: ProjectRegistryConfig | undefined;
	private readonly recentsStore: RecentsStore;

	constructor(options: ProjectRegistryOptions = {}) {
		this.config = options.config;
		this.recentsStore = options.recentsStore ?? new InMemoryRecentsStore();
	}

	/** The merged, deduplicated project list, sorted by slug for a stable, deterministic order. */
	list(): Project[] {
		const recents = this.recentsStore.load();
		const discovered = discoverWorkspaceProjects(this.config?.workspaceRoots ?? []);
		const yaml = yamlProjects(this.config);

		// Insertion order = ascending priority: each later loop overwrites
		// same-slug entries from the one(s) before it, so the last writer
		// (yaml) wins — see the class doc for the full precedence rationale.
		const merged = new Map<string, Project>();
		for (const project of recents) merged.set(project.slug, project);
		for (const project of discovered) merged.set(project.slug, project);
		for (const project of yaml) merged.set(project.slug, project);

		return [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug));
	}

	/** Looks up one project by slug in the merged list (spec §9.5 project qualifier resolution). */
	get(slug: string): Project | undefined {
		return this.list().find((project) => project.slug === slug);
	}

	/** Records `project` as most-recently-used, persisting via the configured `RecentsStore`. */
	touchRecent(project: Project): void {
		this.recentsStore.save(touchRecents(this.recentsStore.load(), project));
	}
}
