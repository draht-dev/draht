import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CI parity for the root `test` script (P33-T25).
 *
 * Phase 33 added spawned-process and browser suites faster than anyone was
 * wiring them up, and a suite that exists but is never invoked is worse than no
 * suite at all: it reads as coverage in a review and proves nothing in CI. Two
 * of them (`geist-reach-browser.e2e.test.mjs`, `geist-device-evidence.test.mjs`)
 * were in fact written and left unreachable, and `publish-workspaces.test.mjs`
 * had been unreachable since long before this phase — nobody noticed, because
 * nothing was watching.
 *
 * This file watches. It walks the tree, parses the root `test` script (following
 * `npm run <name>` indirection so the script may be split into as many
 * sub-scripts as the run budget needs), and fails the moment the two sets
 * disagree — in either direction:
 *
 *   • a `*.test.mjs` under `scripts/` that `npm test` does not reach;
 *   • a path the script names that does not exist on disk (a rename or typo,
 *     which `node --test` reports as a *passing* run of zero files);
 *   • a `*.e2e.test.ts` under `packages/gateway` that the workspace fan-out
 *     does not reach.
 *
 * Evidence class: this is a **class 2** in-process check and closes no
 * acceptance clause on its own. It is a wiring gate — it exists so that the
 * class 3 suites it points at actually run.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PACKAGE_JSON = join(ROOT, "package.json");
const GATEWAY_DIR = join(ROOT, "packages", "gateway");

/** Directory names never worth descending into when hunting for test files. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

/** Recursively collect files under `dir` whose basename matches `predicate`. */
function walk(dir, predicate, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(join(dir, entry.name), predicate, found);
		} else if (entry.isFile() && predicate(entry.name)) {
			found.push(join(dir, entry.name));
		}
	}
	return found;
}

function readRootScripts() {
	return JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf-8")).scripts ?? {};
}

/**
 * Resolve the root `test` script to the concrete test files it runs.
 *
 * Handles the three shapes this repo's scripts actually use:
 *   `node --test <files...>`, `bun test <files...>`, and `npm ... run <name>`
 * indirection (including `npm --workspaces --if-present run test`, which is
 * recorded as a workspace fan-out rather than as file paths — the flags sit
 * before `run` so that `bun run test` does not rewrite the segment into a
 * recursive `bun run test` invocation of the root script itself).
 *
 * Returns `{ files, workspaceFanOut, unresolved }` where `files` are repo-relative
 * POSIX paths, and `unresolved` holds any segment the parser did not understand —
 * asserted empty, so a future shell construct fails loudly instead of silently
 * shrinking the reachable set and making this whole file vacuous.
 */
function resolveTestScript(scripts, scriptName = "test", seen = new Set()) {
	const files = new Set();
	const unresolved = [];
	let workspaceFanOut = false;

	if (seen.has(scriptName)) return { files, workspaceFanOut, unresolved };
	seen.add(scriptName);

	const body = scripts[scriptName];
	assert.ok(typeof body === "string", `root package.json has no "${scriptName}" script`);

	for (const rawSegment of body.split("&&")) {
		const segment = rawSegment.trim();
		if (segment === "") continue;
		const tokens = segment.split(/\s+/);

		if (tokens[0] === "npm" && tokens.includes("run")) {
			if (tokens.includes("--workspaces")) {
				workspaceFanOut = true;
				continue;
			}
			const nested = resolveTestScript(scripts, tokens[tokens.indexOf("run") + 1], seen);
			for (const file of nested.files) files.add(file);
			workspaceFanOut ||= nested.workspaceFanOut;
			unresolved.push(...nested.unresolved);
			continue;
		}

		const isNodeTest = tokens[0] === "node" && tokens.includes("--test");
		const isBunTest = tokens[0] === "bun" && tokens[1] === "test";
		if (!isNodeTest && !isBunTest) {
			unresolved.push(segment);
			continue;
		}

		for (const token of tokens.slice(1)) {
			if (token.startsWith("-")) continue;
			if (token === "test") continue;
			if (!/\.test\.(mjs|ts|js)$/.test(token)) continue;
			files.add(token.replace(/^\.\//, ""));
		}
	}

	return { files, workspaceFanOut, unresolved };
}

const repoRelative = (absolute) => relative(ROOT, absolute).split("\\").join("/");

test("the root test script is parseable — every segment is understood", () => {
	const { unresolved, files } = resolveTestScript(readRootScripts());
	assert.deepEqual(
		unresolved,
		[],
		"the root `test` script contains a segment this parity check cannot parse; teach " +
			"resolveTestScript() about it rather than leaving the reachable set silently short",
	);
	assert.ok(files.size > 0, "parsed zero test files out of the root `test` script — the check would be vacuous");
});

test("every scripts/*.test.mjs file is reachable from the root test script", () => {
	const { files } = resolveTestScript(readRootScripts());
	// `.test.ts` too: there are none under scripts/ today, and this is what stops
	// the next one being added in a language the walk was not looking at.
	const isTestFile = (name) => name.endsWith(".test.mjs") || name.endsWith(".test.ts");
	const onDisk = walk(join(ROOT, "scripts"), isTestFile).map(repoRelative).sort();
	assert.ok(onDisk.length > 0, "found no *.test.mjs under scripts/ — the walk is broken, not the wiring");

	const unwired = onDisk.filter((file) => !files.has(file));
	assert.deepEqual(
		unwired,
		[],
		`these test suites exist but \`npm test\` never runs them:\n  ${unwired.join("\n  ")}\n` +
			"Add them to the root `test` script (or one of the sub-scripts it chains).",
	);
});

test("every path the root test script names exists on disk", () => {
	// `node --test missing-file.mjs` exits 0. A rename that forgets package.json
	// therefore turns a suite off without turning CI red — this is that gate.
	const { files } = resolveTestScript(readRootScripts());
	const missing = [...files]
		.filter((file) => {
			try {
				return !statSync(join(ROOT, file)).isFile();
			} catch {
				return true;
			}
		})
		.sort();
	assert.deepEqual(missing, [], `the root \`test\` script names files that do not exist:\n  ${missing.join("\n  ")}`);
});

test("every packages/gateway *.e2e.test.ts file is reachable from the root test script", () => {
	const scripts = readRootScripts();
	const { workspaceFanOut } = resolveTestScript(scripts);
	assert.ok(
		workspaceFanOut,
		"the root `test` script no longer fans out to the workspaces, so no gateway test runs from `npm test`",
	);

	const gatewayPkg = JSON.parse(readFileSync(join(GATEWAY_DIR, "package.json"), "utf-8"));
	const gatewayTest = gatewayPkg.scripts?.test;
	assert.ok(typeof gatewayTest === "string", "packages/gateway declares no `test` script, so --if-present skips it");

	const e2e = walk(GATEWAY_DIR, (name) => name.endsWith(".e2e.test.ts")).map(repoRelative).sort();
	assert.ok(e2e.length > 0, "found no *.e2e.test.ts under packages/gateway — the walk is broken, not the wiring");

	// `bun test` with no path arguments globs the whole package, which reaches
	// every file above. Anything narrower has to name them.
	const args = gatewayTest.split(/\s+/).slice(2);
	const globsEverything = gatewayTest.trim().startsWith("bun test") && args.every((a) => a.startsWith("-"));
	if (globsEverything) return;

	const unwired = e2e.filter((file) => !args.some((arg) => file.endsWith(arg.replace(/^\.\//, ""))));
	assert.deepEqual(
		unwired,
		[],
		`packages/gateway's \`test\` script (${gatewayTest}) does not reach:\n  ${unwired.join("\n  ")}`,
	);
});
