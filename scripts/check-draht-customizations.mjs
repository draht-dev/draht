#!/usr/bin/env node

/**
 * Verify draht-specific customizations survive upstream rebases.
 *
 * Run after cherry-picking upstream commits and before merging:
 *   node scripts/check-draht-customizations.mjs
 *
 * Checks:
 *   1. Root package.json: version format, scripts, workspace deps, draht-only deps
 *   2. coding-agent package.json: drahtConfig, bin entries, files, workspace deps,
 *      build scripts, publishConfig, typescript version
 *   3. Every workspace package (discovered from the root "workspaces" globs)
 *      uses workspace:* for its @draht/* deps and declares no file:/link:
 *      specifier in any dependency field or in overrides/resolutions; and
 *      bun.lock carries no file:/link: text at all *and* its workspace
 *      manifest snapshot matches every package.json byte for byte — a file:
 *      sibling dep duplicates the package physically, breaks tsc, and makes
 *      the lockfile unreproducible
 *   4. Draht-only scripts exist on disk
 *   5. verify.sh branding check targets @mariozechner/pi-* (not @draht/*)
 *   6. .planning/ files are not modified vs main (branding guard must not touch them)
 *   7. Repo-level subagents exist in .draht/agents/
 *   8. GSD sources exist in packages/coding-agent/src/gsd/
 *   9. GSD hooks exist in packages/coding-agent/hooks/gsd/
 *  10. GSD prompt templates exist in packages/coding-agent/prompts/
 *  11. Built-in agents exist in packages/coding-agent/agents/
 *  12. draht-tools binary exists in packages/coding-agent/bin/
 *  13. GSD test suite is intact in packages/coding-agent/test/
 *  14. All package.json names use @draht/* or draht-* (not @mariozechner/pi*)
 *  15. All package.json author fields are draht authors (not upstream)
 *  16. No @mariozechner/pi* import paths in source files
 *  17. No @mariozechner/pi* references in README.md files
 *  18. No discord invite badge or stale "graciously donated by" domain credit
 *      in README.md files (draht has no discord community; the domain credit
 *      was replaced with a Spaceship referral link)
 *  19. system-prompt.ts uses APP_NAME (not a hardcoded "pi" product name) —
 *      upstream syncs tend to overwrite buildSystemPrompt() wholesale and
 *      reintroduce "operating inside pi" / "Pi documentation" / "pi docs"
 *  20. Multi-agent core builtin is actually wired (not just present on disk) —
 *      core/multi-agent primitives are imported by the subagent builtin, the
 *      subagent builtin is registered in CORE_BUILTIN_EXTENSIONS, and
 *      agent-session-services.ts still spreads CORE_BUILTIN_EXTENSIONS into
 *      extensionFactories. Files existing with passing unit tests is not
 *      sufficient — this was dead code for a full phase because nothing
 *      asserted the import chain reached the running CLI.
 *  21. Plugin manifest versions (draht-claude, draht-codex) equal their own
 *      package.json version — the release path stamps every package's
 *      package.json, but Claude Code / Codex key update detection off the
 *      plugin manifest version, so a gap between the two writers freezes
 *      installed plugins on a stale version without anyone noticing.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;
let passes = 0;

// Workspace glob shapes discoverWorkspacePackageJsons() cannot expand
// correctly. Anything landing here means the guard is silently checking a
// subset of the tree, so section 3 turns it into a hard failure rather than
// mis-resolving quietly. Declared here (not next to the function) because
// section 3 reads it before the helper block is evaluated.
const unsupportedWorkspacePatterns = [];

function pass(msg) {
	passes++;
	console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
	failures++;
	console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function check(condition, msg) {
	if (condition) {
		pass(msg);
	} else {
		fail(msg);
	}
}

function readJson(relPath) {
	return JSON.parse(readFileSync(resolve(root, relPath), "utf-8"));
}

// ── 1. Root package.json ────────────────────────────────────────────

console.log("\nRoot package.json");

const rootPkg = readJson("package.json");

check(
	/^\d{4}\.\d{1,2}\.\d{1,2}/.test(rootPkg.version),
	`version is YYYY.M.D format: ${rootPkg.version}`
);

const requiredRootScripts = [
	"release",
	"release:dry",
	"dev:link",
	"dev:unlink",
	"verify",
	"verify:quick",
];
for (const script of requiredRootScripts) {
	check(
		typeof rootPkg.scripts?.[script] === "string",
		`scripts.${script} exists`
	);
}

// These upstream-style release scripts should NOT exist
const forbiddenRootScripts = ["release:patch", "release:minor", "release:major"];
for (const script of forbiddenRootScripts) {
	check(
		rootPkg.scripts?.[script] === undefined,
		`scripts.${script} does not exist (upstream semver release)`
	);
}

check(
	rootPkg.dependencies?.["@draht/coding-agent"] === "workspace:*",
	`@draht/coding-agent dep is workspace:*`
);

check(
	rootPkg.dependencies?.koffi !== undefined,
	`koffi dependency present`
);

// ── 2. coding-agent package.json ────────────────────────────────────

console.log("\npackages/coding-agent/package.json");

const caPkg = readJson("packages/coding-agent/package.json");

check(
	/^\d{4}\.\d{1,2}\.\d{1,2}/.test(caPkg.version),
	`version is YYYY.M.D format: ${caPkg.version}`
);

check(
	caPkg.drahtConfig?.name === "draht" && caPkg.drahtConfig?.configDir === ".draht",
	`drahtConfig present (not piConfig)`
);

check(caPkg.piConfig === undefined, `piConfig absent`);

const requiredBins = ["coding-agent", "draht", "draht-tools"];
for (const bin of requiredBins) {
	check(typeof caPkg.bin?.[bin] === "string", `bin.${bin} exists`);
}

const requiredFiles = ["prompts", "hooks", "agents", "bin"];
for (const f of requiredFiles) {
	check(caPkg.files?.includes(f), `files includes "${f}"`);
}

check(
	caPkg.dependencies?.["@draht/agent-core"] === "workspace:*",
	`@draht/agent-core dep is workspace:*`
);
check(
	caPkg.dependencies?.["@draht/ai"] === "workspace:*",
	`@draht/ai dep is workspace:*`
);
check(
	caPkg.dependencies?.["@draht/tui"] === "workspace:*",
	`@draht/tui dep is workspace:*`
);

check(
	caPkg.scripts?.["build:binary"]?.includes("dist/draht"),
	`build:binary outputs dist/draht (not dist/pi)`
);

check(
	caPkg.scripts?.["copy-assets"]?.includes("dist/prompts"),
	`copy-assets copies prompts/hooks/agents`
);

check(
	caPkg.publishConfig?.access === "public",
	`publishConfig.access is "public"`
);

check(
	caPkg.devDependencies?.typescript?.includes("6.0.0") ||
		caPkg.devDependencies?.typescript?.includes("7.") ||
		caPkg.devDependencies?.typescript?.includes("beta"),
	`typescript devDep is not downgraded: ${caPkg.devDependencies?.typescript}`
);

// ── 3. Every workspace package uses workspace:* for siblings ────────
//
// This used to iterate a hardcoded list of four packages, which is how
// packages/web-ui/example/package.json got away with declaring
// "@draht/ai": "file:../../ai" and "@draht/web-ui": "file:../" for months:
// it simply was not on the list. The list is now discovered from the root
// package.json "workspaces" globs, so a new workspace member is covered the
// moment it is added.

console.log("\nWorkspace deps");

const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];

const workspacePkgPaths = discoverWorkspacePackageJsons();

check(
	unsupportedWorkspacePatterns.length === 0,
	`root "workspaces" uses only expandable glob shapes` +
		(unsupportedWorkspacePatterns.length
			? ` — cannot expand ${unsupportedWorkspacePatterns.join(", ")};` +
				` discoverWorkspacePackageJsons() only handles a trailing "<base>/*"`
			: ""),
);

// "length > 1" was too weak to detect a discovery regression: the root
// "workspaces" array carries several literal (non-glob) nested entries, so if
// the "packages/*" expansion ever silently broke, discovery would still return
// those literals and the meta-check would stay green while checking a fraction
// of the tree. Pin the floor to something the literals alone cannot satisfy by
// independently reading packages/ and set-diffing.
const packagesDirAbs = resolve(root, "packages");
const directPackageDirs = existsSync(packagesDirAbs)
	? readdirSync(packagesDirAbs, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					entry.name !== "node_modules" &&
					!entry.name.startsWith(".") &&
					existsSync(resolve(packagesDirAbs, entry.name, "package.json")),
			)
			.map((entry) => `packages/${entry.name}/package.json`)
	: [];
const missingFromDiscovery = directPackageDirs.filter(
	(p) => !workspacePkgPaths.includes(p),
);
check(
	directPackageDirs.length > 0 && missingFromDiscovery.length === 0,
	`discovered ${workspacePkgPaths.length} workspace package.json files from root "workspaces"` +
		(missingFromDiscovery.length
			? ` — misses ${missingFromDiscovery.length} of ${directPackageDirs.length} packages/* members:` +
				` ${missingFromDiscovery.join(", ")}`
			: ` (covers all ${directPackageDirs.length} packages/* members)`),
);
// Note for whoever rediscovers this: packages/web-ui/example is a nested
// workspace member whose sibling @draht/web-ui is its own ancestor directory,
// so `workspace:*` makes bun link
// example/node_modules/@draht/web-ui -> packages/web-ui, an intentionally
// infinite symlink chain. That is the normal cost of a nested member depending
// on its parent, and every tool here excludes node_modules (biome ignores
// **/node_modules/**, the example tsconfig includes only src/**, and web-ui now
// ships a "files" allowlist so npm pack never walks it). Do not "fix" it by
// reintroducing a file: specifier — that is the duplicate-copy bug this whole
// section guards against.
check(
	workspacePkgPaths.includes("packages/web-ui/example/package.json"),
	`discovery reaches nested workspace members (packages/web-ui/example)`,
);

for (const pkgPath of workspacePkgPaths) {
	const pkg = readJson(pkgPath);
	const offenders = [];
	for (const field of DEP_FIELDS) {
		for (const [name, version] of Object.entries(pkg[field] ?? {})) {
			if (
				name.startsWith("@draht/") &&
				typeof version === "string" &&
				version !== "workspace:*"
			) {
				offenders.push(`${field}.${name} is "${version}"`);
			}
		}
	}
	check(
		offenders.length === 0,
		`${pkgPath}: all @draht/* deps are workspace:*` +
			(offenders.length ? ` — ${offenders.join(", ")}` : ""),
	);
}

// ── 3b. No file:/link: dependency specifiers anywhere ───────────────
//
// A file:/link: specifier pointing at a workspace sibling makes bun
// materialise a second *physical copy* of that package under
// node_modules/.bun/<name>@file+<path>+<hash>/ instead of symlinking the
// workspace. Consequences, all observed in this repo:
//   * tsc fails with TS2345 "Types have separate declarations of a private
//     property" because two structurally identical classes now exist;
//   * the duplicate is contagious — other consumers get attached to the copy;
//   * bun.lock gains file:packages resolution entries, and the workaround
//     (hand-stripping them out of the lockfile) leaves bun.lock
//     unreproducible: `bun install --frozen-lockfile` then fails with
//     "lockfile had changes, but lockfile is frozen".
// Use workspace:* for siblings; use a registry version for anything else.

console.log("\nDependency specifiers (no file:/link:)");

const localSpecifierPattern = /^(file|link):/;

for (const pkgPath of workspacePkgPaths) {
	const pkg = readJson(pkgPath);
	const offenders = [];
	for (const field of DEP_FIELDS) {
		for (const [name, version] of Object.entries(pkg[field] ?? {})) {
			if (typeof version === "string" && localSpecifierPattern.test(version)) {
				offenders.push(`${field}.${name} → "${version}"`);
			}
		}
	}
	// overrides/resolutions are not dependency fields, but a file:/link: value
	// placed there materialises the very same duplicate physical copy this
	// section exists to prevent. Values may nest (the root has
	// overrides.gaxios.rimraf), so walk them recursively.
	for (const field of ["overrides", "resolutions"]) {
		walkOverrides(pkg[field], field, (dottedPath, version) => {
			if (localSpecifierPattern.test(version)) {
				offenders.push(`${dottedPath} → "${version}"`);
			}
		});
	}
	check(
		offenders.length === 0,
		`${pkgPath}: no file:/link: dependency specifiers` +
			(offenders.length
				? ` — ${offenders.join(", ")}` +
					` (banned: file:/link: forces a duplicate physical copy of the package,` +
					` which breaks tsc with "separate declarations of a private property"` +
					` and makes bun.lock unreproducible — use "workspace:*")`
				: ""),
	);
}

// ── 3c. bun.lock carries no file:/link: and matches the manifests ───
//
// Three layers, because each catches a different failure mode:
//   (i)   no "file:packages" resolution entries — someone regenerated the
//         lockfile from a package.json that still had a file: dep;
//   (ii)  no "file:" / "link:" specifier anywhere — the same leak in bun's
//         workspace-manifest snapshot, whose specifiers are written verbatim
//         from package.json ("file:../../ai") and never contain "packages";
//   (iii) the snapshot's dependency maps equal the real package.json maps —
//         the case (i) and (ii) are both blind to: a lockfile that was never
//         regenerated *after* the manifests were fixed. That is exactly the
//         invariant `bun install --frozen-lockfile` enforces, asserted here so
//         it fails in `bun run check` instead of only in CI.

console.log("\nbun.lock reproducibility");

const lockAbsPath = resolve(root, "bun.lock");
if (existsSync(lockAbsPath)) {
	const lockRaw = readFileSync(lockAbsPath, "utf-8");
	const lockLines = lockRaw.split("\n");
	const lockHits = [];
	const localSpecHits = [];
	for (let i = 0; i < lockLines.length; i++) {
		if (lockLines[i].includes("file:packages")) {
			lockHits.push(`${i + 1}: ${lockLines[i].trim()}`);
		}
		if (/"(file|link):/.test(lockLines[i])) {
			localSpecHits.push(`${i + 1}: ${lockLines[i].trim()}`);
		}
	}
	check(
		lockHits.length === 0,
		`bun.lock: no file:packages resolution entries` +
			(lockHits.length
				? ` — ${lockHits.join(" | ")}` +
					` (a file:/link: specifier leaked into the lockfile; fix the offending` +
					` package.json to use "workspace:*" and re-run bun install — do NOT` +
					` hand-strip these lines, that is what made the lockfile unreproducible)`
				: ""),
	);
	check(
		localSpecHits.length === 0,
		`bun.lock: no file:/link: specifiers anywhere` +
			(localSpecHits.length ? ` — ${localSpecHits.join(" | ")}` : ""),
	);

	// bun.lock is JSONC (trailing commas). Strip them, then compare every
	// workspaces[<dir>] dependency map against the manifest on disk.
	let lockJson = null;
	try {
		lockJson = JSON.parse(lockRaw.replace(/,(\s*[}\]])/g, "$1"));
	} catch (err) {
		fail(`bun.lock: could not be parsed as JSONC — ${err.message}`);
	}
	if (lockJson) {
		const lockWorkspaces = lockJson.workspaces ?? {};
		const mismatches = [];
		let comparedSpecifiers = 0;
		for (const pkgPath of workspacePkgPaths) {
			const dir = pkgPath === "package.json" ? "" : dirname(pkgPath);
			const lockEntry = lockWorkspaces[dir];
			if (!lockEntry) {
				mismatches.push(`${pkgPath}: no workspaces["${dir}"] entry in bun.lock`);
				continue;
			}
			const pkg = readJson(pkgPath);
			for (const field of DEP_FIELDS) {
				const fromPkg = pkg[field] ?? {};
				const fromLock = lockEntry[field] ?? {};
				const names = new Set([
					...Object.keys(fromPkg),
					...Object.keys(fromLock),
				]);
				for (const name of names) {
					comparedSpecifiers++;
					if (fromPkg[name] !== fromLock[name]) {
						mismatches.push(
							`${pkgPath} ${field}.${name}: bun.lock=${JSON.stringify(fromLock[name])} package.json=${JSON.stringify(fromPkg[name])}`,
						);
					}
				}
			}
		}
		check(
			mismatches.length === 0,
			`bun.lock: workspace manifest snapshot matches package.json` +
				` (${comparedSpecifiers} specifiers across ${workspacePkgPaths.length} workspaces)` +
				(mismatches.length
					? ` — ${mismatches.join(" | ")}` +
						` (the lockfile was not regenerated after the manifests changed;` +
						` run \`bun install\` and commit bun.lock)`
					: ""),
		);
	}
} else {
	fail(`bun.lock: file not found at repo root`);
}

// ── 3d. Every published package declares "files" ────────────────────
//
// Without a "files" allowlist npm packs everything not covered by
// .npmignore/.gitignore, so the tarball silently accumulates whatever else
// lives in the package directory. Both observed here:
//   * @draht/web-ui shipped its nested example/package.json — which, once the
//     example was switched to workspace:*, would have published a specifier
//     npm cannot resolve for consumers;
//   * @draht/gateway shipped .planning/attachable-sessions-prd.md (an internal
//     PRD), SPEC.md, TAILSCALE_SETUP.md and all of src/__tests__.
// Private packages are exempt — they are never published.

console.log("\nPublished packages declare files");

for (const pkgPath of workspacePkgPaths) {
	if (pkgPath === "package.json") continue; // the private monorepo root
	const pkg = readJson(pkgPath);
	if (pkg.private) continue;
	const files = pkg.files;
	check(
		Array.isArray(files) && files.length > 0,
		`${pkgPath}: "${pkg.name}" declares a non-empty files array` +
			(Array.isArray(files) && files.length > 0
				? ""
				: ` — got ${JSON.stringify(files)} (a published package without "files"` +
					` packs every stray file in its directory: internal docs, planning notes,` +
					` tests, and nested example manifests all leak into the tarball)`),
	);
}

// ── 4. Draht-only scripts exist on disk ─────────────────────────────

console.log("\nDraht-only scripts");

const requiredScripts = [
	"scripts/dev-link.mjs",
	"scripts/dev-unlink.mjs",
	"scripts/verify.sh",
	"scripts/release.mjs",
	"scripts/sync-versions.js",
];
for (const script of requiredScripts) {
	check(existsSync(resolve(root, script)), `${script} exists`);
}

// ── 5. verify.sh checks for @mariozechner/pi-* ─────────────────────

console.log("\nverify.sh branding target");

const verifyContent = readFileSync(resolve(root, "scripts/verify.sh"), "utf-8");
check(
	verifyContent.includes("@mariozechner/pi-"),
	`verify.sh checks for stale @mariozechner/pi-* refs`
);
check(
	!verifyContent.includes("@draht/coding-agent-"),
	`verify.sh does NOT check for @draht/coding-agent-* (incorrect rewrite)`
);

// ── 6. .planning/ not modified ──────────────────────────────────────

console.log("\n.planning/ integrity");

try {
	const diffOutput = execSync("git diff main -- .planning/", {
		cwd: root,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	check(diffOutput.trim() === "", `.planning/ unchanged vs main`);
} catch {
	// If not on a branch or main doesn't exist, skip
	pass(`.planning/ check skipped (no main ref)`);
}

// ── 7. Repo-level subagents ─────────────────────────────────────────

console.log("\nRepo-level subagents (.draht/agents/)");

const requiredRepoAgents = [
	".draht/agents/branding-guard.md",
	".draht/agents/cherry-picker.md",
	".draht/agents/verifier.md",
];
for (const agent of requiredRepoAgents) {
	check(existsSync(resolve(root, agent)), `${agent} exists`);
}

// ── 8. GSD sources ──────────────────────────────────────────────────

console.log("\nGSD sources (packages/coding-agent/src/gsd/)");

const requiredGsdSources = [
	"packages/coding-agent/src/gsd/index.ts",
	"packages/coding-agent/src/gsd/domain.ts",
	"packages/coding-agent/src/gsd/domain-validator.ts",
	"packages/coding-agent/src/gsd/git.ts",
	"packages/coding-agent/src/gsd/hook-utils.ts",
	"packages/coding-agent/src/gsd/planning.ts",
];
for (const src of requiredGsdSources) {
	check(existsSync(resolve(root, src)), `${src} exists`);
}

// Verify gsd/index.ts still exports the expected API surface
if (existsSync(resolve(root, "packages/coding-agent/src/gsd/index.ts"))) {
	const gsdIndex = readFileSync(
		resolve(root, "packages/coding-agent/src/gsd/index.ts"),
		"utf-8",
	);
	const requiredGsdExports = [
		"mapCodebase",
		"createDomainModel",
		"validateDomainGlossary",
		"commitTask",
		"commitDocs",
		"detectToolchain",
		"readHookConfig",
		"createPlan",
		"discoverPlans",
		"readPlan",
		"updateState",
		"verifyPhase",
		"writeSummary",
	];
	for (const name of requiredGsdExports) {
		check(gsdIndex.includes(name), `gsd/index.ts exports ${name}`);
	}
}

// ── 9. GSD hooks ────────────────────────────────────────────────────

console.log("\nGSD hooks (packages/coding-agent/hooks/gsd/)");

const requiredGsdHooks = [
	"packages/coding-agent/hooks/gsd/draht-pre-execute.js",
	"packages/coding-agent/hooks/gsd/draht-quality-gate.js",
	"packages/coding-agent/hooks/gsd/draht-post-task.js",
	"packages/coding-agent/hooks/gsd/draht-post-phase.js",
];
for (const hook of requiredGsdHooks) {
	check(existsSync(resolve(root, hook)), `${hook} exists`);
}

// ── 10. GSD command & agent prompt templates ───────────────────────

console.log("\nGSD prompt templates (packages/coding-agent/prompts/)");

const requiredCommandPrompts = [
	"atomic-commit",
	"discuss-phase",
	"execute-phase",
	"fix",
	"init-project",
	"map-codebase",
	"new-project",
	"next-milestone",
	"orchestrate",
	"pause-work",
	"plan-phase",
	"progress",
	"quick",
	"resume-work",
	"review",
	"verify-work",
];
for (const name of requiredCommandPrompts) {
	check(
		existsSync(
			resolve(root, `packages/coding-agent/prompts/commands/${name}.md`),
		),
		`prompts/commands/${name}.md exists`,
	);
}

const requiredAgentPrompts = ["build", "plan", "verify"];
for (const name of requiredAgentPrompts) {
	check(
		existsSync(
			resolve(root, `packages/coding-agent/prompts/agents/${name}.md`),
		),
		`prompts/agents/${name}.md exists`,
	);
}

// ── 11. Built-in agents ─────────────────────────────────────────────

console.log("\nBuilt-in agents (packages/coding-agent/agents/)");

const requiredBuiltinAgents = [
	"architect",
	"debugger",
	"git-committer",
	"implementer",
	"reviewer",
	"security-auditor",
	"verifier",
];
for (const name of requiredBuiltinAgents) {
	check(
		existsSync(resolve(root, `packages/coding-agent/agents/${name}.md`)),
		`agents/${name}.md exists`,
	);
}

// ── 12. draht-tools binary ─────────────────────────────────────────

console.log("\nDraht-tools binary");

check(
	existsSync(resolve(root, "packages/coding-agent/bin/draht-tools.cjs")),
	`packages/coding-agent/bin/draht-tools.cjs exists`,
);

// ── 13. GSD test suite ─────────────────────────────────────────────

console.log("\nGSD test suite (packages/coding-agent/test/)");

const requiredGsdTests = [
	"gsd-domain.test.ts",
	"gsd-domain-fixture.test.ts",
	"gsd-domain-validator.test.ts",
	"gsd-extension-loading.test.ts",
	"gsd-git.test.ts",
	"gsd-hook-utils.test.ts",
	"gsd-index.test.ts",
	"gsd-lifecycle.test.ts",
	"gsd-map-codebase.test.ts",
	"gsd-planning.test.ts",
	"gsd-quality-gate.test.ts",
];
for (const name of requiredGsdTests) {
	check(
		existsSync(resolve(root, `packages/coding-agent/test/${name}`)),
		`test/${name} exists`,
	);
}

// ── 13.5. Draht visual features (copper thinking, ASCII logo) ────

console.log("\nDraht visual features (copper thinking, ASCII logo)");

const darkTheme = readJson("packages/coding-agent/src/modes/interactive/theme/dark.json");
const lightTheme = readJson("packages/coding-agent/src/modes/interactive/theme/light.json");

// Copper colors must exist in both themes
for (const [name, theme] of [["dark", darkTheme], ["light", lightTheme]]) {
	check(
		typeof theme.vars?.copper === "string",
		`${name}.json vars.copper exists`,
	);
	check(
		typeof theme.vars?.copperDim === "string",
		`${name}.json vars.copperDim exists`,
	);
	check(
		typeof theme.colors?.thinkingMax === "string",
		`${name}.json colors.thinkingMax exists`,
	);
	check(
		typeof theme.colors?.thinkingLow === "string" &&
			(theme.colors.thinkingLow.includes("8a751a") || theme.colors.thinkingLow === "copperDim"),
		`${name}.json colors.thinkingLow is copper tone`,
	);
	check(
		typeof theme.colors?.thinkingHigh === "string" &&
			(theme.colors.thinkingHigh.includes("copper") || theme.colors.thinkingHigh.includes("e8c828") || theme.colors.thinkingHigh.includes("8a5a14")),
		`${name}.json colors.thinkingHigh is copper tone`,
	);
}

// ASCII art logo must exist in interactive-mode
const interactiveMode = readFileSync(
	resolve(root, "packages/coding-agent/src/modes/interactive/interactive-mode.ts"),
	"utf-8",
);
check(
	interactiveMode.includes("╭─╮"),
	"interactive-mode.ts has ASCII art logo",
);
check(
	interactiveMode.includes("/dʁaːt/"),
	"interactive-mode.ts has pronunciation",
);

// getThinkingBorderColor must have "max" case
const themeTs = readFileSync(
	resolve(root, "packages/coding-agent/src/modes/interactive/theme/theme.ts"),
	"utf-8",
);
check(
	/"max"/.test(themeTs.split("getThinkingBorderColor")[1]?.split("getBashModeBorderColor")[0] ?? ""),
	"theme.ts getThinkingBorderColor has max case",
);

// ── 14. Package names use @draht/* or draht-* ──────────────────────

console.log("\nPackage names (@draht/* not @mariozechner/pi*)");

const allPkgJsons = findPackageJsons(root);
// Scoped upstream names, plus the unscoped "pi-*" shape upstream uses for its
// example extension packages (pi-extension-sandbox, pi-extension-with-deps, ...).
// Private packages are NOT exempt here: they are never published, but their
// names surface in bun.lock, `bun pm ls`, workspace tooling and in the examples
// users copy — and skipping them is exactly why six pi-extension-* packages sat
// in packages/coding-agent/examples/extensions for the whole life of the fork.
const upstreamPrefixes = ["@mariozechner/pi-", "@mariozechner/pi", "@earendil-works/pi", "pi-"];

for (const pkgPath of allPkgJsons) {
	const pkg = readJson(pkgPath);
	// The monorepo root is draht-monorepo, not @draht/*
	if (pkgPath === "package.json") {
		check(pkg.name !== "pi-monorepo", `${pkgPath}: name is "${pkg.name}" (not pi-monorepo)`);
		continue;
	}
	for (const prefix of upstreamPrefixes) {
		check(
			!pkg.name?.startsWith(prefix),
			`${pkgPath}: name "${pkg.name}" does not start with upstream prefix "${prefix}"`,
		);
	}
}

// ── 15. Author fields are draht authors ─────────────────────────────

console.log("\nAuthor fields (not upstream authors)");

const upstreamAuthors = ["Mario Zechner", "badlogic", "mariozechner"];

for (const pkgPath of allPkgJsons) {
	const pkg = readJson(pkgPath);
	if (!pkg.author) continue;
	const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
	if (!author) continue;
	const authorLower = author.toLowerCase();
	for (const upstream of upstreamAuthors) {
		check(
			!authorLower.includes(upstream.toLowerCase()),
			`${pkgPath}: author "${author}" is not upstream (${upstream})`,
		);
	}
}

// ── 16. No @mariozechner/pi* or @earendil-works/pi* import paths in source files ──────────

console.log("\nImport paths (no @mariozechner/pi* or @earendil-works/pi* imports)");

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const sourceDirs = ["packages", "scripts"];
const importPattern = /@(mariozechner|earendil-works)\/pi[a-z0-9-]*/gi;

