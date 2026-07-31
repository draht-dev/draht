#!/usr/bin/env node
/**
 * Sanity-checks `go run ./cmd/grammar-tags`'s output. This is deliberately
 * NOT a comparison against a second, hand-written tag list: go/internal/langset's
 * whole reason to exist is that there is exactly ONE source for the
 * grammar_subset tag list (see its package doc), consumed identically —
 * dynamically, via `$(go run ./cmd/grammar-tags)` — by go/Makefile,
 * scripts/build-graph-binaries.sh and .github/workflows/ci.yml. There is
 * nothing else in this repo to diff it against without reintroducing the
 * exact hand-copied-list hazard that package closes.
 *
 * What this DOES catch: cmd/grammar-tags panicking, printing nothing, or
 * producing malformed/duplicate/unsorted output — regressions in
 * internal/langset that would otherwise only surface inside the Go test
 * suite (which `bun run check` does not run, since that job has no Go
 * toolchain — see .github/workflows/ci.yml's `go` job for the real,
 * behavioral coupling guard: internal/parse/grammarsubset_test.go's
 * TestShippedGrammarSubsetSupportsEveryCLILanguage, run in the TAGGED pass).
 *
 * Usage: node scripts/check-grammar-tags.mjs
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GO_DIR = join(ROOT, "go");

function fail(msg) {
	console.error(`check:grammar-tags: ${msg}`);
	process.exit(1);
}

let stdout;
try {
	stdout = execFileSync("go", ["run", "./cmd/grammar-tags"], { cwd: GO_DIR, encoding: "utf-8" });
} catch (e) {
	fail(`\`go run ./cmd/grammar-tags\` failed: ${e.message}`);
}

const tags = stdout.trim().split(/\s+/).filter(Boolean);
if (!tags.length) fail("produced an empty tag list");
if (tags[0] !== "grammar_subset") fail(`expected the first tag to be "grammar_subset" (the master switch), got "${tags[0]}"`);

const rest = tags.slice(1);
if (!rest.length) fail("no per-grammar grammar_subset_<name> tags — only the master switch");
for (const t of rest) {
	if (!/^grammar_subset_[a-z0-9_]+$/.test(t)) fail(`malformed tag: "${t}"`);
}
if (new Set(rest).size !== rest.length) fail("duplicate tags in output");
const sorted = [...rest].sort();
if (sorted.join(" ") !== rest.join(" ")) fail("tags are not sorted (BuildTags's documented invariant)");

console.log(`check:grammar-tags: ok (${tags.length} tags: ${tags.join(" ")})`);
