/**
 * Hand-written type declarations for ./generate-skills-artifacts.mjs.
 *
 * Under Node16/NodeNext module resolution, a relative "./generate-skills-artifacts.mjs"
 * import specifier resolves its declarations from this ".d.mts" file. Keep in
 * sync with the exported signatures in the .mjs file.
 */

export type Host = "claude" | "codex";
export type PackageName = "draht-claude" | "draht-codex";

export interface SkillEntry {
	name: string;
	dir: string;
	skillMd: string;
	/** null for plain (discipline-style) skills, which have no command.md. */
	commandMd: string | null;
}

export interface Artifact {
	pkg: PackageName;
	relPath: string;
	content: string;
}

export interface WrittenArtifact {
	path: string;
	status: "=" | "+" | "↻";
}

export interface DialectEntry {
	canonical: string;
	claude?: string;
	codex?: string;
}

type DialectEntries = ReadonlyArray<DialectEntry>;

/**
 * Replace every canonical line that has a matching dialect-table entry with
 * its per-host rendering. Matching is exact whole-line string equality.
 */
export declare function applyLineDialect(text: string, entries: DialectEntries | undefined, host: Host): string;

/** Resolve the generic <PLUGIN_ROOT> placeholder to the host's literal token. */
export declare function applyPluginRootToken(text: string, host: Host): string;

/**
 * Walk skillsRoot and classify each child directory as a "command" skill
 * (has command.md) or a "plain" skill (SKILL.md only). Returns entries
 * sorted by name for deterministic output.
 */
export declare function discoverSkills(skillsRoot: string): SkillEntry[];

/**
 * Compute every generated artifact as { pkg, relPath, content } records,
 * without touching the filesystem beyond reading skillsRoot.
 */
export declare function computeArtifacts(skillsRoot: string): Artifact[];

/** Write every artifact under outputRoot/packages/<pkg>/<relPath>. */
export declare function writeArtifacts(artifacts: Artifact[], outputRoot: string): WrittenArtifact[];

/**
 * Compare artifacts against outputRoot without writing anything. Returns a
 * list of precise drift problems (empty when in sync).
 */
export declare function checkArtifacts(artifacts: Artifact[], outputRoot: string): string[];
