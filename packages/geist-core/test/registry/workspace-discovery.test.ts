import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceProjects, slugify } from "../../src/registry/workspace-discovery.js";

let workspaceRoot: string;

beforeEach(() => {
	workspaceRoot = mkdtempSync(join(tmpdir(), "workspace-discovery-test-"));
});

afterEach(() => {
	rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Creates `<workspaceRoot>/<name>`, optionally marking it as a git repo with a `.git` dir. */
function makeSubdir(name: string, { git }: { git: boolean }): string {
	const dir = join(workspaceRoot, name);
	mkdirSync(dir, { recursive: true });
	if (git) {
		mkdirSync(join(dir, ".git"));
	}
	return dir;
}

describe("discoverWorkspaceProjects", () => {
	test("finds immediate subdirectories with a .git dir marker", () => {
		makeSubdir("fr3n", { git: true });
		makeSubdir("kintura", { git: true });

		const projects = discoverWorkspaceProjects([workspaceRoot]);

		expect(projects.map((p) => p.slug).sort()).toEqual(["fr3n", "kintura"]);
	});

	test("skips subdirectories with no .git marker", () => {
		makeSubdir("fr3n", { git: true });
		makeSubdir("not-a-repo", { git: false });

		const projects = discoverWorkspaceProjects([workspaceRoot]);

		expect(projects.map((p) => p.slug)).toEqual(["fr3n"]);
	});

	test("recognizes a .git FILE (linked worktree marker), not only a .git dir", () => {
		const dir = makeSubdir("fr3n-wt", { git: false });
		writeFileSync(join(dir, ".git"), "gitdir: /somewhere/else/.git/worktrees/fr3n-wt\n");

		const projects = discoverWorkspaceProjects([workspaceRoot]);

		expect(projects.map((p) => p.slug)).toEqual(["fr3n-wt"]);
	});

	test("populates slug, name, and an absolute root path", () => {
		const dir = makeSubdir("fr3n", { git: true });

		const [project] = discoverWorkspaceProjects([workspaceRoot]);

		expect(project).toEqual({ slug: "fr3n", name: "fr3n", root: dir });
	});

	test("does not recurse past immediate subdirectories", () => {
		const outer = makeSubdir("outer", { git: false });
		mkdirSync(join(outer, "inner"), { recursive: true });
		mkdirSync(join(outer, "inner", ".git"));

		const projects = discoverWorkspaceProjects([workspaceRoot]);

		expect(projects).toEqual([]);
	});

	test("scans multiple workspaceRoots", () => {
		const secondRoot = mkdtempSync(join(tmpdir(), "workspace-discovery-test-2-"));
		try {
			makeSubdir("fr3n", { git: true });
			mkdirSync(join(secondRoot, "kintura"), { recursive: true });
			mkdirSync(join(secondRoot, "kintura", ".git"));

			const projects = discoverWorkspaceProjects([workspaceRoot, secondRoot]);

			expect(projects.map((p) => p.slug).sort()).toEqual(["fr3n", "kintura"]);
		} finally {
			rmSync(secondRoot, { recursive: true, force: true });
		}
	});

	test("silently skips a workspaceRoot that does not exist", () => {
		const missing = join(workspaceRoot, "does-not-exist");

		expect(discoverWorkspaceProjects([missing])).toEqual([]);
	});

	test("empty workspaceRoots list yields no projects", () => {
		expect(discoverWorkspaceProjects([])).toEqual([]);
	});
});

describe("slugify", () => {
	test("lowercases and passes through already-clean names", () => {
		expect(slugify("fr3n")).toBe("fr3n");
	});

	test("collapses whitespace and punctuation runs into a single hyphen", () => {
		expect(slugify("My Cool Project!!")).toBe("my-cool-project");
	});

	test("trims leading/trailing separators", () => {
		expect(slugify("  --Weird Name--  ")).toBe("weird-name");
	});

	test("falls back to the lowercased original when nothing slug-safe remains", () => {
		expect(slugify("§§§")).toBe("§§§");
	});
});
