import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomainModel, mapCodebase } from "../src/gsd/domain.js";

describe("gsd domain", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-domain-test-"));
		fs.mkdirSync(path.join(tempDir, ".planning"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("createDomainModel", () => {
		it("throws when PROJECT.md is missing", () => {
			expect(() => createDomainModel(tempDir)).toThrow();
		});

		it("creates DOMAIN-MODEL.md when PROJECT.md exists", () => {
			fs.writeFileSync(
				path.join(tempDir, ".planning", "PROJECT.md"),
				"# Project: Test\n\n## Vision\nTest project.\n",
				"utf-8",
			);
			const outPath = createDomainModel(tempDir);
			expect(fs.existsSync(outPath)).toBe(true);
			expect(outPath).toContain("DOMAIN-MODEL.md");
		});

		it("DOMAIN-MODEL.md contains required sections", () => {
			fs.writeFileSync(path.join(tempDir, ".planning", "PROJECT.md"), "# Project: Test\n", "utf-8");
			const outPath = createDomainModel(tempDir);
			const content = fs.readFileSync(outPath, "utf-8");
			expect(content).toContain("## Bounded Contexts");
			expect(content).toContain("## Ubiquitous Language Glossary");
		});
	});

	describe("mapCodebase", () => {
		beforeEach(() => {
			// Create minimal source files for codebase scanning
			fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");
			fs.writeFileSync(
				path.join(tempDir, "package.json"),
				JSON.stringify({ name: "test-project", dependencies: {} }),
				"utf-8",
			);
		});

		it("creates all expected codebase files", () => {
			const files = mapCodebase(tempDir);
			const expectedNames = ["STACK.md", "ARCHITECTURE.md", "CONVENTIONS.md", "CONCERNS.md", "DOMAIN-HINTS.md"];
			for (const name of expectedNames) {
				expect(files.some((f) => f.endsWith(name))).toBe(true);
			}
		});

		it("STACK.md contains file tree section", () => {
			mapCodebase(tempDir);
			const stackPath = path.join(tempDir, ".planning", "codebase", "STACK.md");
			const content = fs.readFileSync(stackPath, "utf-8");
			expect(content).toContain("## File Tree");
		});

		it("STACK.md contains package info", () => {
			mapCodebase(tempDir);
			const stackPath = path.join(tempDir, ".planning", "codebase", "STACK.md");
			const content = fs.readFileSync(stackPath, "utf-8");
			expect(content).toContain("test-project");
		});

		it("creates codebase/ directory under .planning/", () => {
			mapCodebase(tempDir);
			expect(fs.existsSync(path.join(tempDir, ".planning", "codebase"))).toBe(true);
		});
	});
});
