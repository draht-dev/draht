import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatterFields, REPO_ROOT, splitFrontmatter } from "./skill-tree.ts";

// Native reimplementation (~30 lines) of the skills-CLI priority walk used to
// discover an installable skill catalog from a repo root:
//   1. a SKILL.md directly at the root (single-skill repo) — short-circuits
//   2. the root's direct child directories, each containing a SKILL.md
//      (top-level-skills repo, e.g. github.com/anthropics/skills) — short-circuits
//   3. the skills/ subdirectory's children, each containing a SKILL.md
//      (the common "skills/" convention)
// The first tier that yields at least one skill wins; later tiers are never
// consulted, and are therefore never merged with an earlier tier's results.
// Within a tier, skills are deduped by frontmatter name, first-found-wins
// (directories are visited in sorted order).
function childDirs(dir: string): string[] {
	return readdirSync(dir)
		.filter((entry) => !entry.startsWith("."))
		.filter((entry) => statSync(join(dir, entry)).isDirectory())
		.sort();
}

function skillName(skillMdPath: string): string {
	const { frontmatterLines } = splitFrontmatter(readFileSync(skillMdPath, "utf8"));
	return parseFrontmatterFields(frontmatterLines).name;
}

function dedupByNameFirstFound(skillMdPaths: string[]): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const path of skillMdPaths) {
		const name = skillName(path);
		if (seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

function discoverSkillCatalog(root: string): string[] {
	const rootSkillMd = join(root, "SKILL.md");
	if (existsSync(rootSkillMd)) return dedupByNameFirstFound([rootSkillMd]);

	const tier2 = childDirs(root)
		.map((child) => join(root, child, "SKILL.md"))
		.filter(existsSync);
	if (tier2.length > 0) return dedupByNameFirstFound(tier2);

	const skillsDir = join(root, "skills");
	if (!existsSync(skillsDir)) return [];
	const tier3 = childDirs(skillsDir)
		.map((child) => join(skillsDir, child, "SKILL.md"))
		.filter(existsSync);
	return dedupByNameFirstFound(tier3);
}

const EXPECTED_NAMES = [
	"atomic-commit",
	"atomic-reasoning",
	"brainstorming",
	"ddd-workflow",
	"debugging-workflow",
	"discuss-phase",
	"draht",
	"execute-phase",
	"fix",
	"grill",
	"gsd-workflow",
	"init-project",
	"loop-workflow",
	"map-codebase",
	"model-tiering",
	"new-project",
	"next-milestone",
	"orchestrate",
	"orchestrate-loop",
	"pause-work",
	"plan-phase",
	"progress",
	"quick",
	"resolve-conflicts",
	"resume-work",
	"review",
	"saga-spawner",
	"tdd-workflow",
	"unslop",
	"verification-gate",
	"verify-work",
].sort();

describe("catalog: priority walk over this repo", () => {
	it("returns exactly the 31 canonical skill names", () => {
		expect(discoverSkillCatalog(REPO_ROOT).sort()).toEqual(EXPECTED_NAMES);
	});

	it("the root tree short-circuits ahead of the package mirrors: packages/draht-claude and packages/draht-codex are never visited", () => {
		// The walk only ever looks at <root>/SKILL.md, <root>/*/SKILL.md, and
		// <root>/skills/*/SKILL.md. packages/draht-claude/skills/* and
		// packages/draht-codex/skills/* sit two directories deeper than any of
		// those three locations, so they cannot appear in the result even
		// though several package-mirror skills share a name with a canonical
		// one (e.g. atomic-reasoning). A naive recursive **/SKILL.md glob
		// would instead surface duplicates or the wrong file for those names.
		const names = discoverSkillCatalog(REPO_ROOT);
		expect(names.length).toBe(new Set(names).size);
		expect(names.length).toBe(31);
	});
});

describe("catalog: priority walk semantics, exercised on synthetic fixtures", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "draht-catalog-walk-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeSkill(dir: string, name: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nbody\n`);
	}

	it("tier 1 (root SKILL.md) short-circuits ahead of a skills/ dir that also exists", () => {
		writeSkill(tmpRoot, "root-skill");
		writeSkill(join(tmpRoot, "skills", "other-skill"), "other-skill");

		expect(discoverSkillCatalog(tmpRoot)).toEqual(["root-skill"]);
	});

	it("tier 2 (root direct children) short-circuits ahead of a skills/ dir that also exists", () => {
		writeSkill(join(tmpRoot, "alpha"), "alpha");
		writeSkill(join(tmpRoot, "beta"), "beta");
		writeSkill(join(tmpRoot, "skills", "gamma"), "gamma");

		expect(discoverSkillCatalog(tmpRoot).sort()).toEqual(["alpha", "beta"]);
	});

	it("tier 3 (skills/ dir) is used when there is no root SKILL.md and no direct-child SKILL.md", () => {
		mkdirSync(join(tmpRoot, "docs"), { recursive: true }); // a plain dir with no SKILL.md must not confuse tier 2
		writeSkill(join(tmpRoot, "skills", "gamma"), "gamma");
		writeSkill(join(tmpRoot, "skills", "delta"), "delta");

		expect(discoverSkillCatalog(tmpRoot).sort()).toEqual(["delta", "gamma"]);
	});

	it("dedups by frontmatter name, first-found-wins in sorted directory order", () => {
		writeSkill(join(tmpRoot, "skills", "a-first"), "shared-name");
		writeSkill(join(tmpRoot, "skills", "b-second"), "shared-name");

		expect(discoverSkillCatalog(tmpRoot)).toEqual(["shared-name"]);
	});

	it("returns an empty catalog when nothing is found in any tier", () => {
		mkdirSync(join(tmpRoot, "docs"), { recursive: true });

		expect(discoverSkillCatalog(tmpRoot)).toEqual([]);
	});
});
