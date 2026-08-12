import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { listCanonicalSkills, relativeToSkillsRoot } from "./skill-tree.ts";

// ── Host-dialect marker rule ────────────────────────────────────────────────
// Canonical bodies must never hardcode a host-specific dispatch mechanism or
// identity word. "Claude"/"Codex" are matched as standalone words so that
// compound package names (draht-claude, draht-codex — always lowercase) do
// not trip the check.
const DIALECT_MARKER_RE = /Task tool|subagent_type|spawn_agent|\$draht|\/draht:|\bClaude\b|\bCodex\b/g;

// Model brand names are allowed everywhere — they name a model, not a host or
// a dispatch mechanism, and the same names appear identically in both the
// claude and codex renderings.
const BRAND_NAME_ALLOWLIST = ["Claude Fable 5", "Claude Sonnet 5", "Claude API"];

// skills/draht/SKILL.md is the one skill whose job is to describe every
// host's invocation surface, so its "## Host Invocation" table is allowed to
// name hosts. Nothing else in that file (or any other file) is exempt.
const HOST_TABLE_HEADING = "## Host Invocation";

function extractSection(body: string, heading: string): string {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start === -1) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

function stripBrandNames(content: string): string {
	let out = content;
	for (const brand of BRAND_NAME_ALLOWLIST) out = out.split(brand).join("");
	return out;
}

// ── ../ traversal allowlist ──────────────────────────────────────────────────
// Every entry documents exactly why a "../" occurrence is not a real
// cross-skill reference.
const TRAVERSAL_ALLOWLIST: Array<{ relPath: string; snippet: string; reason: string }> = [
	{
		relPath: "ddd-workflow/SKILL.md",
		snippet: "'../billing/...'",
		reason:
			"pedagogical anti-pattern example (a hypothetical illegal cross-context import) inside inline code — not a real relative reference, and not resolved against anything.",
	},
	{
		relPath: "saga-spawner/SKILL.md",
		snippet: "npx tsx ../../node_modules/vitest/dist/cli.js",
		reason:
			"example beat `check` command inside the saga-graph YAML sample — a shell command resolved against a package root at beat-execution time, not a reference relative to the skill directory. Counts as 2 occurrences (../..).",
	},
];

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

// ── Absolute-path heuristic ──────────────────────────────────────────────────
// Flags a "/" that starts a multi-segment path token (preceded by
// whitespace/punctuation, not by a word character, ":", ".", "-" or another
// "/"). This deliberately does not flag single-segment slash-command
// mentions like `/fix` or URL bodies like "https://...".
const ABS_PATH_RE = /(?<![\w:./-])\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*/g;

function allSkillFiles() {
	const files: Array<{ relPath: string; path: string; dir: string; skillName: string }> = [];
	for (const skill of listCanonicalSkills()) {
		files.push({
			relPath: relativeToSkillsRoot(skill.skillMdPath),
			path: skill.skillMdPath,
			dir: skill.dir,
			skillName: skill.name,
		});
		if (skill.commandMdPath) {
			files.push({
				relPath: relativeToSkillsRoot(skill.commandMdPath),
				path: skill.commandMdPath,
				dir: skill.dir,
				skillName: skill.name,
			});
		}
	}
	return files;
}

describe("portability: no ../ traversal outside the documented allowlist", () => {
	for (const file of allSkillFiles()) {
		it(`${file.relPath}: every ../ occurrence is covered by a documented allowlist entry`, () => {
			const content = readFileSync(file.path, "utf8");
			const total = countOccurrences(content, "../");
			const entries = TRAVERSAL_ALLOWLIST.filter((entry) => entry.relPath === file.relPath);
			let covered = 0;
			for (const entry of entries) {
				expect(content, `allowlisted snippet no longer present in ${file.relPath}`).toContain(entry.snippet);
				covered += countOccurrences(entry.snippet, "../");
			}
			expect(total, `${file.relPath} has ${total} "../" occurrence(s) but only ${covered} are allowlisted`).toBe(
				covered,
			);
		});
	}

	it("the allowlist itself is non-empty (proves this rule is exercised, not vacuous)", () => {
		expect(TRAVERSAL_ALLOWLIST.length).toBeGreaterThan(0);
	});
});

