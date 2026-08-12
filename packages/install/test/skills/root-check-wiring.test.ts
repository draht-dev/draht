import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./skill-tree.ts";

// The byte-equality gate only protects the tree if it actually runs. The
// design spec wires `generate-skills-artifacts.mjs --check` into three
// places: both plugin packages' prepublishOnly (publish-time) and the root
// `npm run check` (development-time, and therefore the pre-commit hook).
// These assertions pin the wiring itself so it cannot silently fall out of
// the check chain.

describe("root npm run check executes the skills artifact equality gate", () => {
	const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

	it("declares a check:skills-artifacts script that runs the generator in --check mode", () => {
		expect(rootPkg.scripts["check:skills-artifacts"]).toBe("node scripts/generate-skills-artifacts.mjs --check");
	});

	it("includes check:skills-artifacts in the check chain", () => {
		expect(rootPkg.scripts.check).toContain("npm run check:skills-artifacts");
	});
});

describe("both plugin packages keep the publish-time gate", () => {
	for (const pkg of ["draht-claude", "draht-codex"]) {
		it(`${pkg} prepublishOnly runs generate-skills-artifacts.mjs --check`, () => {
			const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"));
			expect(pkgJson.scripts.prepublishOnly).toContain("generate-skills-artifacts.mjs --check");
		});
	}
});
