// Regression tests for the graphify-parity kg engine (draht-kg.cjs).
// Synthetic fixture repo in a temp dir; zero dependencies (node:test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/draht-tools.cjs");
let root;

function run(args) {
	return execFileSync(process.execPath, [CLI, "kg", ...args], { cwd: root, encoding: "utf-8" });
}

function write(rel, content) {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "draht-kg-test-"));
	fs.mkdirSync(path.join(root, ".git"));
	write("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
	write("src/base.ts", [
		"/** Base storage abstraction. */",
		"export class Store {",
		"\tsave(key: string): void {}",
		"}",
		"export function helper(x: string) { return x; }",
	].join("\n"));
	write("src/session.ts", [
		"import { Store, helper } from \"./base.js\";",
		"export class SessionStore extends Store {",
		"\tload(): void {",
		"\t\thelper(\"a\");",
		"\t\tthis.save(\"k\");",
		"\t}",
		"}",
		"export function openSession() {",
		"\tconst s = new SessionStore();",
		"\treturn s;",
		"}",
	].join("\n"));
	write("src/index.ts", "export { openSession } from \"./session.js\";\n");
	run(["build", "--quiet"]);
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function loadGraph() {
	return JSON.parse(fs.readFileSync(path.join(root, ".planning/codebase/graph.json"), "utf-8"));
}

test("node ids follow graphify canonicalization (path segments + symbol, casefolded)", () => {
	const g = loadGraph();
	const ids = new Set(g.nodes.map((n) => n.id));
	assert.ok(ids.has("src_base"), "file node id");
	assert.ok(ids.has("src_base_store"), "class node id");
	assert.ok(ids.has("src_base_store_save"), "method node id");
	assert.ok(ids.has("src_session_opensession"), "function node id casefolded");
});

test("symbol nodes carry graphify fields (label decoration, source_location, community)", () => {
	const g = loadGraph();
	const fn = g.nodes.find((n) => n.id === "src_session_opensession");
	assert.equal(fn.label, "openSession()");
	assert.match(fn.source_location, /^L\d+$/);
	assert.ok(fn.community != null, "community missing");
	assert.ok(fn.norm_label, "norm_label missing");
});

test("relation set: contains/method/defines/imports_from/imports/re_exports/inherits/calls/instantiates", () => {
	const g = loadGraph();
	const rels = new Set(g.edges.map((e) => e.relation));
	for (const r of ["contains", "method", "defines", "imports_from", "imports", "re_exports", "inherits", "calls", "instantiates"]) {
		assert.ok(rels.has(r), `missing relation ${r}`);
	}
	const inherits = g.edges.find((e) => e.relation === "inherits");
	assert.equal(inherits.source, "src_session_sessionstore");
	assert.equal(inherits.target, "src_base_store");
	assert.equal(inherits.confidence, "EXTRACTED");
	assert.equal(inherits.confidence_score, 1);
});

test("import-backed cross-file call binds EXTRACTED; instantiates resolves", () => {
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.target === "src_base_helper");
	assert.ok(call, "cross-file call missing");
	assert.equal(call.confidence, "EXTRACTED");
	const inst = g.edges.find((e) => e.relation === "instantiates" && e.target === "src_session_sessionstore");
	assert.ok(inst, "instantiates missing");
});

test("this.method() binds to the inherited scope's own class when defined", () => {
	const g = loadGraph();
	// this.save() → Store.save is in the parent; the engine only binds same-class
	// methods, so no bogus edge to a non-existent SessionStore.save must exist.
	assert.ok(!g.nodes.some((n) => n.id === "src_session_sessionstore_save"), "phantom method node");
});

test("rebuild is deterministic (byte-identical graph.json)", () => {
	const p = path.join(root, ".planning/codebase/graph.json");
	const first = fs.readFileSync(p, "utf-8");
	run(["build", "--quiet"]);
	assert.equal(first, fs.readFileSync(p, "utf-8"));
});

