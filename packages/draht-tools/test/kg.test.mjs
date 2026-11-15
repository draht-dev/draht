// Regression tests for the graphify-parity kg engine (draht-kg.cjs).
// Synthetic fixture repo in a temp dir; zero dependencies (node:test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/draht-tools.cjs");
const { parseDecls, buildGraph, maskSource, sortByPosixPath, importCycles } = createRequire(import.meta.url)("../bin/draht-kg.cjs");
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

test("braces inside strings do not hide later declarations", () => {
	write("src/braces.ts", [
		'const marker = "{";',
		"export function afterBrace() { return marker; }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	assert.ok(g.nodes.some((n) => n.id === "src_braces_afterbrace"), "symbol after a string-literal brace lost");
});

test("this.method() binds to the enclosing class, not an earlier one with the same method", () => {
	write("src/two.ts", [
		"export class Alpha {",
		"\tsave(): void {}",
		"}",
		"export class Beta {",
		"\tsave(): void {}",
		"\trun(): void { this.save(); }",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.source === "src_two_beta_run");
	assert.ok(call, "this.save() call edge missing");
	assert.equal(call.target, "src_two_beta_save", "this.save() bound to the wrong class");
});

test("top-level calls after a function body belong to the file, not the function", () => {
	write("src/toplevel.ts", [
		"export function alphaFn() { return 1; }",
		"export function betaFn() { return 2; }",
		"alphaFn();",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.target === "src_toplevel_alphafn");
	assert.ok(call, "top-level call edge missing");
	assert.equal(call.source, "src_toplevel", `top-level call attributed to ${call.source} instead of the file`);
});

test("renamed default imports resolve to the target's default declaration", () => {
	write("src/defmod.ts", "export default function original() { return 1; }\n");
	write("src/usedef.ts", [
		'import renamed from "./defmod.js";',
		"export function useIt() { return renamed(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.source === "src_usedef_useit");
	assert.ok(call, "call through renamed default import missing");
	assert.equal(call.target, "src_defmod_original");
});

test("imports and calls through a barrel follow the re-export binding", () => {
	write("src/bhelper.ts", "export function bhelp() { return 1; }\n");
	write("src/bbarrel.ts", 'export { bhelp } from "./bhelper.js";\n');
	write("src/busecaller.ts", [
		'import { bhelp } from "./bbarrel.js";',
		"export function callThrough() { return bhelp(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.source === "src_busecaller_callthrough");
	assert.ok(call, "call through barrel missing");
	assert.equal(call.target, "src_bhelper_bhelp");
	assert.ok(g.edges.some((e) => e.relation === "imports" && e.source === "src_busecaller" && e.target === "src_bhelper_bhelp"), "symbol import edge through barrel missing");
});

test("namespace member calls resolve through the imported module", () => {
	write("src/nsmod.ts", "export function nsfn() { return 1; }\n");
	write("src/nsuse.ts", [
		'import * as nsm from "./nsmod.js";',
		"export function useNs() { return nsm.nsfn(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.source === "src_nsuse_usens");
	assert.ok(call, "namespace member call missing");
	assert.equal(call.target, "src_nsmod_nsfn");
});

test("multiline function headers keep their body calls", () => {
	write("src/mlhelper.ts", "export function mlhelp() { return 1; }\n");
	write("src/mlfn.ts", [
		'import { mlhelp } from "./mlhelper.js";',
		"export function multiHeader(",
		"\tfirst: string,",
		"\tsecond: number,",
		") {",
		"\treturn mlhelp();",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.target === "src_mlhelper_mlhelp");
	assert.ok(call, "call from multiline-header function missing");
	assert.equal(call.source, "src_mlfn_multiheader", `call attributed to ${call.source} instead of the declaring function`);
});

test("commented-out import examples do not become dependencies", () => {
	write("src/cmtimp.ts", [
		"// Usage example (must NOT become a dependency):",
		'// import { bhelp } from "./bhelper.js";',
		'/* import { bhelp } from "./bhelper.js"; */',
		"export function cmtOnly() { return 1; }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const bogus = g.edges.find((e) => e.source === "src_cmtimp" && (e.relation === "imports_from" || e.relation === "imports"));
	assert.ok(!bogus, `commented import example created an edge: ${JSON.stringify(bogus)}`);
});

test("object types in function headers do not end the call region", () => {
	write("src/hdrtype.ts", [
		'import { bhelp } from "./bhelper.js";',
		"export function withOpts(options?: { shellPath?: string }) {",
		"\treturn bhelp();",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.source === "src_hdrtype_withopts" && e.target === "src_bhelper_bhelp");
	assert.ok(call, "call inside a function with an inline object type in its header lost its owner");
});

test("generic classes keep their declarations and methods", () => {
	write("src/genstack.ts", [
		"export class UndoStack<S> {",
		"\tpush(state: S): void {}",
		"}",
		"export class TrimmedStack<S> extends UndoStack<S> {}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	assert.ok(g.nodes.some((n) => n.id === "src_genstack_undostack"), "generic class node missing");
	assert.ok(g.nodes.some((n) => n.id === "src_genstack_undostack_push"), "generic class method missing");
	assert.ok(g.edges.some((e) => e.relation === "inherits" && e.source === "src_genstack_trimmedstack" && e.target === "src_genstack_undostack"), "extends after class type parameters lost");
});

test("implements captures the full interface name", () => {
	write("src/impliface.ts", [
		"export interface StorageBackend {",
		"\tsave(): void;",
		"}",
		"export class DiskBackend implements StorageBackend {",
		"\tsave(): void {}",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const impl = g.edges.find((e) => e.relation === "implements" && e.source === "src_impliface_diskbackend");
	assert.ok(impl, "implements edge missing");
	assert.equal(impl.target, "src_impliface_storagebackend", "implements bound to a truncated interface name");
});

test("default type imports are recorded as dependencies", () => {
	write("src/typedefimp.ts", [
		'import type OpenAI from "openai";',
		"export type Client = OpenAI;",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const dep = g.edges.find((e) => e.source === "src_typedefimp" && e.relation === "imports_from" && e.target === "openai");
	assert.ok(dep, `import type X from "pkg" dropped: ${JSON.stringify(g.edges.filter((e) => e.source === "src_typedefimp"))}`);
});

test("nested namespace calls are both recorded", () => {
	write("src/nestmod.ts", [
		"export function nestOuter(x: number) { return x; }",
		"export function nestInner() { return 1; }",
	].join("\n"));
	write("src/nestuse.ts", [
		'import * as nn from "./nestmod.js";',
		"export function useNested() { return nn.nestOuter(nn.nestInner()); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const outer = g.edges.find((e) => e.relation === "calls" && e.source === "src_nestuse_usenested" && e.target === "src_nestmod_nestouter");
	const inner = g.edges.find((e) => e.relation === "calls" && e.source === "src_nestuse_usenested" && e.target === "src_nestmod_nestinner");
	assert.ok(outer, "outer namespace call missing");
	assert.ok(inner, "inner (nested) namespace call missing — consumed delimiter");
});

test("property chains do not bind as namespace calls", () => {
	write("src/chmod.ts", "export function chfn() { return 1; }\n");
	write("src/chuse.ts", [
		'import * as chns from "./chmod.js";',
		"const other = { chns: { chfn: () => 0 } };",
		"export function useChain() { return other.chns.chfn(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const bogus = g.edges.find((e) => e.relation === "calls" && e.source === "src_chuse_usechain" && e.target === "src_chmod_chfn");
	assert.ok(!bogus, `property-chain member call wrongly bound to the namespace import: ${JSON.stringify(bogus)}`);
});

test("kg query prints edges in stored direction, never traversal direction", () => {
	// Self-contained: (re)create the namespace fixture so this test also passes
	// under --test-name-pattern without the namespace-member test running first.
	write("src/nsmod.ts", "export function nsfn() { return 1; }\n");
	write("src/nsuse.ts", [
		'import * as nsm from "./nsmod.js";',
		"export function useNs() { return nsm.nsfn(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const out = run(["query", "nsfn"]);
	assert.match(out, /EDGE useNs\(\) --calls \[EXTRACTED[^\]]*\]--> nsfn\(\)/, `stored direction lost:\n${out}`);
	assert.doesNotMatch(out, /EDGE nsfn\(\) --calls/, `reversed call edge printed:\n${out}`);
});

test("kg report from a loaded graph still lists community members", () => {
	run(["report"]);
	const md = fs.readFileSync(path.join(root, ".planning/codebase/KG_REPORT.md"), "utf-8");
	assert.match(md, /Members: /, "community member samples lost after load (writeGraph strips members)");
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

test("object types in a declaration header do not end it early (greptile P1)", () => {
	write("src/hdrhelper.ts", "export function hdrhelp() { return true; }\n");
	write("src/hdrsig.ts", [
		'import { hdrhelp } from "./hdrhelper.js";',
		"export function createOps(options?: { shellPath?: string }): { ok: boolean } {",
		"\treturn { ok: hdrhelp() };",
		"}",
		"export function pickTyped<T extends { id: string }>(item: T): Promise<{ id: string }> {",
		"\treturn Promise.resolve({ id: String(hdrhelp()) });",
		"}",
	].join("\n"));
	write("gosrc/hdr.go", [
		"package main",
		"",
		"func goHelp() int { return 1 }",
		"",
		"func Run(x interface{}) map[string]struct{} {",
		"\tgoHelp()",
		"\treturn nil",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const sources = (target) => g.edges.filter((e) => e.relation === "calls" && e.target === target).map((e) => e.source);
	assert.ok(sources("src_hdrhelper_hdrhelp").includes("src_hdrsig_createops"), `parameter object type ended createOps early: ${JSON.stringify(sources("src_hdrhelper_hdrhelp"))}`);
	assert.ok(sources("src_hdrhelper_hdrhelp").includes("src_hdrsig_picktyped"), `generic constraint or return type ended pickTyped early: ${JSON.stringify(sources("src_hdrhelper_hdrhelp"))}`);
	assert.ok(sources("gosrc_hdr_gohelp").includes("gosrc_hdr_run"), `interface{} parameter ended Run early: ${JSON.stringify(sources("gosrc_hdr_gohelp"))}`);
});

test("body-less signatures end at their semicolon", () => {
	write("src/shapehelper.ts", "export function shapeHelp() { return 1; }\n");
	write("src/shape.ts", [
		'import { shapeHelp } from "./shapehelper.js";',
		"export abstract class Shape {",
		"\tabstract area(): number;",
		"}",
		"shapeHelp();",
		"export function laterFn() {",
		"\treturn 1;",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const call = g.edges.find((e) => e.relation === "calls" && e.target === "src_shapehelper_shapehelp");
	assert.ok(call, "top-level call missing");
	assert.equal(call.source, "src_shape", `top-level call attributed to ${call.source}: an abstract method stayed open past its semicolon`);
});

test("commented-out import examples are not dependencies (greptile P1)", () => {
	write("src/cmhelper.ts", "export function cmhelp() { return 1; }\n");
	write("src/cmlogger.ts", [
		"/**",
		" * Usage:",
		" *   import { cmlog } from './cmlogger'",
		" */",
		'// import { cmhelp } from "./cmhelper.js";',
		'// const lazy = require("./cmhelper.js");',
		"export function cmlog() { return 1; }",
	].join("\n"));
	write("src/cmreal.ts", [
		'import { cmhelp } from "./cmhelper.js"; // a real import with a trailing comment',
		"export const cmurl = \"https://example.com/a//b\";",
		"export function cmuse() { return cmhelp(); }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const deps = (src) => g.edges.filter((e) => e.source === src && e.relation === "imports_from").map((e) => e.target);
	assert.deepEqual(deps("src_cmlogger"), [], `commented-out imports became dependencies: ${JSON.stringify(deps("src_cmlogger"))}`);
	assert.ok(deps("src_cmreal").includes("src_cmhelper"), `real import lost: ${JSON.stringify(deps("src_cmreal"))}`);
});

test("implements lists keep full interface names (greptile P1)", () => {
	write("src/ifaces.ts", [
		"export interface StorageBackend { get(k: string): string; }",
		"export interface Closeable { close(): void; }",
		"export class BaseCache<T> { items: T[] = []; }",
	].join("\n"));
	write("src/impls.ts", [
		'import { StorageBackend, Closeable, BaseCache } from "./ifaces.js";',
		"export class DiskStore implements StorageBackend, Closeable {",
		"\tget(k: string): string { return k; }",
		"\tclose(): void {}",
		"}",
		"export class TypedCache extends BaseCache<string> implements StorageBackend {",
		"\tget(k: string): string { return k; }",
		"}",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const impl = (src) => g.edges.filter((e) => e.relation === "implements" && e.source === src).map((e) => e.target).sort();
	assert.deepEqual(impl("src_impls_diskstore"), ["src_ifaces_closeable", "src_ifaces_storagebackend"]);
	assert.deepEqual(impl("src_impls_typedcache"), ["src_ifaces_storagebackend"], "implements after a generic extends clause lost");
	assert.ok(g.edges.some((e) => e.relation === "inherits" && e.source === "src_impls_typedcache" && e.target === "src_ifaces_basecache"), "generic extends clause lost");
});

test("statement-level type imports are dependencies (greptile P2)", () => {
	write("src/typemod.ts", "export interface TypedThing { id: string }\nexport default interface DefaultThing { id: string }\n");
	write("src/typeuse.ts", [
		'import type OpenAI from "openai";',
		'import type { TypedThing } from "./typemod.js";',
		"export function typeUse(a: OpenAI, b: TypedThing) { return [a, b]; }",
	].join("\n"));
	run(["build", "--quiet"]);
	const g = loadGraph();
	const deps = (src) => g.edges.filter((e) => e.source === src && e.relation === "imports_from").map((e) => e.target).sort();
	assert.deepEqual(deps("src_typeuse"), ["openai", "src_typemod"]);
	const imps = parseDecls("src/t.ts", [
		'import type OpenAI from "openai";',
		'import type { TypedThing } from "./typemod.js";',
		'import type from "./type.js";',
	].join("\n"), "typescript").imports.map((i) => ({ spec: i.spec, default: i.default, names: i.names.map((n) => n.local) }));
	assert.deepEqual(imps, [
		{ spec: "openai", default: "OpenAI", names: [] },
		{ spec: "./typemod.js", default: null, names: ["TypedThing"] },
		// `import type from "./x"` is a default import NAMED `type`, not a type import.
		{ spec: "./type.js", default: "type", names: [] },
	]);
});

test("wiki god-node pages are keyed by node id, not label (greptile P2)", () => {
	const wikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draht-kg-wiki-test-"));
	try {
		fs.mkdirSync(path.join(wikiRoot, ".git"));
		fs.writeFileSync(path.join(wikiRoot, "package.json"), JSON.stringify({ name: "wiki", version: "1.0.0" }));
		for (const dir of ["alpha", "beta"]) {
			fs.mkdirSync(path.join(wikiRoot, dir), { recursive: true });
			fs.writeFileSync(path.join(wikiRoot, dir, "store.ts"), [
				"export class Store {",
				"\tsave(): void {}",
				"\tload(): void {}",
				"\tclear(): void {}",
				"}",
			].join("\n"));
		}
		const kg = (args) => execFileSync(process.execPath, [CLI, "kg", ...args], { cwd: wikiRoot, encoding: "utf-8" });
		kg(["build", "--quiet"]);
		kg(["export", "wiki"]);
		const dir = path.join(wikiRoot, ".planning/codebase/kg-wiki");
		const links = [...fs.readFileSync(path.join(dir, "index.md"), "utf-8").matchAll(/^- \[Store\]\(([^)]+)\) — degree/gm)].map((m) => m[1]);
		assert.equal(links.length, 2, `expected both Store god nodes in the index: ${JSON.stringify(links)}`);
		assert.notEqual(links[0], links[1], "two Store nodes link to the same page");
		const pages = links.map((l) => fs.readFileSync(path.join(dir, l), "utf-8"));
		assert.ok(pages.some((p) => p.includes("alpha/store.ts")) && pages.some((p) => p.includes("beta/store.ts")), "one Store page overwrote the other");
	} finally {
		fs.rmSync(wikiRoot, { recursive: true, force: true });
	}
});

test("workspace subpath imports resolve through the package's exports, not its root (greptile P1)", () => {
	const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draht-kg-ws-test-"));
	try {
		const w = (rel, content) => {
			fs.mkdirSync(path.dirname(path.join(wsRoot, rel)), { recursive: true });
			fs.writeFileSync(path.join(wsRoot, rel), content);
		};
		fs.mkdirSync(path.join(wsRoot, ".git"));
		w("package.json", JSON.stringify({ name: "ws", version: "1.0.0" }));
		// A `source` condition, a dist-only exact key (built from src/) and a dist-only `*` pattern.
		w("packages/mod/package.json", JSON.stringify({
			name: "@ws/mod",
			exports: {
				".": { source: "./src/index.ts", import: "./dist/index.js" },
				"./testing": { source: "./src/testing/index.ts", import: "./dist/testing/index.js" },
				"./compat": { types: "./dist/compat.d.ts", import: "./dist/compat.js" },
				"./providers/*": { types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" },
			},
		}));
		w("packages/mod/src/index.ts", "export function rootOnly() { return 1; }\n");
		w("packages/mod/src/testing/index.ts", "export function makePair() { return 2; }\n");
		w("packages/mod/src/compat.ts", "export function compatShim() { return 3; }\n");
		w("packages/mod/src/providers/faux.ts", "export function fauxProvider() { return 4; }\n");
		// No `exports` field: a subpath is a path inside the package.
		w("packages/plain/package.json", JSON.stringify({ name: "@ws/plain", main: "./src/index.ts" }));
		w("packages/plain/src/index.ts", "export function plainRoot() { return 5; }\n");
		w("packages/plain/lib/extra.ts", "export function plainExtra() { return 6; }\n");
		w("packages/app/src/use.ts", [
			'import { makePair } from "@ws/mod/testing";',
			'import { compatShim } from "@ws/mod/compat";',
			'import { fauxProvider } from "@ws/mod/providers/faux";',
			'import { plainExtra } from "@ws/plain/lib/extra.js";',
			'import { hidden } from "@ws/mod/internal";',
			"export function useAll() { return [makePair(), compatShim(), fauxProvider(), plainExtra(), hidden()]; }",
		].join("\n"));
		execFileSync(process.execPath, [CLI, "kg", "build", "--quiet"], { cwd: wsRoot, encoding: "utf-8" });
		const g = JSON.parse(fs.readFileSync(path.join(wsRoot, ".planning/codebase/graph.json"), "utf-8"));
		const deps = g.edges.filter((e) => e.source === "packages_app_src_use" && e.relation === "imports_from").map((e) => e.target).sort();
		assert.deepEqual(deps, [
			"packages_mod_src_compat",
			"packages_mod_src_providers_faux",
			"packages_mod_src_testing_index",
			"packages_plain_lib_extra",
			// Not in the exports map: Node refuses it, so it is no in-repo file, least of all the root.
			"ws_mod_internal",
		]);
		const calls = g.edges.filter((e) => e.source === "packages_app_src_use_useall" && e.relation === "calls").map((e) => e.target).sort();
		assert.deepEqual(calls, [
			"packages_mod_src_compat_compatshim",
			"packages_mod_src_providers_faux_fauxprovider",
			"packages_mod_src_testing_index_makepair",
			"packages_plain_lib_extra_plainextra",
		]);
	} finally {
		fs.rmSync(wsRoot, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Review-fix regressions. Each case builds a throwaway repo in-process.
// ---------------------------------------------------------------------------

function graphOf(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-kg-case-"));
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		for (const [rel, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), content);
		}
		return buildGraph(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
const edgesFrom = (g, source, relation) => g.edges.filter((e) => e.source === source && (!relation || e.relation === relation));
const targetsOf = (g, source, relation) => edgesFrom(g, source, relation).map((e) => e.target).sort();
const hasNode = (g, id) => g.nodes.some((n) => n.id === id);

test("one lexer pass: a string, regex or template cannot swallow code across lines (item 1)", () => {
	const g = graphOf({
		"src/helper.ts": "export function helperA() { return 1; }\n",
		"src/main.ts": [
			'import { helperA } from "./helper.js";',
			"export function globs(files: string[]) {",
			// "/*" inside a string used to open a comment that ran to the next "*/".
			'\treturn files.filter((f) => f.startsWith("src/*"));',
			"}",
			"export function afterGlob() { return helperA(); }",
			"/* a real comment */",
			// A lone backtick inside a string used to open a template literal.
			"export function quote(s: string) {",
			'\treturn "\x60" + s;',
			"}",
			"export function afterTick() { return helperA(); }",
			// Backtick and star inside a regex literal.
			"export function escapes(s: string) {",
			"\treturn s.replace(/[\x60*_]/g, \"\");",
			"}",
			"export function afterRegex() { return helperA(); }",
			// Calls inside ${ } survive, nested templates included.
			"export function nested(x: string) {",
			"\treturn \x60[${x}] ${wrap(\x60<${helperA()}>\x60)}\x60;",
			"}",
			"export function wrap(s: string) { return s; }",
		].join("\n"),
	});
	for (const fn of ["globs", "afterGlob", "quote", "afterTick", "escapes", "afterRegex", "nested", "wrap"]) {
		assert.ok(hasNode(g, "src_main_" + fn.toLowerCase()), `${fn}() missing from the graph`);
	}
	for (const fn of ["afterglob", "aftertick", "afterregex", "nested"]) {
		assert.deepEqual(targetsOf(g, "src_main_" + fn, "calls").filter((t) => t === "src_helper_helpera"), ["src_helper_helpera"], `${fn} lost its call`);
	}
	assert.ok(targetsOf(g, "src_main_nested", "calls").includes("src_main_wrap"), "call inside a template expression lost");
	// Same length, same line breaks: offsets and line numbers survive masking.
	const src = 'a = "x\\"/*"; /* y */ b = \x60q${c}\x60;\nd();';
	const masked = maskSource(src, "typescript");
	assert.equal(masked.length, src.length);
	assert.equal(masked.replace(/[^\n]/g, ""), src.replace(/[^\n]/g, ""));
});

test("Python masking: # comments and triple-quoted strings (item 1)", () => {
	const masked = maskSource('x = """a\n"""  # note\ndef f():\n    return 1', "python");
	assert.equal(masked, 'x = """ \n"""        \ndef f():\n    return 1');
});

test("workspace root import comes from exports['.'] only and maps dist back to src (item 2)", () => {
	const g = graphOf({
		"package.json": JSON.stringify({ name: "ws", private: true }),
		// The root is dist-only; `./extension` points into src. The root must not borrow it.
		"packages/knowledge/package.json": JSON.stringify({
			name: "@ws/knowledge",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./extension": { import: "./src/extension.ts" } },
		}),
		"packages/knowledge/src/index.ts": "export function knowRoot() { return 1; }\n",
		"packages/knowledge/src/extension.ts": "export function knowExt() { return 2; }\n",
		// `main` names build output only.
		"packages/cli/package.json": JSON.stringify({ name: "@ws/cli", main: "./dist/main.js", types: "./dist/main.d.ts" }),
		"packages/cli/src/main.ts": "export function cliRun() { return 3; }\n",
		"packages/app/src/use.ts": [
			'import { knowRoot } from "@ws/knowledge";',
			'import { knowExt } from "@ws/knowledge/extension";',
			'import { cliRun } from "@ws/cli";',
			"export function useAll() { return [knowRoot(), knowExt(), cliRun()]; }",
		].join("\n"),
	});
	assert.deepEqual(targetsOf(g, "packages_app_src_use", "imports_from"), [
		"packages_cli_src_main",
		"packages_knowledge_src_extension",
		"packages_knowledge_src_index",
	]);
	assert.deepEqual(targetsOf(g, "packages_app_src_use_useall", "calls"), [
		"packages_cli_src_main_clirun",
		"packages_knowledge_src_extension_knowext",
		"packages_knowledge_src_index_knowroot",
	]);
});

test("declarations inside a template literal are not symbols (item 3)", () => {
	const g = graphOf({
		"src/real.ts": "export function render() { return 1; }\n",
		"src/gen.ts": [
			'import { render } from "./real.js";',
			"const TEMPLATE = \x60",
			"export function render() {",
			"\treturn 0;",
			"}",
			"\x60;",
			"export function build() {",
			"\treturn render() + TEMPLATE;",
			"}",
		].join("\n"),
	});
	assert.ok(!hasNode(g, "src_gen_render"), "phantom node from template text");
	assert.deepEqual(targetsOf(g, "src_gen_build", "calls"), ["src_real_render"]);
});

test("a declaration's own name and type-only signatures are not calls (item 4)", () => {
	const g = graphOf({
		"src/config.ts": "export function load() { return {}; }\nexport function save() { return 1; }\n",
		"src/store.ts": [
			'import { load, save } from "./config.js";',
			"export interface Persist {",
			"\tsave(): number;",
			"}",
			"export type Loader = {",
			"\tload(): object;",
			"};",
			"export class Store {",
			"\tload(): object {",
			"\t\treturn {};",
			"\t}",
			"\tflush() { return save(); }",
			"}",
		].join("\n"),
	});
	const toConfig = g.edges.filter((e) => e.relation === "calls" && e.target.startsWith("src_config_"));
	assert.deepEqual(toConfig.map((e) => e.source + " -> " + e.target), ["src_store_store_flush -> src_config_save"], "header or signature lines became calls");
});

test("Python relative and package imports resolve; external ids do not merge with repo files (item 5)", () => {
	const g = graphOf({
		"models.py": "class Model:\n    pass\n",
		"shop/models.py": "class Order:\n    pass\n",
		"shop/views.py": "from .models import Order\n\nclass View:\n    def get(self):\n        return Order()\n",
		"shop/sub/deep.py": "from ..models import Order\n\ndef make():\n    return Order()\n",
		"main.py": "from mypkg import helper\n\ndef run():\n    return helper()\n",
		"mypkg/__init__.py": "def helper():\n    return 1\n",
		"other.py": "def helper():\n    return 2\n",
		"lonely/x.py": "from .models import Z\n",
	});
	assert.deepEqual(targetsOf(g, "shop_views", "imports_from"), ["shop_models"], "`.models` must be the sibling module");
	assert.deepEqual(targetsOf(g, "shop_sub_deep", "imports_from"), ["shop_models"], "`..models` must be the parent package's module");
	assert.deepEqual(targetsOf(g, "main", "imports_from"), ["mypkg_init"], "`from mypkg import` must find mypkg/__init__.py");
	assert.deepEqual(targetsOf(g, "main_run", "calls"), ["mypkg_init_helper"]);
	assert.deepEqual(targetsOf(g, "shop_views_view_get", "instantiates"), ["shop_models_order"]);
	const unresolved = targetsOf(g, "lonely_x", "imports_from");
	assert.equal(unresolved.length, 1);
	assert.notEqual(unresolved[0], "models", "external module merged with the repo's models.py");
	assert.equal(g.nodes.find((n) => n.id === "models").source_file, "models.py");
});

test("Python scopes follow indentation: self.x(), triple-quoted strings, __main__ (item 6)", () => {
	const g = graphOf({
		"app/util.py": "def normalize(x):\n    return x\n",
		"app/views.py": [
			"from .util import normalize",
			"",
			"class Alpha:",
			"    def save(self):",
			"        pass",
			"",
			"class Beta:",
			"    def run(self):",
			'        q = """',
			"SELECT * FROM t",
			'"""',
			"        self.save()",
			"        return normalize(q)",
			"",
			"    def after_sql(self):",
			"        return 1",
			"",
			"def main():",
			"    return Beta().run()",
			"",
			'if __name__ == "__main__":',
			"    main()",
		].join("\n"),
	});
	assert.deepEqual(targetsOf(g, "app_views_beta_run", "calls"), ["app_util_normalize"], "self.save() bound to an unrelated earlier class");
	assert.ok(hasNode(g, "app_views_beta_after_sql"), "method after a column-0 line in a triple-quoted string was dropped");
	assert.deepEqual(targetsOf(g, "app_views", "calls"), ["app_views_main"], "module-level main() must belong to the file");
});

test("names imported from an external module never bind to a same-named repo symbol (item 7)", () => {
	const g = graphOf({
		"lib/session.py": "class Session:\n    pass\n",
		"ext.py": "from requests import Session\n\ndef go():\n    return Session()\n",
		"own.py": "from lib.session import Session\n\ndef go():\n    return Session()\n",
		// A package the repo defines but the root-relative resolver misses (src
		// layout) is not external: the heuristic binding stays.
		"src/mypkg/engine.py": "class Engine:\n    pass\n",
		"src/mypkg/run.py": "from mypkg.engine import Engine\n\ndef go():\n    return Engine()\n",
	});
	assert.deepEqual(targetsOf(g, "ext_go", "instantiates"), [], "bound to lib.session.Session");
	assert.deepEqual(targetsOf(g, "own_go", "instantiates"), ["lib_session_session"], "in-repo import must still bind");
	assert.deepEqual(targetsOf(g, "src_mypkg_run_go", "instantiates"), ["src_mypkg_engine_engine"], "src-layout import lost its heuristic binding");
});

test("barrels with cyclic star exports resolve every name once (item 8a)", () => {
	const g = graphOf({
		"src/a.ts": 'export * from "./b.js";\nexport function fa() { return 1; }\n',
		"src/b.ts": 'export * from "./a.js";\nexport function fb() { return 2; }\n',
		"src/c.ts": 'export * from "./b.js";\nexport * from "./d.js";\n',
		"src/d.ts": 'export * from "./c.js";\nexport function fd() { return 3; }\n',
		"src/use.ts": [
			'import { fa, fb } from "./a.js";',
			'import { fd, fb as other } from "./c.js";',
			"export function useAll() { return [fa(), fb(), fd(), other()]; }",
		].join("\n"),
	});
	assert.deepEqual(targetsOf(g, "src_use_useall", "calls"), ["src_a_fa", "src_b_fb", "src_d_fd"]);
});

test("a 1500-module star barrel builds in bounded time (item 8a)", () => {
	const N = 1500;
	const files = {};
	const barrel = [];
	for (let i = 0; i < N; i++) {
		files[`src/lib/l${i}.ts`] = `export function a${i}() {}\nexport function b${i}() {}\n`;
		barrel.push(`export * from "./l${i}.js";`);
	}
	files["src/lib/index.ts"] = barrel.join("\n");
	for (let i = 0; i < N; i++) {
		const [x, y, z] = [i, (i + 131) % N, (i + 262) % N];
		files[`src/app/c${i}.ts`] = `import { a${x}, a${y}, a${z} } from "../lib/index.js";\nexport function run${i}() { return [a${x}(), a${y}(), a${z}()]; }\n`;
	}
	const t0 = Date.now();
	const g = graphOf(files);
	const ms = Date.now() - t0;
	assert.deepEqual(targetsOf(g, "src_app_c5_run5", "calls"), ["src_lib_l136_a136", "src_lib_l267_a267", "src_lib_l5_a5"]);
	// ~0.2s with per-module export maps; ~8s when every importer rescanned the barrel.
	assert.ok(ms < 3000, `barrel resolution took ${ms}ms (was per-importer O(barrel size))`);
});

// Reference: importCycles as it was before the SCC pre-pass.
function referenceCycles(graph, maxLen = 5) {
	const adj = new Map();
	for (const e of graph.edges) {
		if (e.relation !== "imports_from" && e.relation !== "re_exports") continue;
		if (e._deferred) continue;
		if (!adj.has(e.source)) adj.set(e.source, []);
		adj.get(e.source).push(e.target);
	}
	const cycles = [];
	const seen = new Set();
	for (const start of [...adj.keys()].sort()) {
		const stack = [[start, [start]]];
		while (stack.length && cycles.length < 20) {
			const [cur, pathArr] = stack.pop();
			for (const nb of adj.get(cur) || []) {
				if (nb === start && pathArr.length > 1) {
					const minIdx = pathArr.indexOf([...pathArr].sort()[0]);
					const canon = pathArr.slice(minIdx).concat(pathArr.slice(0, minIdx)).join("→");
					if (!seen.has(canon)) { seen.add(canon); cycles.push([...pathArr, start]); }
				} else if (!pathArr.includes(nb) && pathArr.length < maxLen) {
					stack.push([nb, [...pathArr, nb]]);
				}
			}
		}
	}
	return cycles.slice(0, 10);
}

test("import cycles: same cycles in the same order as the exhaustive search (item 8b)", () => {
	let seed = 12345;
	const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	let withCycles = 0;
	for (let round = 0; round < 60; round++) {
		const n = 8 + Math.floor(rand() * 40);
		const p = 0.03 + rand() * 0.12;
		const edges = [];
		for (let a = 0; a < n; a++) {
			for (let b = 0; b < n; b++) {
				if (rand() >= p) continue;
				const roll = rand();
				edges.push({ source: "f" + a, target: "f" + b, relation: roll < 0.1 ? "re_exports" : "imports_from", _deferred: roll > 0.92 ? true : undefined });
			}
		}
		const expected = referenceCycles({ edges });
		if (expected.length) withCycles++;
		assert.deepEqual(importCycles({ edges }), expected, `round ${round}`);
	}
	assert.ok(withCycles > 10, "random graphs should exercise real cycles");
});

test("import cycles: an acyclic 6000-module graph is not path-searched (item 8b)", () => {
	const edges = [];
	for (let i = 0; i < 6000; i++) for (let k = 1; k <= 6; k++) if (i + k < 6000) edges.push({ source: "n" + i, target: "n" + (i + k), relation: "imports_from" });
	const t0 = Date.now();
	assert.deepEqual(importCycles({ edges }), []);
	const ms = Date.now() - t0;
	assert.ok(ms < 500, `acyclic graph took ${ms}ms`);
});

test("import line numbers come from precomputed line starts (item 8c)", () => {
	const lines = [];
	for (let i = 0; i < 20000; i++) lines.push(`import { v${i} } from "./m${i}.js";`);
	const t0 = Date.now();
	const d = parseDecls("src/a.ts", lines.join("\n"), "typescript");
	const ms = Date.now() - t0;
	assert.equal(d.imports.length, 20000);
	assert.deepEqual([d.imports[0].line, d.imports[1234].line, d.imports[19999].line], [1, 1235, 20000]);
	assert.ok(ms < 2000, `20000 imports took ${ms}ms (line lookup rescanned the file per import)`);
	const py = parseDecls("a.py", "import os\n\nfrom x import y\n", "python");
	assert.deepEqual(py.imports.map((i) => i.line), [1, 3]);
});

test("re-export forms: default-as and namespace re-exports (item 9)", () => {
	const g = graphOf({
		"src/Button.ts": "export default function Button() { return 1; }\n",
		"src/utils.ts": "export function inner() { return 2; }\n",
		"src/index.ts": 'export { default as Button } from "./Button.js";\nexport * as utils from "./utils.js";\n',
		"src/app.ts": [
			'import { Button, inner } from "./index.js";',
			"export function app() { return [Button(), inner()]; }",
		].join("\n"),
	});
	assert.deepEqual(targetsOf(g, "src_app", "imports"), ["src_button_button"], "Button lost, or inner leaked out of `export * as utils`");
	assert.deepEqual(targetsOf(g, "src_app_app", "calls"), ["src_button_button"]);
	assert.deepEqual(targetsOf(g, "src_index", "re_exports"), ["src_button", "src_utils"], "both re-exports remain file dependencies");
});

test("import text inside strings and templates is not a dependency (item 10)", () => {
	const g = graphOf({
		"src/heavy.ts": "export function heavy() { return 1; }\n",
		"src/real.ts": "export function real() { return 2; }\n",
		"src/gen.test.ts": [
			'import { real } from "./real.js";',
			"const FIXTURE = \x60",
			'import { heavy } from "./heavy.js";',
			"heavy();",
			'export * from "./heavy.js";',
			"\x60;",
			"const SNIPPET = \"const m = require('./heavy.js');\";",
			'const LAZY = "import(\\"./heavy.js\\")";',
			"export function check() { return real() + FIXTURE + SNIPPET + LAZY; }",
		].join("\n"),
	});
	// Only the real import (its specifier is read from the original text) survives.
	const deps = edgesFrom(g, "src_gen_test").filter((e) => /import|re_exports/.test(e.relation)).map((e) => e.relation + " " + e.target).sort();
	assert.deepEqual(deps, ["imports src_real_real", "imports_from src_real"]);
});

test("indirect calls keep every argument, not every other one (item 11)", () => {
	const g = graphOf({
		"src/wire.ts": [
			"export function register(alpha: () => void, beta: () => void, gamma: () => void) {}",
			"export function a1() {}",
			"export function a2() {}",
			"export function a3() {}",
			"export function wire() {",
			"\tregister(a1, a2, a3);",
			"}",
		].join("\n"),
		"src/names.ts": 'import { a1, a2, a3 } from "./wire.js";\nexport const all = 1;\n',
	});
	assert.deepEqual(targetsOf(g, "src_wire_wire", "indirect_call"), ["src_wire_a1", "src_wire_a2", "src_wire_a3"]);
	assert.deepEqual(targetsOf(g, "src_names", "indirect_call"), [], "an import list is not a call site");
});

test("kg flags that need a value reject a missing one with usage and a non-zero exit (item 12)", () => {
	for (const args of [["export", "tree", "--output"], ["export", "graphml", "--output", "--quiet"], ["query", "x", "--depth"]]) {
		let failure = null;
		try {
			execFileSync(process.execPath, [CLI, "kg", ...args], { cwd: root, encoding: "utf-8", stdio: "pipe" });
		} catch (err) {
			failure = err;
		}
		assert.ok(failure, `${args.join(" ")} should fail`);
		assert.equal(failure.status, 1);
		assert.match(failure.stderr, /requires a value/);
		assert.doesNotMatch(failure.stderr, /TypeError/);
		assert.match(failure.stdout, /Usage: draht-tools kg/);
	}
	// A real value still works.
	const out = path.join(root, "tree-out.html");
	run(["export", "tree", "--output", out]);
	assert.ok(fs.existsSync(out));
});

test("Go: a method above its type belongs to it; the type's region closes (item 13)", () => {
	const g = graphOf({
		"srv/server.go": [
			"package srv",
			"",
			"func (s *Server) Start() error {",
			"\treturn nil",
			"}",
			"",
			"type Server struct {",
			"\taddr string",
			"}",
			"",
			"var defaultServer = newServer()",
			"",
			"func newServer() *Server { return &Server{} }",
		].join("\n"),
	});
	assert.ok(hasNode(g, "srv_server_server_start"), "Start() must be a method of Server");
	assert.ok(!hasNode(g, "srv_server_start"), "Start() became a file-level function");
	assert.deepEqual(targetsOf(g, "srv_server", "calls"), ["srv_server_newserver"], "package-level call attributed to the Server type");
});

test("files are ordered by their '/'-normalized path on every OS (item 14)", () => {
	// On Windows the separator is a backslash, which sorts after digits and
	// capitals; the normalized order must match POSIX.
	const win = ["src\\a0.ts", "src\\a\\b.ts", "src\\a-z.ts"];
	assert.deepEqual(sortByPosixPath(win, "\\"), ["src\\a-z.ts", "src\\a\\b.ts", "src\\a0.ts"]);
	assert.deepEqual(sortByPosixPath(["src/a0.ts", "src/a/b.ts"], "/"), ["src/a/b.ts", "src/a0.ts"]);
});

// ---------------------------------------------------------------------------
// Method coverage: measured against the TypeScript compiler, the engine found
// 83% of class methods and no constructors.
// ---------------------------------------------------------------------------

test("a class keeps every method, however many it declares", () => {
	const N = 150;
	const body = [];
	for (let i = 0; i < N; i++) body.push(`\tm${i}(): number { return ${i + 1 < N ? `this.m${i + 1}()` : "0"}; }`);
	const g = graphOf({ "src/big.ts": ["export class Big {", ...body, "}"].join("\n") });
	const methods = targetsOf(g, "src_big_big", "method");
	assert.equal(methods.length, N, `only ${methods.length} of ${N} methods were indexed`);
	assert.deepEqual(targetsOf(g, "src_big_big_m148", "calls"), ["src_big_big_m149"], "a call between late methods was lost");
	assert.deepEqual(targetsOf(g, "src_big_big", "calls"), [], "calls of unindexed methods fell back to the class");
});

test("a class past the method limit is named in the build output", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-kg-limit-"));
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.mkdirSync(path.join(dir, "src"));
		const body = [];
		for (let i = 0; i < 1003; i++) body.push(`\tm${i}(): void {}`);
		fs.writeFileSync(path.join(dir, "src/huge.ts"), ["export class Huge {", ...body, "}"].join("\n"));
		const out = execFileSync(process.execPath, [CLI, "kg", "build"], { cwd: dir, encoding: "utf-8" });
		assert.match(out, /warning: 1 class\(es\) declare more than 1000 methods/, out);
		assert.match(out, /src\/huge\.ts: Huge \(1003 methods\)/, out);
		const g = JSON.parse(fs.readFileSync(path.join(dir, ".planning/codebase/graph.json"), "utf-8"));
		assert.equal(g.edges.filter((e) => e.relation === "method" && e.source === "src_huge_huge").length, 1000);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("#private methods are nodes and this.#x() binds to them", () => {
	const g = graphOf({
		"src/util.ts": "export function snapshot() { return 1; }\n",
		"src/parser.ts": [
			'import { snapshot } from "./util.js";',
			"export class Parser {",
			"\t#time(message: string): void { snapshot(); }",
			"\trun(): void { this.#time(\"x\"); }",
			"\t#snapshot(): number {",
			"\t\treturn 1;",
			"\t}",
			"\tread(): number { return this.#snapshot(); }",
			"\tstatic #make(): Parser { return new Parser(); }",
			"}",
		].join("\n"),
	});
	const node = g.nodes.find((n) => n.id === "src_parser_parser_time");
	assert.ok(node, "#time() has no node");
	assert.equal(node.label, "#time()");
	assert.deepEqual(targetsOf(g, "src_parser_parser", "method"), ["src_parser_parser_make", "src_parser_parser_read", "src_parser_parser_run", "src_parser_parser_snapshot", "src_parser_parser_time"]);
	assert.deepEqual(targetsOf(g, "src_parser_parser_run", "calls"), ["src_parser_parser_time"]);
	// The private method, not the imported function of the same name.
	assert.deepEqual(targetsOf(g, "src_parser_parser_read", "calls"), ["src_parser_parser_snapshot"]);
	// A real bare call inside a private method still binds to the import…
	assert.deepEqual(targetsOf(g, "src_parser_parser_time", "calls"), ["src_util_snapshot"]);
	// …and the `#snapshot(): number {` header is not a call to it.
	assert.deepEqual(targetsOf(g, "src_parser_parser_snapshot", "calls"), []);
	assert.deepEqual(targetsOf(g, "src_parser_parser", "calls"), []);
});

test("methods named like reserved words are methods; statements are not", () => {
	const g = graphOf({
		"src/registry.ts": [
			"export class Registry {",
			"\tdelete(id: string): boolean { return id.length > 0; }",
			"\tasync catch(onRejected: () => void): Promise<void> {}",
			"\treturn(value: number): number { return (value); }",
			"\tmatch(pattern: string): boolean { return this.delete(pattern); }",
			"\tselect(): void {}",
			"\tuse(): void {}",
			"\tclear(): void { this.delete(\"x\"); }",
			"}",
			"export abstract class Shape {",
			"\tabstract delete(id: string): void;",
			"}",
			// An ambient class: no bodies, no modifiers, a return type after the parameters.
			"export declare class Ambient {",
			"\tconstructor(name: string);",
			"\tdelete(id: string): boolean;",
			"\tget(id: string): string;",
			"}",
		].join("\n"),
		"src/lazy.ts": [
			"export class Lazy {",
			// Continuation lines of field initializers, at class-member depth.
			"\tload = () =>",
			'\t\timport("./registry.js");',
			"\tpick = (x: number) =>",
			"\t\tdelete (this.cache[x]);",
			"\thandler =",
			"\t\tfunction (x: number) { return x; };",
			"\tlater =",
			"\t\tasync (x: number) => { return x; };",
			"\tkind = (x: unknown) =>",
			"\t\ttypeof (x) === \"number\" ? 1 : 2;",
			"\tcache: Record<number, number> = {};",
			"\trun(): number {",
			"\t\tif (this.ok()) { return (1); }",
			"\t\tfor (const x of [1]) { void x; }",
			"\t\treturn (2);",
			"\t}",
			"\tok(): boolean { return true; }",
			"}",
		].join("\n"),
	});
	assert.deepEqual(targetsOf(g, "src_registry_registry", "method"), ["catch", "clear", "delete", "match", "return", "select", "use"].map((n) => "src_registry_registry_" + n));
	assert.deepEqual(targetsOf(g, "src_registry_registry_clear", "calls"), ["src_registry_registry_delete"]);
	assert.deepEqual(targetsOf(g, "src_registry_registry_match", "calls"), ["src_registry_registry_delete"]);
	assert.deepEqual(targetsOf(g, "src_registry_shape", "method"), ["src_registry_shape_delete"], "a modifier marks a body-less signature as a declaration");
	assert.deepEqual(targetsOf(g, "src_registry_ambient", "method"), ["constructor", "delete", "get"].map((n) => "src_registry_ambient_" + n), "a return type marks a body-less signature as a declaration");
	assert.deepEqual(targetsOf(g, "src_lazy_lazy", "method"), ["src_lazy_lazy_ok", "src_lazy_lazy_run"], "a statement or expression became a method");
});

test("constructors are nodes and own the calls in their body", () => {
	const g = graphOf({
		"src/base.ts": "export function helper(x: string) { return x; }\n",
		"src/service.ts": [
			'import { helper } from "./base.js";',
			"export class Service {",
			"\tprivate ready = false;",
			"\tconstructor(private readonly name: string) {",
			"\t\thelper(name);",
			"\t\tthis.init();",
			"\t}",
			"\tinit(): void { this.ready = true; }",
			"}",
			"export function make() { return new Service(\"x\"); }",
		].join("\n"),
	});
	const ctor = g.nodes.find((n) => n.id === "src_service_service_constructor");
	assert.ok(ctor, "constructor has no node");
	assert.equal(ctor.label, "constructor()");
	assert.equal(ctor.source_location, "L4");
	assert.ok(targetsOf(g, "src_service_service", "method").includes("src_service_service_constructor"), "constructor is not a method of its class");
	assert.deepEqual(targetsOf(g, "src_service_service_constructor", "calls"), ["src_base_helper", "src_service_service_init"]);
	assert.deepEqual(targetsOf(g, "src_service_service", "calls"), [], "constructor calls were attributed to the class");
	// `new Service()` still names the class, as graphify does.
	assert.deepEqual(targetsOf(g, "src_service_make", "instantiates"), ["src_service_service"]);
});

test("methods whose names share an id get graphify's suffixed ids, in any order", () => {
	// Ids below are what graphify 0.9.105 assigns to the same members.
	const cell = [
		"\tgetURL(): string { return \"\"; }",
		"\tgetUrl(): string { return \"\"; }",
		"\tget value(): number { return 1; }",
		"\tset value(v: number) {}",
		"\t#value(): number { return 2; }",
		"\t$set(k: string): void {}",
		"\tset(k: string): void {}",
		"\t_a(): void {}",
		"\t__a(): void {}",
		"\tread(): number { return this.#value() + this.value; }",
		"\twrite(): void { this.$set(\"k\"); this.set(\"k\"); }",
	];
	const expected = [
		"src_a_cell_a_33a2c0", "src_a_cell_a_8f1d68", "src_a_cell_geturl_395b77", "src_a_cell_geturl_ae679b",
		"src_a_cell_read", "src_a_cell_set", "src_a_cell_set_3c9713", "src_a_cell_value", "src_a_cell_value_75ab3a", "src_a_cell_write",
	];
	for (const body of [cell, [...cell].reverse()]) {
		const g = graphOf({
			"src/a.ts": ["export class Cell {", ...body, "}"].join("\n"),
			"src/b.py": "class Repo:\n    def load(self):\n        return self._load()\n\n    def _load(self):\n        return 1\n",
		});
		assert.deepEqual(targetsOf(g, "src_a_cell", "method"), expected);
		assert.equal(g.nodes.find((n) => n.id === "src_a_cell_value_75ab3a").label, "#value()");
		assert.equal(g.nodes.find((n) => n.id === "src_a_cell_value").label, "value()");
		assert.deepEqual(targetsOf(g, "src_a_cell_read", "calls"), ["src_a_cell_value_75ab3a"], "this.#value() bound to the public accessor");
		assert.deepEqual(targetsOf(g, "src_a_cell_write", "calls"), ["src_a_cell_set", "src_a_cell_set_3c9713"]);
		assert.deepEqual(targetsOf(g, "src_b_repo", "method"), ["src_b_repo_load", "src_b_repo_load_936cd9"]);
		assert.deepEqual(targetsOf(g, "src_b_repo_load", "calls"), ["src_b_repo_load_936cd9"], "self._load() bound to load() itself");
	}
});
