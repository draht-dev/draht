/**
 * The project registry entry (spec §3: "registry = yaml ∪ workspaceRoots
 * discovery ∪ recents"). Harness-free — a project is just a place on disk
 * with a name, regardless of which agents run inside it.
 */
export interface Project {
	/** Stable, human-typeable identifier used in voice/text project qualifiers (spec §9.5). */
	readonly slug: string;
	/** Display name. */
	readonly name: string;
	/** Absolute path to the project's repo root. */
	readonly root: string;
}