// Files that intentionally reference upstream patterns (documentation, verification)
const selfReferencingFiles = new Set([
	resolve(root, "scripts/check-draht-customizations.mjs"),
	resolve(root, "scripts/verify.sh"),
]);

for (const dir of sourceDirs) {
	const absDir = resolve(root, dir);
	if (!existsSync(absDir)) continue;
	walkDir(absDir, (filePath) => {
		// Skip self-referencing files that document upstream patterns
		if (selfReferencingFiles.has(filePath)) return;
		// Skip .draht/ agent/prompt files that document upstream mapping
		if (filePath.includes("/.draht/") || filePath.includes("/.agents/")) return;
		const ext = filePath.slice(filePath.lastIndexOf("."));
		if (!sourceExtensions.includes(ext)) return;
		// Skip node_modules and dist
		if (filePath.includes("/node_modules/") || filePath.includes("/dist/")) return;
		try {
			const content = readFileSync(filePath, "utf-8");
			const relPath = relative(root, filePath);
			// Check line by line for precise reporting
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Skip comment lines
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("<!--"))
					continue;
				if (importPattern.test(line)) {
					fail(
						`${relPath}:${i + 1}: upstream import reference "${line.trim()}"`,
					);
				}
			}
		} catch {
			// skip unreadable files
		}
	});
}

