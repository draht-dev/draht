#!/usr/bin/env node
/**
 * Drift gate for the hand-maintained plugin mirrors.
 *
 * draht-claude and draht-codex ship the same agents, scripts, and hooks,
 * differing only in two mechanical dimensions:
 *   1. plugin-root path token (CLAUDE_PLUGIN_ROOT vs PLUGIN_ROOT fallback chain)
 *   2. subagent dispatch phrasing (Task tool / subagent_type vs Codex subagent)
 *
 * commands/ and generated skills/ are NOT checked here anymore: they are
 * generated from the single provider-neutral tree at repo-root skills/ by
 * scripts/generate-skills-artifacts.mjs, whose own `--check` mode is a
 * byte-exact equality gate (stronger than this script's dialect-tolerant
 * diff) and is wired into each plugin package's `prepublishOnly`.
 *
 * The exception is the hand-mirrored skill allowlist
 * (scripts/hand-mirrored-skills.mjs): plugin-payload skills whose committed
 * frontmatter cannot pass the canonical Agent Skills gates are kept as
 * hand-maintained pairs, and THIS script enforces that each pair is
 * byte-identical across the two packages — file sets equal both ways, every
 * file equal byte-for-byte. No dialect tolerance applies to them.
 *
 * This script fails when the remaining mirrors (agents/, scripts/, hooks/,
 * hand-mirrored skills) diverge in any OTHER way than the two dimensions
 * above, so an edit to one plugin that is not ported to the other is caught
 * by `npm run check` (and therefore the pre-commit hook) instead of at
 * publish or never.
 *
 * Usage:
 *   node scripts/check-plugin-mirrors.mjs        # exit 1 on drift
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAND_MIRRORED_SKILL_DIRS } from "./hand-mirrored-skills.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CODEX_PATH_TOKENS = [
	"${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}",
	"${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}",
];
const CLAUDE_PATH_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

// A differing line pair is allowed when the claude side speaks Claude Code
// dialect (Task-tool dispatch, subagent/agent-role mentions, or the platform
// name) and the codex side speaks Codex dialect. This deliberately tolerates
// wording differences on dispatch-phrasing lines; insertions, deletions, and
// every other differing line are drift.
const CLAUDE_DISPATCH =
	/Task tool|subagent_type|`Task`|Task subagent|Claude|\bsubagents?\b|`(architect|implementer|spec-reviewer|reviewer|debugger|verifier|security-auditor|git-committer)`/i;
const CODEX_DISPATCH = /Codex|spawn_agent/i;

function normalizeCodex(content) {
	let out = content;
	for (const token of CODEX_PATH_TOKENS) out = out.split(token).join(CLAUDE_PATH_TOKEN);
	return out;
}

function listFiles(dir, ext) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
}

// Myers-free LCS line diff — files are small, O(n*m) DP is fine.
function lineDiff(aLines, bLines) {
	const n = aLines.length;
	const m = bLines.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	// Walk the table, emitting hunks of (removed from a, added to b)
	const hunks = [];
	let i = 0;
	let j = 0;
	let removed = [];
	let added = [];
	const flush = () => {
		if (removed.length || added.length) hunks.push({ removed, added, line: i });
		removed = [];
		added = [];
	};
	while (i < n && j < m) {
		if (aLines[i] === bLines[j]) {
			flush();
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			removed.push(aLines[i++]);
		} else {
			added.push(bLines[j++]);
		}
	}
	while (i < n) removed.push(aLines[i++]);
	while (j < m) added.push(bLines[j++]);
	flush();
	return hunks;
}

/** Recursively list every file under dir as a sorted array of dir-relative paths. */
function walkFiles(dir, prefix = "") {
	if (!existsSync(dir)) return [];
	const files = [];
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (statSync(full).isDirectory()) {
			files.push(...walkFiles(full, rel));
		} else {
			files.push(rel);
		}
	}
	return files;
}

/**
 * Enforce byte-exact pair identity for every allowlisted hand-mirrored skill
 * dir under <root>/packages/{draht-claude,draht-codex}/skills/. Returns a
 * list of precise problems (empty when in sync). Pure: reads only, never
 * exits, so tests can drive it against fixture roots.
 */
