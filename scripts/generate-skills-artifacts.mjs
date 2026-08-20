#!/usr/bin/env node
/**
 * Generate the per-host plugin artifacts (packages/draht-claude,
 * packages/draht-codex) from the single provider-neutral skill tree at
 * repo-root skills/, so commands/ and skills/ can no longer drift between
 * the two plugin packages by hand-editing one and forgetting the other.
 *
 * Source of truth: skills/<name>/SKILL.md (+ skills/<name>/command.md for
 * the 18 command-template skills).
 * Consumers:
 *   - packages/draht-claude/commands/<cmd>.md        (claude dialect)
 *   - packages/draht-claude/skills/<name>/SKILL.md    (claude dialect, plain skills only)
 *   - packages/draht-codex/commands/<cmd>.md          (codex dialect)
 *   - packages/draht-codex/skills/<name>/SKILL.md     (codex dialect)
 *   - packages/draht-codex/skills/<cmd>/SKILL.md      (codex-only wrapper)
 *   - packages/draht-codex/skills/<cmd>/command.md    (== codex commands/<cmd>.md)
 *
 * A skill directory is a "command" skill (gets a commands/<cmd>.md on both
 * hosts, plus a codex-only wrapper skill dir) when it has a command.md file
 * alongside its SKILL.md. Every other skill directory is a "plain" skill
 * (gets packages/<pkg>/skills/<name>/SKILL.md on both hosts, no wrapper).
 * The walk is dynamic — no hardcoded skill list — so a new skills/<name>/
 * directory is picked up automatically the next time this runs.
 *
 * Usage:
 *   node scripts/generate-skills-artifacts.mjs                # generate + report
 *   node scripts/generate-skills-artifacts.mjs --check         # exit 1 if drifted (for CI)
 *   node scripts/generate-skills-artifacts.mjs --skills-root <dir> --output-root <dir>
 *                                                               # override roots (tests)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAND_MIRRORED_SKILL_DIRS } from "./hand-mirrored-skills.mjs";
import {
	COMMAND_DIALECT,
	DISCIPLINE_DIALECT,
	PLUGIN_ROOT_RENDER,
	PLUGIN_ROOT_TOKEN,
	WRAPPER_DIALECT,
} from "./skills-dialect-table.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

const HOSTS = ["claude", "codex"];
const PACKAGE_NAME = { claude: "draht-claude", codex: "draht-codex" };

/**
 * Replace every canonical line that has a matching dialect-table entry with
 * its per-host rendering. Matching is exact whole-line string equality.
 */
export function applyLineDialect(text, entries, host) {
	if (!entries || entries.length === 0) return text;
	const byCanonical = new Map();
	for (const entry of entries) {
		if (entry[host] === undefined) continue;
		byCanonical.set(entry.canonical, entry[host]);
	}
	return text
		.split("\n")
		.map((line) => (byCanonical.has(line) ? byCanonical.get(line) : line))
		.join("\n");
}

/** Resolve the generic <PLUGIN_ROOT> placeholder to the host's literal token. */
export function applyPluginRootToken(text, host) {
	return text.split(PLUGIN_ROOT_TOKEN).join(PLUGIN_ROOT_RENDER[host]);
}

function render(text, entries, host) {
	return applyPluginRootToken(applyLineDialect(text, entries, host), host);
}

/**
 * Walk skillsRoot and classify each child directory as a "command" skill
 * (has command.md) or a "plain" skill (SKILL.md only). Returns entries
 * sorted by name for deterministic output.
 */
export function discoverSkills(skillsRoot) {
	if (!existsSync(skillsRoot)) return [];
	const names = readdirSync(skillsRoot)
		.filter((entry) => !entry.startsWith("."))
		.filter((entry) => statSync(join(skillsRoot, entry)).isDirectory())
		.sort();

	const skills = [];
	for (const name of names) {
		const dir = join(skillsRoot, name);
		const skillMdPath = join(dir, "SKILL.md");
		if (!existsSync(skillMdPath)) continue;
		const commandMdPath = join(dir, "command.md");
		skills.push({
			name,
			dir,
			skillMd: readFileSync(skillMdPath, "utf8"),
			commandMd: existsSync(commandMdPath) ? readFileSync(commandMdPath, "utf8") : null,
		});
	}
	return skills;
}

/**
 * Compute every generated artifact as { pkg, relPath, content } records,
 * without touching the filesystem beyond reading skillsRoot.
 */
