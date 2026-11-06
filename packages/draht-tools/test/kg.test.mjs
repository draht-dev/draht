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
const { parseDecls } = createRequire(import.meta.url)("../bin/draht-kg.cjs");
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