describe("portability: no absolute paths", () => {
	for (const file of allSkillFiles()) {
		it(`${file.relPath}: contains no absolute-path-shaped token`, () => {
			const content = readFileSync(file.path, "utf8").split("<PLUGIN_ROOT>").join("PLUGINROOT");
			expect(content.match(ABS_PATH_RE)).toBeNull();
		});
	}
});

describe("portability: no plugin-root env-var tokens", () => {
	for (const file of allSkillFiles()) {
		it(`${file.relPath}: contains no \${CLAUDE_PLUGIN_ROOT} / \${PLUGIN_ROOT... token`, () => {
			const content = readFileSync(file.path, "utf8");
			// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal substring is absent, not building a template
			expect(content.includes("${CLAUDE_PLUGIN_ROOT}")).toBe(false);
			expect(content.includes("${PLUGIN_ROOT")).toBe(false);
		});
	}
});

describe("portability: no host-dialect markers outside the allowlist", () => {
	for (const file of allSkillFiles()) {
		it(`${file.relPath}: has no host-dialect markers outside the allowlist`, () => {
			let scanText = stripBrandNames(readFileSync(file.path, "utf8"));
			if (file.relPath === "draht/SKILL.md") {
				const section = extractSection(scanText, HOST_TABLE_HEADING);
				expect(section, "expected draht/SKILL.md to contain a Host Invocation section").not.toBe("");
				scanText = scanText.split(section).join("");
			}
			expect(scanText.match(DIALECT_MARKER_RE)).toBeNull();
		});
	}

	it("model-tiering/SKILL.md actually contains the brand names the allowlist strips (proves the rule is exercised)", () => {
		const content = readFileSync(
			resolve(listCanonicalSkills().find((s) => s.name === "model-tiering")!.skillMdPath),
			"utf8",
		);
		for (const brand of BRAND_NAME_ALLOWLIST) {
			expect(content).toContain(brand);
		}
	});

	it("draht/SKILL.md's Host Invocation section actually contains host markers (proves the allowlist is scoped precisely, not accidentally over-broad)", () => {
		const skill = listCanonicalSkills().find((s) => s.name === "draht")!;
		const content = readFileSync(skill.skillMdPath, "utf8");
		const section = extractSection(content, HOST_TABLE_HEADING);
		expect(section).toMatch(/\bClaude\b/);
		expect(section).toMatch(/\bCodex\b/);
		expect(section).toMatch(/\$draht/);
		expect(section).toMatch(/\/draht:/);
	});
});

describe("portability: every ./ relative reference resolves inside the same skill dir", () => {
	let totalRefsFound = 0;

	for (const file of allSkillFiles()) {
		const content = readFileSync(file.path, "utf8");
		const refs = [...content.matchAll(/`(\.\/[^`\s]+)`/g)].map((match) => match[1]);
		if (refs.length === 0) continue;
		totalRefsFound += refs.length;

		it(`${file.relPath}: every ./ reference resolves to a file inside ${file.skillName}/`, () => {
			for (const ref of refs) {
				const resolved = resolve(file.dir, ref);
				expect(existsSync(resolved), `${ref} (from ${file.relPath}) does not resolve to an existing file`).toBe(
					true,
				);
				const isInsideSkillDir = resolved === file.dir || resolved.startsWith(file.dir + sep);
				expect(isInsideSkillDir, `${ref} (from ${file.relPath}) resolves outside its own skill dir`).toBe(true);
			}
		});
	}

	it("found at least one ./ reference across the corpus (proves this rule is exercised, not vacuous)", () => {
		expect(totalRefsFound).toBeGreaterThan(0);
	});
});