// ── 17. No @mariozechner/pi* references in README.md files ─────────

console.log("\nREADME integrity (no @mariozechner/pi* references)");

const readmeFiles = findReadmes(root);
const readmeUpstreamPattern = /@(mariozechner|earendil-works)\/pi[a-z0-9-]*/gi;
const readmePiMonoPattern = /\bpi-mono\b/gi;

for (const readmePath of readmeFiles) {
	try {
		const content = readFileSync(readmePath, "utf-8");
		const relPath = relative(root, readmePath);

		if (readmeUpstreamPattern.test(content)) {
			fail(`${relPath}: contains @mariozechner/pi* reference`);
		} else {
			pass(`${relPath}: clean`);
		}

		// Also check for pi-mono references specifically in READMEs
		readmeUpstreamPattern.lastIndex = 0; // reset regex
		if (readmePiMonoPattern.test(content)) {
			// pi-mono is sometimes used as a monorepo reference; flag if it's about the product
			// Only flag if it appears alongside "install" or "npm" context
			const contextMatch = content.match(
				/(?:npm install|npm i|npx)\s+.*pi-mono|pi-mono.*(?:install|package)/gi,
			);
			if (contextMatch) {
				fail(`${relPath}: contains pi-mono in install context`);
			}
		}
	} catch {
		// skip unreadable files
	}
}

