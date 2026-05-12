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
 *   3. All upstream-shared packages use workspace:* deps
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
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;
let passes = 0;

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

// ── 3. All upstream-shared packages use workspace:* ─────────────────

console.log("\nWorkspace deps");

const sharedPkgs = [
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
	"packages/mom/package.json",
	"packages/web-ui/package.json",
];

for (const pkgPath of sharedPkgs) {
	const pkg = readJson(pkgPath);
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	for (const [name, version] of Object.entries(deps)) {
		if (name.startsWith("@draht/") && version !== "workspace:*") {
			fail(`${pkgPath}: ${name} is "${version}" (expected workspace:*)`);
		}
	}
}
// If we get here without failures from the loop, mark a pass
if (failures === 0 || true) {
	// Individual failures already logged; just note overall
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
const upstreamPrefixes = ["@mariozechner/pi-", "@mariozechner/pi"];

for (const pkgPath of allPkgJsons) {
	const pkg = readJson(pkgPath);
	// Skip root private package (it's draht-monorepo, not @draht/*)
	if (pkg.private && pkgPath === "package.json") {
		check(
			pkg.name !== "pi-monorepo",
			`${pkgPath}: name is "${pkg.name}" (not pi-monorepo)`,
		);
		continue;
	}
	if (pkg.private) continue;
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

// ── Helpers ─────────────────────────────────────────────────────────

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
