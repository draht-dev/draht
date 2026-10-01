import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shards, testPackages } from "./ci-test-matrix.mjs";

/**
 * The shard map has to cover the workspace fan-out exactly (P36-CI).
 *
 * CI no longer runs the workspace tests as one step; it runs the shards this
 * module emits, in parallel. That trade is only safe while the shards partition
 * the package set: a package in no shard is a suite CI silently stopped running,
 * which is the exact failure `root-test-script-parity.test.mjs` exists to
 * prevent for `scripts/`. This is that gate for the workspace half.
 *
 * Evidence class: class 2 wiring gate. It closes no acceptance clause; it exists
 * so the suites it points at actually run.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the shards partition the workspace test set — nothing missing, nothing twice", () => {
	const expected = testPackages();
	assert.ok(expected.length > 0, "found no workspace package with a test script — the walk is broken, not the wiring");

	const covered = shards().flatMap((entry) => entry.packages);
	const duplicated = covered.filter((pkg, index) => covered.indexOf(pkg) !== index);
	assert.deepEqual(duplicated, [], `these packages are in more than one shard, so CI runs them twice:\n  ${duplicated.join("\n  ")}`);

	const missing = expected.filter((pkg) => !covered.includes(pkg));
	assert.deepEqual(
		missing,
		[],
		`these packages declare a test script that no CI shard runs:\n  ${missing.join("\n  ")}\n` +
			"They would read as coverage and prove nothing. Add them to a shard in scripts/ci-test-matrix.mjs.",
	);
	assert.deepEqual([...covered].sort(), expected, "the shard map and the workspace set disagree");
});

test("every shard is non-empty and uniquely named", () => {
	const map = shards();
	assert.ok(map.length >= 2, "a single shard is not a split; the workflow's parallel matrix would be pointless");
	for (const { shard, packages } of map) {
		assert.ok(packages.length > 0, `shard "${shard}" is empty, so its CI job would pass by doing nothing`);
	}
	const names = map.map((entry) => entry.shard);
	assert.deepEqual([...new Set(names)], names, `duplicate shard names would collide as job ids: ${names.join(", ")}`);
});

test("--matrix emits the JSON the workflow feeds to the job matrix", () => {
	const raw = execFileSync("node", [join(ROOT, "scripts", "ci-test-matrix.mjs"), "--matrix"], { encoding: "utf-8" });
	const parsed = JSON.parse(raw);
	assert.deepEqual(
		parsed,
		shards().map(({ shard }) => shard),
		"--matrix must name exactly the shards this module defines, in order",
	);
	// The workflow reads this straight out of GITHUB_OUTPUT, which is line-based.
	assert.equal(raw.trimEnd().includes("\n"), false, "--matrix must emit one line: it is written to GITHUB_OUTPUT");
});

test("an unknown shard fails loudly instead of running nothing", () => {
	assert.throws(
		() => execFileSync("node", [join(ROOT, "scripts", "ci-test-matrix.mjs"), "--run", "no-such-shard"], { stdio: "pipe" }),
		/unknown shard/,
	);
});
