#!/usr/bin/env node
/**
 * The CI shard map for the workspace test fan-out.
 *
 * `npm --workspaces --if-present run test` runs 25 packages in series, and two
 * of them are the whole cost: on a 4-vCPU runner, gateway takes ~384s and
 * coding-agent ~212s, against ~90s for the other 23 combined. Running that as
 * one step means the job is as slow as the sum. This file cuts it into shards
 * CI runs in parallel, so the test phase costs its slowest shard instead.
 *
 * The shards are DERIVED, never hand-listed: the package set is read from the
 * root `workspaces` globs at run time, the heavyweights below are given a shard
 * each, and everything else falls into `rest`. A package added tomorrow lands in
 * `rest` on its own — the failure mode this avoids is a new suite that exists,
 * is never run by any shard, and reads as coverage in a review.
 * `ci-test-matrix.test.mjs` asserts the shards partition the set exactly.
 *
 * Usage:
 *   node scripts/ci-test-matrix.mjs --matrix      # compact JSON array of shard names
 *   node scripts/ci-test-matrix.mjs --run <shard> # run one shard's packages
 *   node scripts/ci-test-matrix.mjs               # human-readable listing
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Packages that get a shard to themselves, longest first.
 *
 * Measured on ubuntu-latest, CI run 33118600321. Revisit when a third package
 * grows past a minute: the point is to keep the slowest shard small, not to
 * keep this list short.
 */
const HEAVY = ["@draht/gateway", "@draht/coding-agent"];

/** Shard name for a package: the scope is noise once it is a job label. */
const shardNameFor = (pkg) => pkg.replace(/^@[^/]+\//, "");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/** Expand the root `workspaces` globs. Only the `dir/*` form this repo uses. */
function workspaceDirs() {
	const dirs = [];
	for (const pattern of readJson(join(ROOT, "package.json")).workspaces ?? []) {
		if (!pattern.endsWith("/*")) {
			dirs.push(join(ROOT, pattern));
			continue;
		}
		const parent = join(ROOT, pattern.slice(0, -2));
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.push(join(parent, entry.name));
		}
	}
	return dirs;
}

/** Every workspace package that declares a `test` script, deduped by name. */
export function testPackages() {
	const byName = new Map();
	for (const dir of workspaceDirs()) {
		const manifest = join(dir, "package.json");
		try {
			if (!statSync(manifest).isFile()) continue;
		} catch {
			continue;
		}
		const pkg = readJson(manifest);
		if (!pkg.name || byName.has(pkg.name)) continue;
		if (typeof pkg.scripts?.test !== "string") continue;
		byName.set(pkg.name, pkg.name);
	}
	return [...byName.keys()].sort();
}

/** The shard map: one per heavyweight, then everything remaining as `rest`. */
export function shards() {
	const all = testPackages();
	const heavy = HEAVY.filter((pkg) => all.includes(pkg));
	const rest = all.filter((pkg) => !heavy.includes(pkg));
	const out = heavy.map((pkg) => ({ shard: shardNameFor(pkg), packages: [pkg] }));
	if (rest.length > 0) out.push({ shard: "rest", packages: rest });
	return out;
}

function runShard(name) {
	const shard = shards().find((entry) => entry.shard === name);
	if (!shard) {
		console.error(`unknown shard "${name}"; known: ${shards().map((s) => s.shard).join(", ")}`);
		process.exit(2);
	}
	// Flags before `run`, matching the root `test` script, so that invoking this
	// through `bun run` cannot rewrite the segment into a recursive call.
	const args = ["--if-present", ...shard.packages.map((pkg) => `--workspace=${pkg}`), "run", "test"];
	console.log(`shard ${name}: ${shard.packages.join(" ")}`);
	const result = spawnSync("npm", args, { cwd: ROOT, stdio: "inherit" });
	process.exit(result.status ?? 1);
}

// Only when invoked as a command. Importing this module (the parity gate does)
// must not print or exit.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [flag, value] = process.argv.slice(2);
if (!invokedDirectly) {
	// nothing to do: imported for `shards()` / `testPackages()`
} else if (flag === "--matrix") {
	console.log(JSON.stringify(shards().map(({ shard }) => shard)));
} else if (flag === "--run") {
	runShard(value);
} else {
	for (const { shard, packages } of shards()) {
		console.log(`${shard.padEnd(14)} ${packages.length} package(s)`);
		for (const pkg of packages) console.log(`    ${pkg}`);
	}
}