// ── 18. No discord badge / stale domain-donation credit in README.md files ──

console.log(
	"\nREADME branding (no discord badge, no stale domain-donation credit)",
);

const discordBadgePattern = /discord\.com\/invite/i;
const staleDomainCreditPattern = /graciously donated by/i;

for (const readmePath of readmeFiles) {
	try {
		const content = readFileSync(readmePath, "utf-8");
		const relPath = relative(root, readmePath);

		if (discordBadgePattern.test(content)) {
			fail(`${relPath}: contains discord invite badge (no discord community exists)`);
		} else {
			pass(`${relPath}: no discord badge`);
		}

		if (staleDomainCreditPattern.test(content)) {
			fail(`${relPath}: contains stale "graciously donated by" domain credit`);
		} else {
			pass(`${relPath}: no stale domain-donation credit`);
		}
	} catch {
		// skip unreadable files
	}
}

// ── 19. system-prompt.ts uses APP_NAME (not hardcoded "pi") ─────────

console.log('\nSystem prompt branding (uses APP_NAME, not hardcoded "pi")');

const systemPromptRelPath = "packages/coding-agent/src/core/system-prompt.ts";
const systemPromptAbsPath = resolve(root, systemPromptRelPath);

if (existsSync(systemPromptAbsPath)) {
	const systemPromptContent = readFileSync(systemPromptAbsPath, "utf-8");

	check(
		/import\s*\{[^}]*\bAPP_NAME\b[^}]*\}\s*from\s*["']\.\.\/config\.ts["']/.test(
			systemPromptContent,
		),
		`${systemPromptRelPath}: imports APP_NAME from ../config.ts`,
	);

	check(
		systemPromptContent.includes("${APP_NAME}"),
		`${systemPromptRelPath}: default prompt interpolates \${APP_NAME} (not hardcoded)`,
	);

	// The default prompt text must never hardcode "pi" as the product name —
	// upstream syncs tend to overwrite buildSystemPrompt() wholesale and
	// reintroduce "operating inside pi" / "Pi documentation" / "pi docs".
	const standalonePiPattern = /\bpi\b/gi;
	const hardcodedPiHits = [];
	const promptLines = systemPromptContent.split("\n");
	for (let i = 0; i < promptLines.length; i++) {
		const line = promptLines[i];
		const trimmed = line.trim();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/**") ||
			trimmed.startsWith("import ")
		)
			continue;
		standalonePiPattern.lastIndex = 0;
		if (standalonePiPattern.test(line)) {
			hardcodedPiHits.push(`${i + 1}: ${trimmed}`);
		}
	}
	check(
		hardcodedPiHits.length === 0,
		`${systemPromptRelPath}: no hardcoded "pi" product references` +
			(hardcodedPiHits.length ? ` (${hardcodedPiHits.join(" | ")})` : ""),
	);
} else {
	fail(`${systemPromptRelPath}: file not found (path changed?)`);
}

// ── 20. Multi-agent core builtin is actually wired ──────────────────
//
// discovery bugs hide here: a file existing with passing unit tests proves
// nothing about whether the running CLI ever reaches it. Verify the whole
// import chain — multi-agent primitives -> subagent builtin -> core builtin
// registry -> agent-session-services.ts -- rather than just presence on disk.

console.log("\nMulti-agent core builtin wiring (not dead code)");

const multiAgentIndexRelPath = "packages/coding-agent/src/core/multi-agent/index.ts";
const subagentRelPath = "packages/coding-agent/src/core/builtins/subagent.ts";
const builtinsIndexRelPath = "packages/coding-agent/src/core/builtins/index.ts";
const agentSessionServicesRelPath = "packages/coding-agent/src/core/agent-session-services.ts";

check(existsSync(resolve(root, multiAgentIndexRelPath)), `${multiAgentIndexRelPath} exists`);
check(existsSync(resolve(root, subagentRelPath)), `${subagentRelPath} exists`);
check(existsSync(resolve(root, builtinsIndexRelPath)), `${builtinsIndexRelPath} exists`);
check(existsSync(resolve(root, agentSessionServicesRelPath)), `${agentSessionServicesRelPath} exists`);

if (existsSync(resolve(root, subagentRelPath))) {
	const subagentContent = readFileSync(resolve(root, subagentRelPath), "utf-8");
	const requiredMultiAgentImports = [
		"AgentFSM",
		"MailboxSystem",
		"PermissionGate",
		"TaskBoard",
		"WorktreeIsolator",
	];
	for (const name of requiredMultiAgentImports) {
		check(
			new RegExp(`\\b${name}\\b`).test(subagentContent) &&
				/from\s+["']\.\.\/multi-agent\/index\.ts["']/.test(subagentContent),
			`${subagentRelPath}: imports ${name} from ../multi-agent/index.ts`,
		);
	}
}

if (existsSync(resolve(root, builtinsIndexRelPath))) {
	const builtinsIndexContent = readFileSync(resolve(root, builtinsIndexRelPath), "utf-8");
	check(
		/CORE_BUILTIN_EXTENSIONS/.test(builtinsIndexContent) &&
			/name:\s*["']multi-agent["']/.test(builtinsIndexContent),
		`${builtinsIndexRelPath}: CORE_BUILTIN_EXTENSIONS registers the "multi-agent" builtin`,
	);
}

if (existsSync(resolve(root, agentSessionServicesRelPath))) {
	const servicesContent = readFileSync(resolve(root, agentSessionServicesRelPath), "utf-8");
	check(
		/import\s*\{[^}]*\bCORE_BUILTIN_EXTENSIONS\b[^}]*\}\s*from\s*["']\.\/builtins\/index\.(js|ts)["']/.test(
			servicesContent,
		),
		`${agentSessionServicesRelPath}: imports CORE_BUILTIN_EXTENSIONS from ./builtins/index`,
	);
	check(
		/extensionFactories:\s*\[\s*\.\.\.CORE_BUILTIN_EXTENSIONS/.test(servicesContent),
		`${agentSessionServicesRelPath}: extensionFactories spreads ...CORE_BUILTIN_EXTENSIONS (actually reachable, not just imported)`,
	);
}

// ── 21. Plugin manifest version matches its own package.json version ────
//
// scripts/release.mjs (setVersion) and scripts/sync-versions.js both write
// packages/*/package.json, but Claude Code / Codex read the *plugin*
// manifest version (.claude-plugin/plugin.json, .codex-plugin/plugin.json)
// to decide whether an update exists. A previous fix landed only in
// sync-versions.js's stamping — which the release path never calls — so the
// manifests froze at an old version while every package.json kept moving.
// This check exists so that regression is a red check here, not a silent
// plugin-cache freeze discovered later.

console.log("\nPlugin manifest version lockstep");

const pluginManifestPairs = [
	{
		pkgPath: "packages/draht-claude/package.json",
		manifestPath: "packages/draht-claude/.claude-plugin/plugin.json",
	},
	{
		pkgPath: "packages/draht-codex/package.json",
		manifestPath: "packages/draht-codex/.codex-plugin/plugin.json",
	},
];

for (const { pkgPath, manifestPath } of pluginManifestPairs) {
	if (!existsSync(resolve(root, pkgPath)) || !existsSync(resolve(root, manifestPath))) {
		fail(`${manifestPath}: cannot compare — ${pkgPath} or ${manifestPath} not found`);
		continue;
	}
	const pkg = readJson(pkgPath);
	const manifest = readJson(manifestPath);
	check(
		manifest.version === pkg.version,
		`${manifestPath}: version "${manifest.version}" matches ${pkgPath} version "${pkg.version}"`,
	);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Every workspace member's package.json, discovered from the root
 * package.json "workspaces" globs (plus the root manifest itself, which also
 * declares @draht/* deps). Deliberately not a hardcoded list — the hardcoded
 * list is what let packages/web-ui/example keep its file: specifiers.
 */
// Walk an overrides/resolutions block, which may nest arbitrarily
// (e.g. overrides.gaxios.rimraf), invoking visit(dottedPath, stringValue) for
// every leaf specifier.
function walkOverrides(node, path, visit) {
	if (!node || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node)) {
		const childPath = `${path}.${key}`;
		if (typeof value === "string") visit(childPath, value);
		else walkOverrides(value, childPath, visit);
	}
}

function discoverWorkspacePackageJsons() {
	const patterns = Array.isArray(rootPkg.workspaces)
		? rootPkg.workspaces
		: (rootPkg.workspaces?.packages ?? []);
	const dirs = new Set();
	for (const pattern of patterns) {
		const starIndex = pattern.indexOf("*");
		if (starIndex === -1) {
			dirs.add(pattern.replace(/\/+$/, ""));
			continue;
		}
		// Only trailing "<base>/*" globs are supported. A "*" anywhere else
		// (e.g. "apps/*/pkg") would compute a wrong base and silently produce
		// bogus paths, so record it instead of guessing.
		if (pattern.slice(starIndex) !== "*") {
			unsupportedWorkspacePatterns.push(pattern);
			continue;
		}
		const base = pattern.slice(0, starIndex).replace(/\/+$/, "");
		const absBase = resolve(root, base);
		if (!existsSync(absBase)) continue;
		let entries;
		try {
			entries = readdirSync(absBase, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			dirs.add(`${base}/${entry.name}`);
		}
	}
	const results = ["package.json"];
	for (const dir of [...dirs].sort()) {
		const relPath = `${dir}/package.json`;
		if (existsSync(resolve(root, relPath))) results.push(relPath);
	}
	return results;
}

function findPackageJsons(baseDir) {
	const results = [];
	walkDir(baseDir, (filePath) => {
		if (filePath.endsWith("/package.json")) {
			results.push(relative(root, filePath));
		}
	});
	return results.sort();
}

function findReadmes(baseDir) {
	const results = [];
	walkDir(baseDir, (filePath) => {
		if (filePath.endsWith("/README.md") || filePath.endsWith("/readme.md")) {
			results.push(filePath);
		}
	});
	return results.sort();
}

function walkDir(dir, visit) {
	if (!existsSync(dir)) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === "node_modules" ||
				entry.name === ".git" ||
				entry.name === "dist" ||
				entry.name === ".next"
			)
				continue;
			walkDir(fullPath, visit);
		} else if (entry.isFile()) {
			visit(fullPath);
		}
	}
}

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed\n`);
if (failures > 0) {
	process.exit(1);
}
