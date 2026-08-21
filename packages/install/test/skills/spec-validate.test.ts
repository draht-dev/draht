import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listCanonicalSkills, parseFrontmatterFields, splitFrontmatter } from "./skill-tree.ts";

// Agent Skills frontmatter rules (see the task brief / packages/coding-agent
// docs/skills.md for the wider spec this repo's skills must satisfy).
const ALLOWED_KEYS = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
const REQUIRED_KEYS = ["description", "name"];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function isFlatStringMap(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

describe("spec-validate: skills/*/SKILL.md frontmatter", () => {
	const skills = listCanonicalSkills();

	it("discovers exactly 35 canonical skills (13 disciplines + 21 commands + draht)", () => {
		expect(skills.length).toBe(35);
	});

	for (const skill of skills) {
		describe(skill.name, () => {
			const raw = readFileSync(skill.skillMdPath, "utf8");
			const { frontmatterLines } = splitFrontmatter(raw);
			const fields = parseFrontmatterFields(frontmatterLines);

			it("has frontmatter keys that are a subset of the allowed Agent Skills keys", () => {
				for (const key of Object.keys(fields)) {
					expect(ALLOWED_KEYS.has(key), `unexpected frontmatter key "${key}"`).toBe(true);
				}
			});

			it("has exactly name and description present, nothing else", () => {
				expect(Object.keys(fields).sort()).toEqual(REQUIRED_KEYS);
			});

			it(`has a name <= ${MAX_NAME_LENGTH} chars, lowercase alnum+hyphen, no edge/consecutive hyphens`, () => {
				expect(fields.name.length).toBeGreaterThan(0);
				expect(fields.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
				expect(fields.name).toMatch(NAME_RE);
			});

			it("has name equal to its own directory name", () => {
				expect(fields.name).toBe(skill.name);
			});

			it(`has a non-empty description <= ${MAX_DESCRIPTION_LENGTH} chars`, () => {
				expect(fields.description.length).toBeGreaterThan(0);
				expect(fields.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
			});
		});
	}
});

describe("spec-validate: name format rule, exercised directly (not tied to real files)", () => {
	it.each([
		["pdf-processing", true],
		["data-analysis", true],
		["a", true],
		["a1-b2", true],
		["PDF-Processing", false],
		["-pdf", false],
		["pdf-", false],
		["pdf--processing", false],
		["pdf_processing", false],
		["", false],
	])("NAME_RE.test(%j) === %j", (candidate, expected) => {
		expect(NAME_RE.test(candidate) && candidate.length > 0).toBe(expected);
	});
});

describe("spec-validate: metadata shape rule, exercised directly (no real skill uses metadata today)", () => {
	it("accepts a flat string-to-string metadata map", () => {
		expect(isFlatStringMap({ a: "1", b: "2" })).toBe(true);
	});

	it("accepts an empty metadata map", () => {
		expect(isFlatStringMap({})).toBe(true);
	});

	it("rejects metadata with a non-string value", () => {
		expect(isFlatStringMap({ a: 1 })).toBe(false);
	});

	it("rejects metadata that is an array", () => {
		expect(isFlatStringMap(["a", "b"])).toBe(false);
	});

	it("rejects metadata that is nested", () => {
		expect(isFlatStringMap({ a: { b: "1" } })).toBe(false);
	});

	it("rejects metadata that is not an object", () => {
		expect(isFlatStringMap("nope")).toBe(false);
		expect(isFlatStringMap(null)).toBe(false);
	});
});
