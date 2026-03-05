import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitDocs, commitTask, hasTestFiles } from "../src/gsd/git.js";

describe("gsd git", () => {
	describe("hasTestFiles", () => {
		it("returns true when list contains a .test.ts file", () => {
			expect(hasTestFiles(["src/foo.ts", "test/foo.test.ts"])).toBe(true);
		});

		it("returns false when no test files present", () => {
			expect(hasTestFiles(["src/foo.ts", "src/bar.ts"])).toBe(false);
		});

		it("returns true for .spec.ts files", () => {
			expect(hasTestFiles(["src/foo.spec.ts"])).toBe(true);
		});

		it("returns true for Go _test.go files", () => {
			expect(hasTestFiles(["src/foo_test.go"])).toBe(true);
		});

		it("returns true for .test.js files", () => {
			expect(hasTestFiles(["test/bar.test.js"])).toBe(true);
		});

		it("returns false for empty list", () => {
			expect(hasTestFiles([])).toBe(false);
		});
	});

	describe("commitTask and commitDocs", () => {
		let repoDir: string;

		beforeEach(() => {
			repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-git-test-"));
			execSync("git init", { cwd: repoDir });
			execSync('git config user.email "test@test.com"', { cwd: repoDir });
			execSync('git config user.name "Test"', { cwd: repoDir });
			// Initial commit so we have a HEAD
			fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n", "utf-8");
			execSync("git add README.md && git commit -m 'init'", { cwd: repoDir });
		});

		afterEach(() => {
			fs.rmSync(repoDir, { recursive: true, force: true });
		});

		it("commitTask returns a hash when there are staged changes", () => {
			fs.writeFileSync(path.join(repoDir, "src.ts"), "export const x = 1;\n", "utf-8");
			const result = commitTask(repoDir, 19, 1, "red: write failing tests");
			expect(result.hash).toBeTruthy();
			expect(result.hash).toHaveLength(40);
		});

		it("commitTask returns null hash when nothing to commit", () => {
			const result = commitTask(repoDir, 19, 1, "empty commit");
			expect(result.hash).toBeNull();
		});

		it("commitTask uses feat(NN-NN): prefix in message", () => {
			fs.writeFileSync(path.join(repoDir, "impl.ts"), "export const y = 2;\n", "utf-8");
			const result = commitTask(repoDir, 19, 1, "green: implement feature");
			expect(result.hash).toBeTruthy();
			const msg = execSync(`git log --format=%s -n 1 ${result.hash}`, {
				cwd: repoDir,
				encoding: "utf-8",
			}).trim();
			expect(msg).toBe("feat(19-01): green: implement feature");
		});

		it("commitTask sets tddWarning=true when no test files committed", () => {
			fs.writeFileSync(path.join(repoDir, "impl.ts"), "export const z = 3;\n", "utf-8");
			const result = commitTask(repoDir, 19, 1, "green: no tests");
			expect(result.tddWarning).toBe(true);
		});

		it("commitTask sets tddWarning=false when test files are committed", () => {
			fs.writeFileSync(path.join(repoDir, "foo.test.ts"), "it('works', () => {});\n", "utf-8");
			const result = commitTask(repoDir, 19, 1, "red: add tests");
			expect(result.tddWarning).toBe(false);
		});

		it("commitDocs returns a hash and uses docs: prefix", () => {
			fs.writeFileSync(path.join(repoDir, "README.md"), "# Updated\n", "utf-8");
			const result = commitDocs(repoDir, "update planning docs");
			expect(result.hash).toBeTruthy();
			const msg = execSync(`git log --format=%s -n 1 ${result.hash}`, {
				cwd: repoDir,
				encoding: "utf-8",
			}).trim();
			expect(msg).toBe("docs: update planning docs");
		});
	});
});
