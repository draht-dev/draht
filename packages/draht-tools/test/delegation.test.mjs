import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve(import.meta.dirname, "../bin/draht-tools.cjs");

function delegatedArgs(t, args) {
	const dir = mkdtempSync(join(tmpdir(), "draht-delegation-"));
	t.after(() => import("node:fs").then(({ rmSync }) => rmSync(dir, { recursive: true, force: true })));
	const capture = join(dir, "args.txt");
	const fake = join(dir, "draht-graph");
	writeFileSync(fake, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$DRAHT_CAPTURE_ARGS\"\n", "utf8");
	chmodSync(fake, 0o755);
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			DRAHT_GRAPH_BIN: fake,
			DRAHT_GRAPH_ENGINE: "go",
			DRAHT_CAPTURE_ARGS: capture,
		},
	});
	assert.equal(result.status, 0, result.stderr);
	return readFileSync(capture, "utf8").trim().split("\n");
}

test("delegated map-serve defaults to the regex parser", (t) => {
	assert.deepEqual(delegatedArgs(t, ["map-serve", "--no-open"]), [
		"map-serve",
		"--parser",
		"regex",
		"--no-open",
	]);
});

test("delegated map-serve preserves an explicit parser", (t) => {
	assert.deepEqual(delegatedArgs(t, ["map-serve", "--parser=treesitter", "--no-open"]), [
		"map-serve",
		"--parser=treesitter",
		"--no-open",
	]);
});
