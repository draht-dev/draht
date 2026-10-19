import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, loadSkillsFromDir } from "../src/core/skills.ts";

describe("portable workflow invocation policy", () => {
	it("keeps explicit workflows discoverable by name but out of native model-selected skills", () => {
		const result = loadSkillsFromDir({ dir: resolve("../../skills"), source: "path" });
		const names =
			"triage fix quick new-project init-project discuss-phase plan-phase execute-phase verify-work next-milestone pause-work resume-work progress gsd-workflow".split(
				" ",
			);
		const prompt = formatSkillsForPrompt(result.skills);
		for (const name of names) {
			const skill = result.skills.find((entry) => entry.name === name);
			expect(skill, name).toBeDefined();
			expect(skill?.disableModelInvocation, name).toBe(true);
			expect(prompt).not.toContain(`<name>${name}</name>`);
		}
		expect(prompt).toContain("<name>typescript-discipline</name>");
	});
});
