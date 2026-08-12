import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listCanonicalSkills, relativeToSkillsRoot } from "./skill-tree.ts";

const MAX_LINES = 500;

function lineCount(path: string): number {
	return readFileSync(path, "utf8").split("\n").length;
}

describe(`size: every SKILL.md and command.md is <= ${MAX_LINES} lines`, () => {
	const skills = listCanonicalSkills();

	it("has at least one command.md in the corpus (proves this rule covers both file kinds)", () => {
		expect(skills.some((skill) => skill.commandMdPath !== null)).toBe(true);
	});

	for (const skill of skills) {
		it(`${relativeToSkillsRoot(skill.skillMdPath)} <= ${MAX_LINES} lines`, () => {
			expect(lineCount(skill.skillMdPath)).toBeLessThanOrEqual(MAX_LINES);
		});

		if (skill.commandMdPath) {
			const commandMdPath = skill.commandMdPath;
			it(`${relativeToSkillsRoot(commandMdPath)} <= ${MAX_LINES} lines`, () => {
				expect(lineCount(commandMdPath)).toBeLessThanOrEqual(MAX_LINES);
			});
		}
	}
});
