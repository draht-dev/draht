import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHandMirroredSkills } from "../../../../scripts/check-plugin-mirrors.mjs";
import { HAND_MIRRORED_SKILL_DIRS } from "../../../../scripts/hand-mirrored-skills.mjs";
import { REPO_ROOT } from "./skill-tree.ts";

// The hand-mirrored class exists for plugin-payload skills whose committed
// frontmatter is not Agent-Skills-spec-conformant (cinematic-continuation
// carries version/author/metadata keys), so they cannot join the canonical
// skills/ tree byte-preserved. They are gated here instead: byte-identical
// across the two plugin packages, file-set equality both ways. This is
// deliberately STRICTER than the retired dialect-tolerant mirror check —
// a hand-mirrored skill has no host-specific spans at all.

describe("hand-mirrored skills: allowlist", () => {
	it("contains exactly cinematic-continuation (adding a hand-mirrored skill is an explicit decision)", () => {
		expect(HAND_MIRRORED_SKILL_DIRS).toEqual(["cinematic-continuation"]);
	});
});

describe("hand-mirrored skills: pair identity on the real tree", () => {
	it("every allowlisted skill dir is byte-identical across draht-claude and draht-codex", () => {
		expect(checkHandMirroredSkills(REPO_ROOT)).toEqual([]);
	});
});

describe("hand-mirrored skills: pair identity semantics on synthetic fixtures", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "draht-hand-mirrored-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writePair(name: string, relFile: string, claudeContent: string, codexContent: string): void {
		for (const [pkg, content] of [
			["draht-claude", claudeContent],
			["draht-codex", codexContent],
		] as const) {
			const filePath = join(tmpRoot, "packages", pkg, "skills", name, relFile);
			mkdirSync(join(filePath, ".."), { recursive: true });
			writeFileSync(filePath, content);
		}
	}

	it("returns no problems when both copies match byte-for-byte (including nested files)", () => {
		writePair("cinematic-continuation", "SKILL.md", "same\n", "same\n");
		writePair("cinematic-continuation", "references/schema.md", "nested same\n", "nested same\n");

		expect(checkHandMirroredSkills(tmpRoot)).toEqual([]);
	});

	it("reports the differing file when the copies drift", () => {
		writePair("cinematic-continuation", "SKILL.md", "same\n", "same\n");
		writePair("cinematic-continuation", "references/schema.md", "claude version\n", "codex version\n");

		const problems = checkHandMirroredSkills(tmpRoot);
		expect(problems.length).toBe(1);
		expect(problems[0]).toContain("cinematic-continuation/references/schema.md");
	});

	it("reports files missing on one side, in both directions", () => {
		writePair("cinematic-continuation", "SKILL.md", "same\n", "same\n");
		const claudeOnly = join(tmpRoot, "packages/draht-claude/skills/cinematic-continuation/claude-only.md");
		writeFileSync(claudeOnly, "only here\n");
		const codexOnly = join(tmpRoot, "packages/draht-codex/skills/cinematic-continuation/codex-only.md");
		writeFileSync(codexOnly, "only there\n");

		const problems = checkHandMirroredSkills(tmpRoot);
		expect(problems.some((p) => p.includes("claude-only.md") && p.includes("draht-codex"))).toBe(true);
		expect(problems.some((p) => p.includes("codex-only.md") && p.includes("draht-claude"))).toBe(true);
	});

	it("reports an allowlisted skill dir that is absent from both packages (a stale allowlist is drift too)", () => {
		const problems = checkHandMirroredSkills(tmpRoot);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("cinematic-continuation");
	});
});
