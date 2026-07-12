// Knowledge-graph regression tests for draht-tools map-graph / graph-* commands.
// Runs against a synthetic fixture repo in a temp dir; zero dependencies (node:test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/draht-tools.cjs");
let root;

function run(args, opts = {}) {
	return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf-8", ...opts });
}

function write(rel, content) {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-graph-test-"));
	// Mark as repo root so findRepoRoot() anchors here regardless of what's above tmpdir.
	fs.mkdirSync(path.join(root, ".git"));
	write("package.json", JSON.stringify({ name: "fixture", version: "1.0.0", main: "src/index.ts" }));
	write("src/auth.ts", [
		"/** Resolve the session token for a user. */",
		"export function resolveAuthToken(user: string): string {",
		"\treturn user + \"-token\";",
		"}",
		"export const AUTH_HEADER = \"authorization\";",
		"// SECURITY: tokens are never logged",
		"const internalSecret = \"x\";",
	].join("\n"));
	write("src/session.ts", [
		"import { resolveAuthToken } from \"./auth.js\";",
		"/** A live session. */",
		"export class Session {",
		"\ttoken = resolveAuthToken(\"u\");",
		"}",
		"export interface SessionOptions { ttl: number }",
	].join("\n"));
	write("src/util.ts", "export function formatId(x: string) { return x.trim(); }\n");
	// Barrel: multi-line named re-export block + star re-export.
	write("src/index.ts", [
		"export {",
		"\tresolveAuthToken,",
		"\tAUTH_HEADER,",
		"} from \"./auth.js\";",
		"export * from \"./session.js\";",
		"export { formatId as fmt } from \"./util.js\";",
	].join("\n"));
	run(["map-graph", "--quiet"]);
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function loadMap() {
	return JSON.parse(fs.readFileSync(path.join(root, ".planning/codebase/MAP.json"), "utf-8"));
}

test("barrel named re-exports populate the barrel's exports and symbols", () => {
	const map = loadMap();
	const barrel = map.modules.find((m) => m.id === "src/index.ts");
	assert.ok(barrel, "barrel module missing");
	const names = barrel.exports.map((e) => e.name);
	assert.ok(names.includes("resolveAuthToken"), `multi-line re-export lost: ${names}`);
	assert.ok(names.includes("AUTH_HEADER"), `multi-line re-export lost: ${names}`);
	assert.ok(names.includes("fmt"), `aliased re-export lost: ${names}`);
	const symNames = barrel.symbols.map((s) => s.name);
	assert.ok(symNames.includes("resolveAuthToken"), "re-export missing from symbols");
});

test("star re-exports expand from the resolved target with via provenance", () => {
	const map = loadMap();
	const barrel = map.modules.find((m) => m.id === "src/index.ts");
	const session = barrel.exports.find((e) => e.name === "Session");
	assert.ok(session, "star-expanded export missing");
	assert.equal(session.kind, "re-export");
	assert.equal(session.via, "src/session.ts");
	assert.ok(barrel.exports.some((e) => e.name === "SessionOptions"), "star-expanded type export missing");
});

test("re-export edges exist alongside the expanded exports", () => {
	const map = loadMap();
	const re = map.edges.filter((e) => e.from === "src/index.ts" && e.kind === "re-export");
	assert.ok(re.length >= 3, `expected ≥3 re-export edges, got ${re.length}`);
	for (const e of re) assert.equal(e.confidence, "EXTRACTED");
});

test("rebuild is deterministic (byte-identical MAP.json)", () => {
	const p = path.join(root, ".planning/codebase/MAP.json");
	const first = fs.readFileSync(p, "utf-8");
	run(["map-graph", "--quiet"]);
	const second = fs.readFileSync(p, "utf-8");
	assert.equal(first, second, "MAP.json changed on a no-op rebuild");
});

test("cluster labels are unique", () => {
	const map = loadMap();
	const labels = map.clusters.map((c) => c.label);
	assert.equal(new Set(labels).size, labels.length, `duplicate cluster labels: ${labels}`);
});

test("graph-query matches multi-term concepts across symbols (module-level coverage)", () => {
	// "auth session": no single symbol contains both words — the old per-symbol AND returned nothing.
	const out = run(["graph-query", "auth", "session"]);
	assert.match(out, /session\.ts/, `expected session.ts in results:\n${out}`);
	assert.doesNotMatch(out, /— 0\/0 hits/);
});

test("graph-query surfaces barrel re-exported API names", () => {
	const out = run(["graph-query", "resolveauthtoken"]);
	assert.match(out, /auth\.ts|index\.ts/, `expected a hit for re-exported symbol:\n${out}`);
});

test("graph-context reports the barrel's re-exported API", () => {
	const out = run(["graph-context", "src/index.ts"]);
	assert.match(out, /exports\((?!0\))\d+/, `barrel should not report exports(0):\n${out}`);
	assert.match(out, /resolveAuthToken/);
});

test("graph-impact prints full resolved paths and real fan-in", () => {
	const out = run(["graph-impact", "src/auth.ts"]);
	assert.match(out, /impact src\/auth\.ts/, `header should echo the full path:\n${out}`);
	// session.ts imports auth.ts, index.ts re-exports both → 2 reverse-dependents.
	assert.match(out, /2 modules/, `expected 2 impacted modules:\n${out}`);
});

test("MAP.html embeds the Insights view", () => {
	run(["map-graph"]);
	const html = fs.readFileSync(path.join(root, ".planning/codebase/MAP.html"), "utf-8");
	assert.ok(html.includes('id="tab-insights"'), "Insights tab missing from MAP.html");
	assert.ok(html.includes("renderInsights"), "renderInsights missing from MAP.html");
});
