"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cli = path.resolve(__dirname, "../bin/draht-tools.cjs");

function runMap(extraArgs = [], extraEnv = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-shim-test-"));
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
	fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "draht-shim-home-"));
	const result = spawnSync(process.execPath, [cli, "map-graph", "--quiet", ...extraArgs], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			PATH: "",
			DRAHT_GRAPH_BIN: "",
			DRAHT_GRAPH_ENGINE: "auto",
			...extraEnv,
		},
	});
	return { ...result, root };
}

test("auto mode warns when symbol signatures cannot be provided by a Go binary", () => {
	const result = runMap(["--symbol-signatures"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /--symbol-signatures requires the Go graph engine/i);
	const map = JSON.parse(fs.readFileSync(path.join(result.root, ".planning/codebase/MAP.json"), "utf8"));
	assert.equal(JSON.stringify(map).includes('"signature"'), false);
});

test("forced Go mode fails clearly when symbol signatures cannot be provided", () => {
	const result = runMap(["--symbol-signatures"], { DRAHT_GRAPH_ENGINE: "go" });
	assert.equal(result.status, 127);
	assert.match(result.stderr, /Go graph engine was required/i);
});

test("default auto commands preserve silent JavaScript fallback", () => {
	const result = runMap();
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /requires the Go graph engine|symbol-signatures/i);
});
