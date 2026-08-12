import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_PKG } from "./skill-tree.ts";

// Regression coverage for the dangling-reference defect: today's committed
// codex wrapper skills point at "../../commands/<name>.md" relative to their
// own SKILL.md, which only resolves when the wrapper is installed inside the
// full draht-codex package tree. Copy one wrapper skill dir alone (no
// sibling commands/) and prove its reference still resolves.

function listWrapperSkillNames(): string[] {
	const skillsDir = join(CODEX_PKG, "skills");
	return readdirSync(skillsDir)
		.filter((entry) => !entry.startsWith("."))
		.filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
		.filter((entry) => existsSync(join(skillsDir, entry, "command.md")))
		.sort();
}

describe("wrapper-standalone: a generated codex wrapper skill works when copied alone", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "draht-wrapper-standalone-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("finds at least one command-wrapper skill to test (proves this rule is exercised, not vacuous)", () => {
		expect(listWrapperSkillNames().length).toBeGreaterThan(0);
	});

	it("packages/draht-codex/skills/atomic-commit copied alone resolves its ./command.md reference", () => {
		const source = join(CODEX_PKG, "skills/atomic-commit");
		const dest = join(tmpDir, "atomic-commit");
		cpSync(source, dest, { recursive: true });

		const skillMd = readFileSync(join(dest, "SKILL.md"), "utf8");
		const match = skillMd.match(/Read `(\.\/[^`]+)`/);
		expect(match, "expected SKILL.md to contain a `./...` reference").not.toBeNull();

		const ref = match?.[1] as string;
		const resolved = join(dest, ref);
		expect(existsSync(resolved), `${ref} did not resolve inside the standalone copy`).toBe(true);
		expect(readFileSync(resolved, "utf8").length).toBeGreaterThan(0);
	});

	it("the old dangling-reference form is no longer present in any wrapper skill", () => {
		for (const name of listWrapperSkillNames()) {
			const skillMd = readFileSync(join(CODEX_PKG, "skills", name, "SKILL.md"), "utf8");
			expect(skillMd, `${name}/SKILL.md still references ../../commands/`).not.toContain("../../commands/");
		}
	});

	it("every generated codex wrapper skill resolves its ./command.md reference when copied alone", () => {
		for (const name of listWrapperSkillNames()) {
			const dest = join(tmpDir, name);
			cpSync(join(CODEX_PKG, "skills", name), dest, { recursive: true });

			const skillMd = readFileSync(join(dest, "SKILL.md"), "utf8");
			const match = skillMd.match(/Read `(\.\/[^`]+)`/);
			expect(match, `${name}/SKILL.md: expected a ./... reference`).not.toBeNull();
			const resolved = join(dest, match?.[1] as string);
			expect(existsSync(resolved), `${name}/SKILL.md: ${match?.[1]} did not resolve standalone`).toBe(true);
		}
	});

	it("regression guard: the dangling ../../ form would NOT resolve if it reappeared (proves the assertion is meaningful)", () => {
		const dest = join(tmpDir, "atomic-commit-old-form");
		cpSync(join(CODEX_PKG, "skills/atomic-commit"), dest, { recursive: true });
		const danglingRef = "../../commands/atomic-commit.md";
		const resolved = join(dest, danglingRef);
		expect(existsSync(resolved)).toBe(false);
	});
});