export function checkHandMirroredSkills(root) {
	const problems = [];
	for (const name of HAND_MIRRORED_SKILL_DIRS) {
		const claudeDir = join(root, "packages/draht-claude/skills", name);
		const codexDir = join(root, "packages/draht-codex/skills", name);
		const claudeExists = existsSync(claudeDir);
		const codexExists = existsSync(codexDir);
		if (!claudeExists && !codexExists) {
			problems.push(
				`skills/${name}: allowlisted as hand-mirrored (scripts/hand-mirrored-skills.mjs) but absent from both packages — stale allowlist entry`,
			);
			continue;
		}
		if (!claudeExists || !codexExists) {
			problems.push(`skills/${name}: missing in ${claudeExists ? "draht-codex" : "draht-claude"}`);
			continue;
		}
		const claudeFiles = walkFiles(claudeDir);
		const codexFiles = new Set(walkFiles(codexDir));
		for (const rel of claudeFiles) {
			if (!codexFiles.has(rel)) {
				problems.push(`skills/${name}/${rel}: missing in draht-codex`);
				continue;
			}
			codexFiles.delete(rel);
			const a = readFileSync(join(claudeDir, rel));
			const b = readFileSync(join(codexDir, rel));
			if (!a.equals(b)) {
				problems.push(`skills/${name}/${rel}: content differs (hand-mirrored skills must be byte-identical)`);
			}
		}
		for (const rel of codexFiles) {
			problems.push(`skills/${name}/${rel}: missing in draht-claude`);
		}
	}
	return problems;
}

function main() {
	const CLAUDE = join(ROOT, "packages/draht-claude");
	const CODEX = join(ROOT, "packages/draht-codex");
	const problems = [];

	function checkFileSets(sub, ext) {
		const a = listFiles(join(CLAUDE, sub), ext);
		const b = listFiles(join(CODEX, sub), ext);
		for (const f of a) if (!b.includes(f)) problems.push(`${sub}/${f}: missing in draht-codex`);
		for (const f of b) if (!a.includes(f)) problems.push(`${sub}/${f}: missing in draht-claude`);
		return a.filter((f) => b.includes(f));
	}

	function checkDialectMirror(label, aPath, bPath) {
		const a = readFileSync(aPath, "utf-8");
		const b = normalizeCodex(readFileSync(bPath, "utf-8"));
		if (a === b) return;
		for (const hunk of lineDiff(a.split("\n"), b.split("\n"))) {
			const dialectOnly =
				hunk.removed.length === hunk.added.length &&
				hunk.removed.every((l) => CLAUDE_DISPATCH.test(l)) &&
				hunk.added.every((l) => CODEX_DISPATCH.test(l));
			if (!dialectOnly) {
				const sample = (hunk.removed[0] ?? hunk.added[0] ?? "").trim().slice(0, 100);
				problems.push(`${label}: drift near claude line ${hunk.line + 1}: "${sample}"`);
			}
		}
	}

	// ── 1. agents/ — byte-identical ────────────────────────────────────────────
	for (const f of checkFileSets("agents", ".md")) {
		const a = readFileSync(join(CLAUDE, "agents", f), "utf-8");
		const b = readFileSync(join(CODEX, "agents", f), "utf-8");
		if (a !== b) problems.push(`agents/${f}: content differs (agents must be byte-identical)`);
	}

	// ── 2. scripts/ — identical modulo platform-name comment lines ──────────────
	for (const f of checkFileSets("scripts", ".cjs")) {
		checkDialectMirror(`scripts/${f}`, join(CLAUDE, "scripts", f), join(CODEX, "scripts", f));
	}

	// ── 3. hooks/hooks.json — identical modulo path token ───────────────────────
	{
		const a = readFileSync(join(CLAUDE, "hooks/hooks.json"), "utf-8");
		const b = normalizeCodex(readFileSync(join(CODEX, "hooks/hooks.json"), "utf-8"));
		if (a !== b) problems.push("hooks/hooks.json: content differs beyond the path token");
	}

	// ── 4. hand-mirrored skills — byte-identical pairs, no dialect tolerance ────
	problems.push(...checkHandMirroredSkills(ROOT));

	// Generated commands/ and skills/ — see scripts/generate-skills-artifacts.mjs --check.

	// ── Report ───────────────────────────────────────────────────────────────────
	if (problems.length > 0) {
		console.error(`Plugin mirror drift (${problems.length} problem(s)):\n`);
		for (const p of problems) console.error(`  ✗ ${p}`);
		console.error(
			"\ndraht-claude is the source of truth — port the change to draht-codex (path token + dispatch phrasing only; hand-mirrored skills byte-identical), or vice versa.",
		);
		process.exit(1);
	}
	console.log("draht-claude and draht-codex mirrors in sync");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
