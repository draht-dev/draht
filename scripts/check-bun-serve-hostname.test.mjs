import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findUnnamedBinds, stripNonCode, topLevelKeys } from "./check-bun-serve-hostname.mjs";

/**
 * Mutation proof for the repo-wide bind gate (R32-FLEET.9).
 *
 * A gate nobody has watched fail is not a gate. These tests run the real
 * script against the real worktree, inject a hostname-less `Bun.serve` into a
 * real package, and assert the gate fails and names the file and line — then
 * assert the tree is green again once the injection is removed.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "check-bun-serve-hostname.mjs");

function runGate() {
	const res = spawnSync(process.execPath, [GATE], { encoding: "utf-8" });
	return { exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Write `content` to `file`, run `fn`, and always delete the file afterwards. */
function withInjected(file, content, fn) {
	writeFileSync(file, content);
	try {
		fn();
	} finally {
		rmSync(file, { force: true });
	}
}

test("the untouched worktree passes the gate", () => {
	const { exitCode, stdout } = runGate();
	assert.equal(exitCode, 0, stdout);
	assert.match(stdout, /every Bun\.serve names its interface/);
});

test("a hostname-less Bun.serve anywhere in the repo fails the gate, by file and line", () => {
	// Precondition, so any failure below is caused by the injection alone.
	assert.equal(runGate().exitCode, 0);

	for (const pkg of ["gateway", "geist"]) {
		const relative = `packages/${pkg}/src/__bind-gate-mutation__.ts`;
		const file = join(ROOT, relative);
		const content = ["// a listener that never names its interface\n", "Bun.serve({ port: 0, fetch: () => new Response('x') });\n"].join(
			"",
		);
		withInjected(file, content, () => {
			const { exitCode, stderr } = runGate();
			assert.equal(exitCode, 1, `expected the gate to fail for ${relative}`);
			assert.match(stderr, new RegExp(`${relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2`));
			assert.match(stderr, /binds EVERY interface/);
		});
	}

	// Cleaned up: green again.
	assert.equal(runGate().exitCode, 0);
});

test("the shapes that hide the bind interface all fail", () => {
	const file = join(ROOT, "packages/gateway/src/__bind-gate-mutation__.ts");
	const cases = [
		["no options at all", "Bun.serve();\n", /nothing names the interface/],
		["options behind a variable", "const opts = { port: 0 };\nBun.serve(opts);\n", /not an object literal/],
		["options spread from elsewhere", "const o = { port: 0 };\nBun.serve({ ...o, fetch: null });\n", /spreads another value/],
		[
			"hostname nested under tls, not at the top level",
			"Bun.serve({ port: 0, tls: { hostname: 'x' } });\n",
			/binds EVERY interface/,
		],
	];

	for (const [label, content, expected] of cases) {
		withInjected(file, content, () => {
			const { exitCode, stderr } = runGate();
			assert.equal(exitCode, 1, `${label}: expected the gate to fail`);
			assert.match(stderr, expected, label);
		});
	}

	assert.equal(runGate().exitCode, 0);
});

test("the accepted shapes really are accepted", () => {
	const file = join(ROOT, "packages/gateway/src/__bind-gate-mutation__.ts");
	const cases = [
		["explicit loopback", 'Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: null });\n'],
		["explicit wildcard, opted into elsewhere", 'Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: null });\n'],
		["shorthand property", "const hostname = '127.0.0.1';\nBun.serve({ port: 0, hostname, fetch: null });\n"],
		["unix socket has no interface", 'Bun.serve({ unix: "/tmp/x.sock", fetch: null });\n'],
	];

	for (const [label, content] of cases) {
		withInjected(file, content, () => {
			assert.equal(runGate().exitCode, 0, `${label}: expected the gate to pass`);
		});
	}
});

test("prose and fixtures are not code: comments and string literals never trip the gate", () => {
	// This is why the gate can be written in JS at all — `lifecycle.ts` documents
	// "the object returned by Bun.serve()", and this very test file holds
	// hostname-less call sites inside string literals.
	assert.deepEqual(findUnnamedBinds("// see Bun.serve() for details\n"), []);
	assert.deepEqual(findUnnamedBinds("/* Bun.serve({ port }) binds everything */\n"), []);
	assert.deepEqual(findUnnamedBinds('const fixture = "Bun.serve({ port: 0 })";\n'), []);
	assert.deepEqual(findUnnamedBinds("const fixture = `Bun.serve({ port: 0 })`;\n"), []);
	assert.deepEqual(findUnnamedBinds("type S = ReturnType<typeof Bun.serve>;\n"), []);

	// ...and why it still sees the real thing on the line after the prose.
	const mixed = "// Bun.serve() in a comment\nBun.serve({ port: 0 });\n";
	assert.deepEqual(
		findUnnamedBinds(mixed).map((f) => f.line),
		[2],
	);
});

test("stripNonCode keeps offsets and line numbers intact", () => {
	const source = "a;\n// comment\n'str';\nb;\n";
	const stripped = stripNonCode(source);
	assert.equal(stripped.length, source.length);
	assert.equal(stripped.split("\n").length, source.split("\n").length);
	assert.equal(stripped.split("\n")[1].trim(), "");
	assert.equal(stripped.split("\n")[3], "b;");
});

test("topLevelKeys reads only the outermost object", () => {
	assert.deepEqual(topLevelKeys("{ port: 0, hostname: '1' }"), ["port", "hostname"]);
	assert.deepEqual(topLevelKeys("{ port, hostname }"), ["port", "hostname"]);
	assert.deepEqual(topLevelKeys("{ port: 0, tls: { hostname: 'x' } }"), ["port", "tls"]);
	assert.deepEqual(topLevelKeys("{ ...base, port: 0 }"), ["...", "port"]);
	assert.deepEqual(topLevelKeys('{ "hostname": "1" }'), ["hostname"]);
});