export function computeArtifacts(skillsRoot) {
	const artifacts = [];
	for (const skill of discoverSkills(skillsRoot)) {
		if (skill.commandMd === null) {
			// Plain skill: same-shaped SKILL.md on both hosts, no wrapper.
			const entries = DISCIPLINE_DIALECT[skill.name] ?? [];
			for (const host of HOSTS) {
				artifacts.push({
					pkg: PACKAGE_NAME[host],
					relPath: `skills/${skill.name}/SKILL.md`,
					content: render(skill.skillMd, entries, host),
				});
			}
			continue;
		}

		// Command skill: commands/<name>.md on both hosts; codex additionally
		// gets a skills/<name>/{SKILL.md,command.md} wrapper pair.
		const entries = COMMAND_DIALECT[skill.name] ?? [];
		for (const host of HOSTS) {
			artifacts.push({
				pkg: PACKAGE_NAME[host],
				relPath: `commands/${skill.name}.md`,
				content: render(skill.commandMd, entries, host),
			});
		}

		const codexCommand = render(skill.commandMd, entries, "codex");
		artifacts.push({
			pkg: PACKAGE_NAME.codex,
			relPath: `skills/${skill.name}/command.md`,
			content: codexCommand,
		});
		artifacts.push({
			pkg: PACKAGE_NAME.codex,
			relPath: `skills/${skill.name}/SKILL.md`,
			content: render(skill.skillMd, WRAPPER_DIALECT, "codex"),
		});
	}
	return artifacts;
}

function artifactPath(outputRoot, artifact) {
	return join(outputRoot, "packages", artifact.pkg, artifact.relPath);
}

/** Write every artifact under outputRoot/packages/<pkg>/<relPath>. */
export function writeArtifacts(artifacts, outputRoot) {
	const written = [];
	for (const artifact of artifacts) {
		const path = artifactPath(outputRoot, artifact);
		const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
		if (existing === artifact.content) {
			written.push({ path, status: "=" });
			continue;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, artifact.content);
		written.push({ path, status: existing === null ? "+" : "↻" });
	}
	return written;
}

/** Recursively list every file under dir as slash-joined dir-relative paths. */
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
 * Completeness half of the equality gate: every file that actually exists
 * under packages/<pkg>/commands/ and packages/<pkg>/skills/ must either be
 * a generated artifact or live inside an allowlisted hand-mirrored skill
 * dir (scripts/hand-mirrored-skills.mjs, pair-gated by
 * check-plugin-mirrors.mjs). Without this, a hand-added file next to the
 * generated ones is invisible to the byte-equality check and ships ungated.
 */
export function findUnexpectedFiles(artifacts, outputRoot) {
	const problems = [];
	const generated = new Set(artifacts.map((a) => `${a.pkg}/${a.relPath}`));
	for (const pkg of Object.values(PACKAGE_NAME)) {
		for (const area of ["commands", "skills"]) {
			const areaDir = join(outputRoot, "packages", pkg, area);
			for (const rel of walkFiles(areaDir)) {
				const relPath = `${area}/${rel}`;
				if (generated.has(`${pkg}/${relPath}`)) continue;
				if (area === "skills" && HAND_MIRRORED_SKILL_DIRS.includes(rel.split("/")[0])) continue;
				problems.push(
					`unexpected: ${join(areaDir, rel)} — not generated from skills/ and not an allowlisted hand-mirrored skill (scripts/hand-mirrored-skills.mjs)`,
				);
			}
		}
	}
	return problems;
}

/**
 * Compare artifacts against outputRoot without writing anything. Returns a
 * list of precise drift problems (empty when in sync): missing artifacts,
 * byte drift, and unexpected non-generated files.
 */
export function checkArtifacts(artifacts, outputRoot) {
	const problems = [];
	for (const artifact of artifacts) {
		const path = artifactPath(outputRoot, artifact);
		if (!existsSync(path)) {
			problems.push(`missing: ${path}`);
			continue;
		}
		const existing = readFileSync(path, "utf8");
		if (existing !== artifact.content) {
			problems.push(`drift: ${path}`);
		}
	}
	problems.push(...findUnexpectedFiles(artifacts, outputRoot));
	return problems;
}

function parseArgs(argv) {
	const args = { check: false, skillsRoot: DEFAULT_ROOT, outputRoot: DEFAULT_ROOT };
	args.skillsRoot = join(DEFAULT_ROOT, "skills");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") args.check = true;
		else if (arg === "--skills-root") args.skillsRoot = resolve(argv[++i]);
		else if (arg === "--output-root") args.outputRoot = resolve(argv[++i]);
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const artifacts = computeArtifacts(args.skillsRoot);

	if (artifacts.length === 0) {
		console.error(`no skills discovered under ${args.skillsRoot}`);
		process.exit(1);
	}

	if (args.check) {
		const problems = checkArtifacts(artifacts, args.outputRoot);
		if (problems.length > 0) {
			console.error(`Skills artifact drift (${problems.length} problem(s)):\n`);
			for (const p of problems) console.error(`  ✗ ${p}`);
			console.error("\nRun: node scripts/generate-skills-artifacts.mjs");
			process.exit(1);
		}
		console.log("skills artifacts in sync across packages/draht-claude and packages/draht-codex");
		return;
	}

	const written = writeArtifacts(artifacts, args.outputRoot);
	for (const { path, status } of written) console.log(`${status} ${path}`);
	console.log(`${written.length} artifact(s) from ${discoverSkills(args.skillsRoot).length} skill(s)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
