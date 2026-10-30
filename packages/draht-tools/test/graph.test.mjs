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

// DRAHT_GRAPH_ENGINE=js pins every invocation to the CJS engine under test —
// with the default `auto`, an installed `draht-graph` binary (possibly older)
// would be exercised instead of this checkout's implementation.
const ENV = { ...process.env, DRAHT_GRAPH_ENGINE: "js" };

function run(args, opts = {}) {
	return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf-8", env: ENV, ...opts });
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
	write("src/util.ts", [
		"// Example (commented out, must NOT become a public export):",
		"// export { Admin } from \"./internal\";",
		"/* export { Ghost } from \"./internal\"; */",
		"export function formatId(x: string) { return x.trim(); }",
	].join("\n"));
	// Barrel: multi-line named re-export block + star re-export. The leading
	// multiline block comment regression-tests the newline-preserving comment
	// strip: a fully-deleted comment used to shift every import/re-export
	// line computed after it.
	write("src/index.ts", [
		"/**",
		" * Public API barrel.",
		" */",
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
	// Line 8 of index.ts — after the 3-line block comment. A line-shifting
	// comment strip reported 5 here.
	assert.equal(session.line, 8, "star re-export line shifted by the leading block comment");
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
	assert.match(out, /index\.ts/, `expected the barrel itself as a hit for its re-exported symbol:\n${out}`);
	assert.match(out, /auth\.ts/, `expected the defining module as a hit:\n${out}`);
});

test("commented-out export examples are not reported as exports", () => {
	const map = loadMap();
	const util = map.modules.find((m) => m.id === "src/util.ts");
	const names = util.exports.map((e) => e.name);
	assert.ok(!names.includes("Admin"), `line-commented export example leaked: ${names}`);
	assert.ok(!names.includes("Ghost"), `block-commented export example leaked: ${names}`);
	assert.ok(names.includes("formatId"), `real export lost by comment masking: ${names}`);
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

test("star expansion drops names exported ambiguously by two star targets (ES spec)", () => {
	const ambRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draht-amb-test-"));
	try {
		fs.mkdirSync(path.join(ambRoot, ".git"));
		fs.writeFileSync(path.join(ambRoot, "package.json"), JSON.stringify({ name: "amb", version: "1.0.0" }));
		fs.mkdirSync(path.join(ambRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(ambRoot, "src/x.ts"), "export const dup = 1;\nexport const onlyx = 2;\n");
		fs.writeFileSync(path.join(ambRoot, "src/y.ts"), "export const dup = 2;\nexport const onlyy = 3;\n");
		// barrel: two stars whose targets both export `dup` from different origins → ambiguous, dropped
		fs.writeFileSync(path.join(ambRoot, "src/amb.ts"), 'export * from "./x.js";\nexport * from "./y.js";\n');
		// two chains to the SAME origin: one binding, not ambiguous — survives
		fs.writeFileSync(path.join(ambRoot, "src/viaa.ts"), 'export * from "./x.js";\n');
		fs.writeFileSync(path.join(ambRoot, "src/viab.ts"), 'export * from "./x.js";\n');
		fs.writeFileSync(path.join(ambRoot, "src/same.ts"), 'export * from "./viaa.js";\nexport * from "./viab.js";\n');
		execFileSync(process.execPath, [CLI, "map-graph", "--quiet"], { cwd: ambRoot, encoding: "utf-8", env: ENV });
		const m = JSON.parse(fs.readFileSync(path.join(ambRoot, ".planning/codebase/MAP.json"), "utf-8"));
		const amb = m.modules.find((x) => x.id === "src/amb.ts");
		const names = amb.exports.map((e) => e.name);
		assert.ok(!names.includes("dup"), `ambiguous star export must be dropped: ${names}`);
		assert.ok(names.includes("onlyx") && names.includes("onlyy"), `unambiguous names lost: ${names}`);
		const same = m.modules.find((x) => x.id === "src/same.ts");
		const dupSame = same.exports.find((e) => e.name === "dup");
		assert.ok(dupSame, `same-origin name wrongly treated as ambiguous: ${JSON.stringify(same.exports)}`);
		assert.equal(dupSame.via, "src/x.ts");
	} finally {
		fs.rmSync(ambRoot, { recursive: true, force: true });
	}
});

test("star expansion reaches fixpoint on deep barrel chains (>5 hops)", () => {
	// b0 —star→ b1 —star→ … —star→ b7 (defines the symbols). The expansion
	// loop iterates barrels in SORTED id order, so this orientation forces a
	// new pass per hop: b0's target b1 is still empty on pass 1, and the
	// symbol only ratchets outward one barrel per pass. A fixed pass ceiling
	// left the outer barrels empty (greptile P1).
	const chainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draht-chain-test-"));
	try {
		fs.mkdirSync(path.join(chainRoot, ".git"));
		fs.writeFileSync(path.join(chainRoot, "package.json"), JSON.stringify({ name: "chain", version: "1.0.0" }));
		fs.mkdirSync(path.join(chainRoot, "src"), { recursive: true });
		fs.writeFileSync(path.join(chainRoot, "src/b7.ts"), "export function deepest() { return 1; }\nexport default class Widget {}\n");
		for (let i = 0; i <= 6; i++) {
			fs.writeFileSync(path.join(chainRoot, `src/b${i}.ts`), `export * from "./b${i + 1}.js";\n`);
		}
		execFileSync(process.execPath, [CLI, "map-graph", "--quiet"], { cwd: chainRoot, encoding: "utf-8", env: ENV });
		const m = JSON.parse(fs.readFileSync(path.join(chainRoot, ".planning/codebase/MAP.json"), "utf-8"));
		const outer = m.modules.find((x) => x.id === "src/b0.ts");
		assert.ok(outer.exports.some((e) => e.name === "deepest"), `outer barrel missing deep symbol: ${JSON.stringify(outer.exports)}`);
		assert.equal(outer.exports.find((e) => e.name === "deepest").via, "src/b7.ts");
		// A bare `export *` never forwards the default export (ES spec) — not as
		// `default` and not under the declaration's local name (`Widget` binds
		// locally only).
		assert.ok(!outer.exports.some((e) => e.name === "default"), `default leaked through a bare star re-export: ${JSON.stringify(outer.exports)}`);
		assert.ok(!outer.exports.some((e) => e.name === "Widget"), `default declaration's local name leaked through a bare star re-export: ${JSON.stringify(outer.exports)}`);
		// … but the defining file itself still records Widget as a (non-exported)
		// symbol, so search can find it by its real name.
		const defining = m.modules.find((x) => x.id === "src/b7.ts");
		const widget = defining.symbols.find((s) => s.name === "Widget");
		assert.ok(widget, `named default declaration missing from its own file's symbols: ${JSON.stringify(defining.symbols)}`);
		assert.equal(widget.exported, false);
	} finally {
		fs.rmSync(chainRoot, { recursive: true, force: true });
	}
});