test("kg query renders graphify NODE/EDGE traversal output", () => {
	const out = run(["query", "how does openSession work"]);
	assert.match(out, /Traversal: BFS depth=2 \| Start: \[/);
	assert.match(out, /NODE openSession\(\) \[src=src\/session\.ts/);
	assert.match(out, /EDGE .+ --\w+ \[EXTRACTED.*\]--> /);
});

test("kg explain dumps node with connections sorted by neighbor degree", () => {
	const out = run(["explain", "SessionStore"]);
	assert.match(out, /Node: SessionStore/);
	assert.match(out, /ID:\s+src_session_sessionstore/);
	assert.match(out, /Community:/);
	assert.match(out, /Connections \(\d+\):/);
	assert.match(out, /\[inherits\] \[EXTRACTED\]/);
});

test("kg path prints directed arrows with confidence", () => {
	const out = run(["path", "openSession", "Store"]);
	assert.match(out, /Shortest path \(\d+ hops\):/);
	assert.match(out, /--\w+ \[EXTRACTED\]--|<--\w+ \[EXTRACTED\]--/);
});

test("kg affected walks the reverse relation set", () => {
	const out = run(["affected", "helper", "--depth", "2"]);
	assert.match(out, /Affected by changes to 'helper\(\)'/);
	assert.match(out, /load\(\) \[via calls\]/);
});

test("KG_REPORT.md has graphify's section list", () => {
	const md = fs.readFileSync(path.join(root, ".planning/codebase/KG_REPORT.md"), "utf-8");
	for (const section of ["## Summary", "## Community Hubs", "## God Nodes", "## Surprising Connections", "## Import Cycles", "## Communities", "## Ambiguous Edges", "## Knowledge Gaps", "## Suggested Questions"]) {
		assert.ok(md.includes(section), `missing section ${section}`);
	}
	assert.match(md, /\d+% EXTRACTED · \d+% INFERRED · \d+% AMBIGUOUS/);
});

test("kg export tree/graphml/wiki produce artifacts", () => {
	run(["export", "tree"]);
	run(["export", "graphml"]);
	run(["export", "wiki"]);
	const tree = fs.readFileSync(path.join(root, ".planning/codebase/GRAPH_TREE.html"), "utf-8");
	assert.ok(tree.includes("module tree"), "tree html");
	assert.ok(tree.includes("openSession"), "tree symbols");
	const gml = fs.readFileSync(path.join(root, ".planning/codebase/graph.graphml"), "utf-8");
	assert.ok(gml.includes("<graphml") && gml.includes('relation">inherits'), "graphml");
	assert.ok(fs.existsSync(path.join(root, ".planning/codebase/kg-wiki/index.md")), "wiki index");
});

test("graph.json is graphify node-link compatible (directed, nodes+edges)", () => {
	const g = loadGraph();
	assert.equal(g.directed, true);
	assert.ok(Array.isArray(g.nodes) && Array.isArray(g.edges) && Array.isArray(g.hyperedges));
	for (const e of g.edges.slice(0, 5)) {
		assert.ok(e.source && e.target && e.relation && e.confidence, "edge fields");
		assert.ok(typeof e.confidence_score === "number");
	}
});

test("Go aliased/blank/dot imports produce imports_from edges (greptile P1)", () => {
	write("gosrc/util/util.go", "package util\n\nfunc Helper() int { return 1 }\n");
	write("gosrc/main.go", [
		"package main",
		"",
		"import (",
		"\tu \"example.com/proj/util\"",
		"\t_ \"example.com/proj/logx\"",
		")",
		"",
		"import f \"example.com/proj/fmtx\"",
		"",
		"func main() { u.Helper() }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const fromMain = g.edges.filter((e) => e.source === "gosrc_main" && e.relation === "imports_from");
	// One edge per distinct import path — the aliased block entries AND the
	// single-line named import must all survive (the old regex dropped them).
	assert.ok(fromMain.length >= 3, `aliased/blank/named Go imports dropped: ${JSON.stringify(fromMain)}`);
});

test("Rust impl methods belong to their type, not the file (greptile P1)", () => {
	write("rsrc/widget.rs", [
		"pub struct Widget { size: u32 }",
		"",
		"impl Widget {",
		"    pub fn grow(&mut self) { self.size += 1; }",
		"}",
		"",
		"pub fn free_standing() -> u32 { 2 }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	assert.ok(g.nodes.some((n) => n.id === "rsrc_widget_widget_grow"), "impl method should be owner-scoped");
	assert.ok(!g.nodes.some((n) => n.id === "rsrc_widget_grow"), "impl method must not be a file-level function");
	const methodEdge = g.edges.find((e) => e.relation === "method" && e.target === "rsrc_widget_widget_grow");
	assert.ok(methodEdge && methodEdge.source === "rsrc_widget_widget", "method edge from owning type missing");
	assert.ok(g.nodes.some((n) => n.id === "rsrc_widget_free_standing"), "top-level fn should stay file-level");
});
