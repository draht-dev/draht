import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeArtifacts } from "../../../../scripts/generate-skills-artifacts.mjs";
import { CLAUDE_PKG, CODEX_PKG, GENERATOR_SCRIPT, REPO_ROOT, SKILLS_ROOT } from "./skill-tree.ts";

function run(args: string[]): string {
	return execFileSync(process.execPath, [GENERATOR_SCRIPT, ...args], { encoding: "utf8" });
}

/** Recursively collect { relPath: content } for every file under a directory. */
function collectFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else {
				files[relative(root, full)] = readFileSync(full, "utf8");
			}
		}
	};
	walk(root);
	return files;
}

describe("generate-skills-artifacts: computeArtifacts is a pure function", () => {
	it("calling it twice on the same skillsRoot yields byte-identical artifact lists", () => {
		const first = computeArtifacts(SKILLS_ROOT);
		const second = computeArtifacts(SKILLS_ROOT);
		expect(second).toEqual(first);
	});

	it("discovers 90 artifacts from the 28 canonical skills", () => {
		const artifacts = computeArtifacts(SKILLS_ROOT);
		expect(artifacts.length).toBe(90);
	});

	it("emits no packages/draht-claude skills/<cmd>/ wrapper artifacts (no wrapper skills on the claude side)", () => {
		const artifacts = computeArtifacts(SKILLS_ROOT);
		const claudeCommandWrapperSkills = artifacts.filter(
			(a) => a.pkg === "draht-claude" && a.relPath.startsWith("skills/") && a.relPath.endsWith("/command.md"),
		);
		expect(claudeCommandWrapperSkills).toEqual([]);
	});

	it("emits a codex skills/<cmd>/command.md that is byte-identical to codex commands/<cmd>.md, for every command skill", () => {
		const artifacts = computeArtifacts(SKILLS_ROOT);
		const codexCommands = new Map(
			artifacts
				.filter((a) => a.pkg === "draht-codex" && a.relPath.startsWith("commands/"))
				.map((a) => [a.relPath, a.content]),
		);
		const wrapperCommandCopies = artifacts.filter(
			(a) => a.pkg === "draht-codex" && a.relPath.startsWith("skills/") && a.relPath.endsWith("/command.md"),
		);
		expect(wrapperCommandCopies.length).toBeGreaterThan(0);
		for (const wrapper of wrapperCommandCopies) {
			const cmdName = wrapper.relPath.replace(/^skills\//, "").replace(/\/command\.md$/, "");
			expect(wrapper.content).toBe(codexCommands.get(`commands/${cmdName}.md`));
		}
	});
});

describe("generate-skills-artifacts: CLI, isolated in a temp output root", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "draht-skills-gen-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("running the generator twice into a temp output root produces byte-identical files on disk", () => {
		run(["--output-root", tmpRoot]);
		const first = collectFiles(join(tmpRoot, "packages"));
		run(["--output-root", tmpRoot]);
		const second = collectFiles(join(tmpRoot, "packages"));
		expect(second).toEqual(first);
	});

	it("regenerated output into a temp root matches the real committed package files", () => {
		run(["--output-root", tmpRoot]);
		const generated = collectFiles(join(tmpRoot, "packages"));
		expect(Object.keys(generated).length).toBe(90);
		for (const [relPath, content] of Object.entries(generated)) {
			const committedPath = join(REPO_ROOT, "packages", relPath);
			expect(readFileSync(committedPath, "utf8"), `${relPath} differs from the committed file`).toBe(content);
		}
	});

	it("--check exits 0 against a fresh untampered copy of the committed packages", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });

		expect(() => run(["--check", "--output-root", tmpRoot])).not.toThrow();
	});

	it("--check exits non-zero and reports drift when a copied file is tampered (never touches the real tree)", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		const tamperedFile = join(tmpRoot, "packages/draht-claude/skills/atomic-reasoning/SKILL.md");
		const before = readFileSync(tamperedFile, "utf8");
		writeFileSync(tamperedFile, "tampered content that does not match the generator's rendering\n");

		let threw = false;
		try {
			run(["--check", "--output-root", tmpRoot]);
		} catch (error) {
			threw = true;
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			expect(stderr).toContain("atomic-reasoning/SKILL.md");
		}
		expect(threw).toBe(true);

		// Prove the tamper stayed confined to the temp copy.
		const realFile = join(CLAUDE_PKG, "skills/atomic-reasoning/SKILL.md");
		expect(readFileSync(realFile, "utf8")).not.toBe(
			"tampered content that does not match the generator's rendering\n",
		);
		expect(readFileSync(tamperedFile, "utf8")).not.toBe(before);
	});

	it("--check exits non-zero when a generated file is missing entirely from the copy", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		rmSync(join(tmpRoot, "packages/draht-codex/skills/draht"), { recursive: true, force: true });

		expect(() => run(["--check", "--output-root", tmpRoot])).toThrow();
	});
});
