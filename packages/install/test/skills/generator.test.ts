import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

	it("discovers 114 artifacts from the 35 canonical skills", () => {
		const artifacts = computeArtifacts(SKILLS_ROOT);
		expect(artifacts.length).toBe(114);
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

describe("generate-skills-artifacts: plain-skill extra files, on a synthetic skills root", () => {
	let tmpSkillsRoot: string;

	beforeEach(() => {
		tmpSkillsRoot = mkdtempSync(join(tmpdir(), "draht-skills-extra-"));
	});

	afterEach(() => {
		rmSync(tmpSkillsRoot, { recursive: true, force: true });
	});

	function writeFile(relPath: string, content: string): void {
		const full = join(tmpSkillsRoot, relPath);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}

	it("mirrors a plain skill's references/ file into both packages verbatim", () => {
		writeFile("plain/SKILL.md", "---\nname: plain\ndescription: fixture\n---\nsee `./references/patterns.md`\n");
		writeFile("plain/references/patterns.md", "worked examples\n");

		const artifacts = computeArtifacts(tmpSkillsRoot);
		const extras = artifacts.filter((a: { relPath: string }) => a.relPath === "skills/plain/references/patterns.md");
		expect(extras.map((a: { pkg: string }) => a.pkg).sort()).toEqual(["draht-claude", "draht-codex"]);
		for (const extra of extras) expect(extra.content).toBe("worked examples\n");
	});

	it("resolves the generic <PLUGIN_ROOT> token per host inside extra files", () => {
		writeFile("plain/SKILL.md", "---\nname: plain\ndescription: fixture\n---\nbody\n");
		writeFile("plain/references/tool-note.md", "run <PLUGIN_ROOT>/scripts/tool.cjs\n");

		const artifacts = computeArtifacts(tmpSkillsRoot);
		const byPkg = new Map(
			artifacts
				.filter((a: { relPath: string }) => a.relPath === "skills/plain/references/tool-note.md")
				.map((a: { pkg: string; content: string }) => [a.pkg, a.content]),
		);
		expect(byPkg.get("draht-claude")).not.toContain("<PLUGIN_ROOT>");
		expect(byPkg.get("draht-codex")).not.toContain("<PLUGIN_ROOT>");
		expect(byPkg.get("draht-claude")).not.toBe(byPkg.get("draht-codex"));
	});

	it("rejects extra files under a command skill (no claude-side skills/<cmd>/ dir exists to receive them)", () => {
		writeFile("cmd/SKILL.md", "---\nname: cmd\ndescription: fixture\n---\nbody\n");
		writeFile("cmd/command.md", "command template\n");
		writeFile("cmd/references/notes.md", "stray\n");

		expect(() => computeArtifacts(tmpSkillsRoot)).toThrow(/only supported for plain skills/);
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
		expect(Object.keys(generated).length).toBe(114);
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

	it("--check exits non-zero and says 'unexpected' for a stray file inside a generated skill dir", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		writeFileSync(join(tmpRoot, "packages/draht-codex/skills/fix/notes.md"), "hand-added, not generated\n");

		let threw = false;
		try {
			run(["--check", "--output-root", tmpRoot]);
		} catch (error) {
			threw = true;
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			expect(stderr).toContain("unexpected");
			expect(stderr).toContain("skills/fix/notes.md");
		}
		expect(threw).toBe(true);
	});

	it("--check exits non-zero for a whole skill dir that is neither generated nor allowlisted", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		mkdirSync(join(tmpRoot, "packages/draht-claude/skills/rogue"), { recursive: true });
		writeFileSync(join(tmpRoot, "packages/draht-claude/skills/rogue/SKILL.md"), "---\nname: rogue\n---\n");

		let threw = false;
		try {
			run(["--check", "--output-root", tmpRoot]);
		} catch (error) {
			threw = true;
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			expect(stderr).toContain("unexpected");
			expect(stderr).toContain("skills/rogue/SKILL.md");
		}
		expect(threw).toBe(true);
	});

	it("--check tolerates files inside an allowlisted hand-mirrored skill dir (pair identity is the mirror gate's job)", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		// cinematic-continuation is already present from the copy; add one more
		// file inside it to prove the exemption covers the whole dir, not just
		// the files that happen to exist today.
		writeFileSync(
			join(tmpRoot, "packages/draht-claude/skills/cinematic-continuation/references/extra.md"),
			"hand-mirrored extension\n",
		);

		expect(() => run(["--check", "--output-root", tmpRoot])).not.toThrow();
	});

	it("--check exits non-zero for a stray file under commands/", () => {
		cpSync(CLAUDE_PKG, join(tmpRoot, "packages/draht-claude"), { recursive: true });
		cpSync(CODEX_PKG, join(tmpRoot, "packages/draht-codex"), { recursive: true });
		writeFileSync(join(tmpRoot, "packages/draht-claude/commands/rogue.md"), "not generated\n");

		let threw = false;
		try {
			run(["--check", "--output-root", tmpRoot]);
		} catch (error) {
			threw = true;
			const stderr = String((error as { stderr?: unknown }).stderr ?? "");
			expect(stderr).toContain("unexpected");
			expect(stderr).toContain("commands/rogue.md");
		}
		expect(threw).toBe(true);
	});
});
