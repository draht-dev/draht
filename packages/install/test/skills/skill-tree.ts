// Shared read-only helpers for packages/install/test/skills/*.test.ts.
// Not a test file itself (no .test. in the name) — vitest will not collect it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** packages/install/test/skills -> repo root (4 levels up). */
export const REPO_ROOT = resolve(here, "../../../..");
export const SKILLS_ROOT = join(REPO_ROOT, "skills");
export const CLAUDE_PKG = join(REPO_ROOT, "packages/draht-claude");
export const CODEX_PKG = join(REPO_ROOT, "packages/draht-codex");
export const GENERATOR_SCRIPT = join(REPO_ROOT, "scripts/generate-skills-artifacts.mjs");

export interface SkillDirInfo {
	name: string;
	dir: string;
	skillMdPath: string;
	/** null for plain (discipline-style) skills, which have no command.md. */
	commandMdPath: string | null;
}

function listChildDirs(root: string): string[] {
	return readdirSync(root)
		.filter((entry) => !entry.startsWith("."))
		.filter((entry) => statSync(join(root, entry)).isDirectory())
		.sort();
}

/** List repo-root skills/<name>/ directories, classified by presence of command.md. */
export function listCanonicalSkills(): SkillDirInfo[] {
	return listChildDirs(SKILLS_ROOT).map((name) => {
		const dir = join(SKILLS_ROOT, name);
		const commandMdPath = join(dir, "command.md");
		return {
			name,
			dir,
			skillMdPath: join(dir, "SKILL.md"),
			commandMdPath: existsSync(commandMdPath) ? commandMdPath : null,
		};
	});
}

/** Split a SKILL.md/command.md-style file into its frontmatter lines and body. */
export function splitFrontmatter(raw: string): { frontmatterLines: string[]; body: string } {
	const lines = raw.split("\n");
	if (lines[0] !== "---") throw new Error("expected frontmatter to start with a --- line");
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new Error("expected a closing --- line for frontmatter");
	return {
		frontmatterLines: lines.slice(1, end),
		body: lines.slice(end + 1).join("\n"),
	};
}

/**
 * Parse top-level "key: value" frontmatter pairs. Values in this repo are
 * single-line scalars; a non-"key: value" line is treated as a continuation
 * of the previous key (folded scalar) so multi-line values don't get lost.
 */
export function parseFrontmatterFields(frontmatterLines: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	let currentKey: string | null = null;
	for (const line of frontmatterLines) {
		const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):[ \t]?(.*)$/);
		if (match) {
			currentKey = match[1];
			fields[currentKey] = match[2];
		} else if (currentKey) {
			fields[currentKey] += `\n${line}`;
		}
	}
	return fields;
}

export function relativeToSkillsRoot(path: string): string {
	return path.slice(SKILLS_ROOT.length + 1);
}
