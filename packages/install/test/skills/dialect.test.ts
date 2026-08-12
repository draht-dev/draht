import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_PKG, CODEX_PKG } from "./skill-tree.ts";

// Unambiguous, host-specific markers. Deliberately narrower than the
// portability.test.ts allowlist logic: generic words like "subagents"
// legitimately appear in both dialects' output, so this test anchors only on
// strings that can only ever appear on one side of the historical
// hand-maintained diff (see scripts/skills-dialect-table.mjs).
const CODEX_ONLY_MARKERS = ["spawn_agent", "$draht", "/draht:"];
const CLAUDE_ONLY_MARKERS = ["Task tool", "subagent_type"];

// The draht router skill intentionally documents both hosts' invocation
// surfaces side by side and renders identically into both packages, so it is
// exempt from this specific claude-vs-codex isolation check (portability.test.ts
// covers precisely which markers are allowed where inside that one file).
const SHARED_FILE_EXEMPTIONS = new Set(["skills/draht/SKILL.md"]);

function listFilesRecursively(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(full);
		}
	};
	walk(root);
	return out;
}

function relPath(pkgRoot: string, full: string): string {
	return full.slice(pkgRoot.length + 1);
}

function generatedMarkdownFiles(pkgRoot: string): Array<{ relPath: string; content: string }> {
	return listFilesRecursively(pkgRoot)
		.filter((full) => full.endsWith(".md"))
		.filter((full) => relPath(pkgRoot, full).startsWith("commands/") || relPath(pkgRoot, full).startsWith("skills/"))
		.map((full) => ({ relPath: relPath(pkgRoot, full), content: readFileSync(full, "utf8") }));
}

describe("dialect: generated claude files contain no codex-only markers", () => {
	const files = generatedMarkdownFiles(CLAUDE_PKG).filter((f) => !SHARED_FILE_EXEMPTIONS.has(f.relPath));

	it("scans a non-trivial number of files (proves this rule is exercised, not vacuous)", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	for (const file of files) {
		for (const marker of CODEX_ONLY_MARKERS) {
			it(`packages/draht-claude/${file.relPath} does not contain "${marker}"`, () => {
				expect(file.content).not.toContain(marker);
			});
		}
	}
});

describe("dialect: generated codex files contain no claude-only markers", () => {
	const files = generatedMarkdownFiles(CODEX_PKG).filter((f) => !SHARED_FILE_EXEMPTIONS.has(f.relPath));

	it("scans a non-trivial number of files (proves this rule is exercised, not vacuous)", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	for (const file of files) {
		for (const marker of CLAUDE_ONLY_MARKERS) {
			it(`packages/draht-codex/${file.relPath} does not contain "${marker}"`, () => {
				expect(file.content).not.toContain(marker);
			});
		}
	}
});

describe("dialect: the markers this test anchors on actually occur somewhere (proves the negative checks above are meaningful)", () => {
	it("at least one packages/draht-codex file contains spawn_agent", () => {
		const hit = generatedMarkdownFiles(CODEX_PKG).some((f) => f.content.includes("spawn_agent"));
		expect(hit).toBe(true);
	});

	it("at least one packages/draht-codex file contains $draht", () => {
		const hit = generatedMarkdownFiles(CODEX_PKG).some((f) => f.content.includes("$draht"));
		expect(hit).toBe(true);
	});

	it("at least one packages/draht-claude file contains Task tool", () => {
		const hit = generatedMarkdownFiles(CLAUDE_PKG).some((f) => f.content.includes("Task tool"));
		expect(hit).toBe(true);
	});

	it("at least one packages/draht-claude file contains subagent_type", () => {
		const hit = generatedMarkdownFiles(CLAUDE_PKG).some((f) => f.content.includes("subagent_type"));
		expect(hit).toBe(true);
	});
});

describe("dialect: the exempted shared file really does mention both hosts (proves the exemption is real, not a loophole)", () => {
	it("packages/draht-claude/skills/draht/SKILL.md mentions Codex", () => {
		const content = readFileSync(join(CLAUDE_PKG, "skills/draht/SKILL.md"), "utf8");
		expect(content).toMatch(/\bCodex\b/);
	});

	it("packages/draht-codex/skills/draht/SKILL.md mentions Claude", () => {
		const content = readFileSync(join(CODEX_PKG, "skills/draht/SKILL.md"), "utf8");
		expect(content).toMatch(/\bClaude\b/);
	});
});
