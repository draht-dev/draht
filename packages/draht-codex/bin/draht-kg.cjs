#!/usr/bin/env node
"use strict";

/**
 * draht-kg — graphify-parity deterministic symbol-level knowledge graph.
 *
 * Second engine beside `map-graph` (which builds the module-level living map):
 * here NODES are symbols (files, classes, functions, methods, types) and EDGES
 * carry graphify's relation set (imports/imports_from/re_exports/dynamic_import/
 * contains/defines/method/calls/indirect_call/inherits/implements/extends/
 * instantiates/references) with the EXTRACTED / INFERRED / AMBIGUOUS confidence
 * rubric. Everything is deterministic — no LLM, no network, no timestamps in
 * output — and `graph.json` is schema-compatible with graphify's node-link
 * format (directed, `nodes` + `edges`).
 *
 * Ports of graphify internals (Graphify-Labs/graphify @ main):
 *  - ids.py            → normalizeId/makeId (NFKC, non-word→_, collapse, casefold)
 *  - serve.py          → query terms/stopwords, IDF, tier scoring with coverage²,
 *                        seed selection, BFS/DFS with hub guard, NODE/EDGE output
 *  - affected.py       → reverse traversal over the default relation set
 *  - analyze.py        → god nodes, surprising connections, suggested questions,
 *                        import cycles
 *  - cluster.py        → deterministic communities + cohesion + hub labels
 *  - report.py         → KG_REPORT.md section list
 *  - extract.py        → node/edge emission contract (regex heuristics stand in
 *                        for tree-sitter; confidence marks the difference)
 *
 * Zero runtime dependencies; Node >= 20. Loaded by draht-tools.cjs (`kg` command)
 * and runnable standalone: `node draht-kg.cjs build`.
 */

const fs = require("node:fs");
const path = require("node:path");

// ============================================================================
// Constants
// ============================================================================

const OUT_DIRNAME = path.join(".planning", "codebase");
const GRAPH_BASENAME = "graph.json";

const KG_IGNORES = new Set([
	"node_modules", ".git", "dist", "build", "out", "target", ".next",
	".turbo", ".cache", "coverage", ".nyc_output", ".planning",
	".venv", "venv", "__pycache__", ".pytest_cache", ".idea", ".vscode",
	".DS_Store", ".sst", ".astro", ".svelte-kit", "vendor", "tmp", ".tmp",
]);

const KG_LANG_BY_EXT = {
	".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".go": "go", ".rs": "rust",
};
const TS_LIKE = new Set(["typescript", "javascript"]);
const LANG_FAMILY = { typescript: "js", javascript: "js", python: "py", go: "go", rust: "rs" };

// graphify export.py:159 — filled when an edge carries no explicit score.
const CONFIDENCE_SCORE_DEFAULTS = { EXTRACTED: 1.0, INFERRED: 0.5, AMBIGUOUS: 0.2 };
// graphify extract.py — inferred cross-file call binding carries an explicit 0.8.
const INFERRED_CALL_SCORE = 0.8;

// graphify affected.py DEFAULT_AFFECTED_RELATIONS
const DEFAULT_AFFECTED_RELATIONS = [
	"calls", "indirect_call", "references", "imports", "imports_from", "re_exports",
	"inherits", "extends", "implements", "uses", "mixes_in", "embeds",
];

// graphify serve.py _QUERY_STOPWORDS (verbatim)
const QUERY_STOPWORDS = new Set([
	"how", "what", "why", "when", "where", "which", "who", "whom", "whose",
	"does", "did", "is", "are", "was", "were", "be", "been", "being",
	"can", "could", "should", "would", "will", "shall", "may", "might", "must",
	"has", "have", "had", "the", "and", "but", "not", "for", "from", "with",
	"without", "into", "onto", "off", "that", "this", "these", "those", "there",
	"here", "its", "their", "them", "they", "about", "any", "all", "some",
	"work", "works", "working",
]);

const EXACT_MATCH_BONUS = 1000.0;
const PREFIX_MATCH_BONUS = 100.0;
const SUBSTRING_MATCH_BONUS = 1.0;
const SOURCE_MATCH_BONUS = 0.5;

// Language builtins never bound as call targets (subset of graphify's
// _LANGUAGE_BUILTIN_GLOBALS covering the languages this engine extracts).
const BUILTINS = new Set([
	// js/ts
	"require", "import", "console", "parseInt", "parseFloat", "setTimeout", "setInterval",
	"clearTimeout", "clearInterval", "fetch", "String", "Number", "Boolean", "Array",
	"Object", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Error", "TypeError",
	"RangeError", "SyntaxError", "JSON", "Math", "Date", "RegExp", "Proxy", "Reflect",
	"BigInt", "Function", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
	"structuredClone", "queueMicrotask", "atob", "btoa", "URL", "URLSearchParams",
	"AbortController", "TextEncoder", "TextDecoder", "Buffer", "Int8Array", "Uint8Array",
	"Float32Array", "Float64Array", "ArrayBuffer", "DataView", "Infinity", "globalThis",
	// python
	"print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple",
	"type", "isinstance", "issubclass", "super", "open", "enumerate", "zip", "map", "filter",
	"sorted", "reversed", "sum", "min", "max", "abs", "round", "repr", "hash", "iter", "next",
	"getattr", "setattr", "hasattr", "delattr", "vars", "dir", "id", "input", "format", "any",
	// go
	"make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover", "close",
	// rust
	"vec", "println", "eprintln", "format", "panic", "assert", "assert_eq", "write", "writeln",
]);

// Control-flow keywords that look like calls in `name(` scans.
const CALL_KEYWORDS = new Set([
	"if", "else", "for", "while", "switch", "catch", "try", "do", "return", "throw",
	"new", "await", "async", "typeof", "instanceof", "void", "delete", "yield", "case",
	"function", "class", "const", "let", "var", "constructor", "super", "this", "self",
	"def", "elif", "except", "with", "assert", "lambda", "raise", "match", "loop", "fn",
	"impl", "pub", "use", "mod", "func", "go", "defer", "select", "chan", "interface",
	"struct", "enum", "trait", "type", "in", "of", "as", "satisfies", "declare", "export",
]);

// graphify analyze.py noise labels for god-node filtering (subset).
const BUILTIN_NOISE_LABELS = new Set([
	"str", "int", "float", "bool", "list", "dict", "set", "tuple", "Path", "Mock",
	"string", "number", "boolean", "object", "any", "unknown", "void", "null", "undefined",
	"Error", "Option", "Result", "Vec", "String", "error",
]);

// ============================================================================
// ID canonicalization — port of graphify ids.py
// ============================================================================

function normalizeId(s) {
	s = String(s).normalize("NFKC");
	s = s.replace(/[^\p{L}\p{N}_]+/gu, "_");
	s = s.replace(/_+/g, "_");
	return s.replace(/^_+|_+$/g, "").toLowerCase();
}

function makeId(...parts) {
	return normalizeId(parts.filter(Boolean).map((p) => String(p).replace(/^[_.]+|[_.]+$/g, "")).join("_"));
}

// Full repo-relative path, extension dropped (extractors/base.py _file_stem).
function fileStem(rel) {
	return rel.replace(/\.[^/.]+$/, "");
}

function fileNodeId(rel) {
	return makeId(fileStem(rel));
}

function symbolNodeId(rel, name) {
	return makeId(fileStem(rel), name);
}

// ============================================================================
// Repo walk
// ============================================================================

function findRepoRoot(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	dir = path.resolve(startDir);
	for (;;) {
		try {
			const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
			if (pj && pj.workspaces) return dir;
		} catch { /* empty */ }
		if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(startDir);
}

function walk(root, maxFiles = 20000) {
	const files = [];
	const stack = [root];
	while (stack.length && files.length < maxFiles) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		} catch { continue; }
		for (const e of entries) {
			if (KG_IGNORES.has(e.name)) continue;
			if (e.name.startsWith(".") && e.isDirectory()) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && KG_LANG_BY_EXT[path.extname(e.name).toLowerCase()]) files.push(full);
		}
	}
	files.sort();
	return files;
}

// ============================================================================
// Comment/string stripping (for call-site scans; decls scan raw lines)
// ============================================================================

function stripCode(content, lang) {
	let s = content;
	if (TS_LIKE.has(lang) || lang === "go" || lang === "rust") {
		s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
		s = s.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
		s = s.replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, " "));
	} else if (lang === "python") {
		s = s.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, " "));
		s = s.replace(/#[^\n]*/g, (m) => " ".repeat(m.length));
	}
	s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => " ".repeat(m.length));
	s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => " ".repeat(m.length));
	return s;
}

// ============================================================================
// Per-language declaration extraction (phase 1)
// ============================================================================

const MAX_SYMBOLS_PER_FILE = 300;

function parseDecls(rel, content, lang) {
	const lines = content.split("\n");
	const d = { classes: [], functions: [], types: [], imports: [], docstring: null };

	if (TS_LIKE.has(lang)) {
		// Leading /** */ or run of // as module rationale
		const dm = content.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
		if (dm) d.docstring = dm[1].replace(/^\s*\*\s?/gm, "").trim().slice(0, 500) || null;

		let currentClass = null, classDepth = 0, depth = 0;
		for (let i = 0; i < lines.length && d.classes.length + d.functions.length + d.types.length < MAX_SYMBOLS_PER_FILE; i++) {
			const ln = lines[i];
			let m;
			if (depth === 0 && (m = ln.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?(?:\s+implements\s+([\w$,\s.<>]+?))?\s*\{?/)) && /\bclass\b/.test(ln)) {
				currentClass = { name: m[1], line: i + 1, extends: m[2] ? m[2].split(".")[0] : null, implements: (m[3] || "").split(",").map((x) => x.trim().split("<")[0].split(".")[0]).filter(Boolean), methods: [] };
				d.classes.push(currentClass);
				classDepth = depth;
			} else if (depth === 0 && (m = ln.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
				d.functions.push({ name: m[1], line: i + 1 });
			} else if (depth === 0 && (m = ln.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?::[^=]+)?\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/))) {
				d.functions.push({ name: m[1], line: i + 1 });
			} else if (depth === 0 && (m = ln.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
				d.types.push({ name: m[1], line: i + 1, kind: "const" });
			} else if (depth === 0 && (m = ln.match(/^\s*(?:export\s+)?(?:interface|enum)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?/)) && /\b(?:interface|enum)\b/.test(ln)) {
				d.types.push({ name: m[1], line: i + 1, kind: /\binterface\b/.test(ln) ? "interface" : "enum", extends: m[2] ? m[2].split(".")[0] : null });
			} else if (depth === 0 && (m = ln.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/))) {
				d.types.push({ name: m[1], line: i + 1, kind: "type" });
			} else if (currentClass && depth === classDepth + 1 && (m = ln.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|abstract\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/))) {
				if (!CALL_KEYWORDS.has(m[1]) && currentClass.methods.length < 80) currentClass.methods.push({ name: m[1], line: i + 1 });
			}
			// brace depth AFTER matching decls on this line
			for (const ch of ln) {
				if (ch === "{") depth++;
				else if (ch === "}") { depth--; if (currentClass && depth <= classDepth) currentClass = null; }
			}
		}
		// imports (content-level, multi-line safe)
		const impRe = /import\s+(?:(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*)?["']([^"']+)["']/g;
		let m2;
		while ((m2 = impRe.exec(content)) !== null) {
			if (!/^import/.test(m2[0])) continue;
			const names = (m2[3] || "").split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)
				.map((t) => { const am = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/); return am ? { imported: am[1], local: am[2] || am[1] } : null; })
				.filter(Boolean);
			d.imports.push({ spec: m2[4], default: m2[1] || null, namespace: m2[2] || null, names, reExport: false, dynamic: false, line: lineAt(content, m2.index) });
		}
		const reExpRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
		while ((m2 = reExpRe.exec(content)) !== null) {
			const names = m2[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)
				.map((t) => { const am = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/); return am ? { imported: am[1], local: am[2] || am[1] } : null; })
				.filter(Boolean);
			d.imports.push({ spec: m2[2], default: null, namespace: null, names, reExport: true, dynamic: false, line: lineAt(content, m2.index) });
		}
		const starRe = /export\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\s*["']([^"']+)["']/g;
		while ((m2 = starRe.exec(content)) !== null) {
			d.imports.push({ spec: m2[1], default: null, namespace: "*", names: [], reExport: true, dynamic: false, line: lineAt(content, m2.index) });
		}
		const dynRe = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
		while ((m2 = dynRe.exec(content)) !== null) {
			d.imports.push({ spec: m2[1], default: null, namespace: null, names: [], reExport: false, dynamic: true, line: lineAt(content, m2.index) });
		}
	} else if (lang === "python") {
		const dm = content.match(/^(?:#[^\n]*\n|\s*\n)*\s*("""|''')([\s\S]*?)\1/);
		if (dm) d.docstring = dm[2].trim().slice(0, 500) || null;
		let currentClass = null;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			let m;
			if ((m = ln.match(/^class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?/))) {
				currentClass = { name: m[1], line: i + 1, extends: (m[2] || "").split(",")[0]?.trim().split(".").pop() || null, implements: [], methods: [] };
				d.classes.push(currentClass);
			} else if ((m = ln.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)/))) {
				d.functions.push({ name: m[1], line: i + 1 });
				currentClass = null;
			} else if (currentClass && (m = ln.match(/^\s{2,8}(?:async\s+)?def\s+([A-Za-z_][\w]*)/))) {
				if (currentClass.methods.length < 80) currentClass.methods.push({ name: m[1], line: i + 1 });
			} else if (/^\S/.test(ln) && !/^[\s)\]}#@]/.test(ln) && !/^(class|def|async|from|import)/.test(ln)) {
				currentClass = null;
			}
		}
		const impRe = /^\s*from\s+(\S+)\s+import\s+([^\n(]+|\([^)]*\))|^\s*import\s+([\w.]+)/gm;
		let m2;
		while ((m2 = impRe.exec(content)) !== null) {
			if (m2[3]) d.imports.push({ spec: m2[3], default: null, namespace: m2[3], names: [], reExport: false, dynamic: false, line: lineAt(content, m2.index) });
			else {
				const names = m2[2].replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/)).filter((p) => p[0])
					.map((p) => ({ imported: p[0], local: p[1] || p[0] }));
				d.imports.push({ spec: m2[1], default: null, namespace: null, names, reExport: false, dynamic: false, line: lineAt(content, m2.index) });
			}
		}
	} else if (lang === "go") {
		let currentType = null;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			let m;
			if ((m = ln.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/))) {
				currentType = { name: m[1], line: i + 1, extends: null, implements: [], methods: [] };
				d.classes.push(currentType);
			} else if ((m = ln.match(/^func\s+\(\s*\w+\s+\*?([A-Za-z_][\w]*)\s*\)\s+([A-Za-z_][\w]*)/))) {
				const owner = d.classes.find((c) => c.name === m[1]);
				if (owner) { if (owner.methods.length < 80) owner.methods.push({ name: m[2], line: i + 1 }); }
				else d.functions.push({ name: m[2], line: i + 1 });
			} else if ((m = ln.match(/^func\s+([A-Za-z_][\w]*)/))) {
				d.functions.push({ name: m[1], line: i + 1 });
			} else if ((m = ln.match(/^type\s+([A-Za-z_][\w]*)\s/))) {
				d.types.push({ name: m[1], line: i + 1, kind: "type" });
			}
		}
		// Named (`import foo "path"`), blank (`_`) and dot (`.`) imports all count;
		// a named alias becomes the local namespace so call binding can resolve
		// through it. Applies to both single-line and block forms.
		const impRe = /^import\s+(?:([\w.]+)\s+)?"([^"]+)"|^import\s+\(([^)]*)\)/gm;
		let m2;
		while ((m2 = impRe.exec(content)) !== null) {
			const entries = [];
			if (m2[2]) entries.push({ alias: m2[1] || null, spec: m2[2] });
			else if (m2[3]) {
				for (const lm of m2[3].matchAll(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/gm)) entries.push({ alias: lm[1] || null, spec: lm[2] });
			}
			for (const e of entries) {
				const ns = e.alias && e.alias !== "_" && e.alias !== "." ? e.alias : e.spec.split("/").pop();
				d.imports.push({ spec: e.spec, default: null, namespace: ns, names: [], reExport: false, dynamic: false, line: lineAt(content, m2.index) });
			}
		}
	} else if (lang === "rust") {
		// Track impl blocks by brace depth so `fn`s inside them become METHODS of
		// the owning type (owner-scoped ids + `method` edges), not file-level
		// functions. Covers both inherent impls and `impl Trait for Type`.
		let currentImpl = null; // { name, depth at impl line }
		let depth = 0;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			let m;
			if ((m = ln.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/))) {
				d.classes.push({ name: m[1], line: i + 1, extends: null, implements: [], methods: [] });
			} else if (!currentImpl && (m = ln.match(/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w]*)(?:<[^>]*>)?\s+for\s+([A-Za-z_][\w]*)/))) {
				const owner = d.classes.find((c) => c.name === m[2]);
				if (owner) owner.implements.push(m[1]);
				currentImpl = { name: m[2], depth };
			} else if (!currentImpl && (m = ln.match(/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w]*)/))) {
				currentImpl = { name: m[1], depth };
			} else if ((m = ln.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/))) {
				const owner = currentImpl ? d.classes.find((c) => c.name === currentImpl.name) : null;
				if (owner) {
					if (owner.methods.length < 80) owner.methods.push({ name: m[1], line: i + 1 });
				} else {
					d.functions.push({ name: m[1], line: i + 1 });
				}
			}
			if ((m = ln.match(/^\s*use\s+([\w:]+)/))) {
				d.imports.push({ spec: m[1], default: null, namespace: m[1].split("::").pop(), names: [], reExport: false, dynamic: false, line: i + 1 });
			}
			for (const ch of ln) {
				if (ch === "{") depth++;
				else if (ch === "}") {
					depth--;
					if (currentImpl && depth <= currentImpl.depth) currentImpl = null;
				}
			}
		}
	}
	return d;
}

function lineAt(content, idx) {
	let n = 1;
	for (let i = 0; i < idx && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
	return n;
}

// ============================================================================
// Build (phases 2-8)
// ============================================================================

function buildGraph(root) {
	const files = walk(root);
	const nodes = [];
	const nodeById = new Map();
	const edges = [];
	const perFile = new Map(); // rel -> { lang, decls, stripped, localDefs: Map(name -> nid), importedNames: Map(local -> {spec, resolvedRel|null, imported}) }

	const addNode = (n) => {
		if (nodeById.has(n.id)) return nodeById.get(n.id);
		nodeById.set(n.id, n);
		nodes.push(n);
		return n;
	};
	const addEdge = (source, target, relation, opts = {}) => {
		const confidence = opts.confidence || "EXTRACTED";
		edges.push({
			source, target, relation, confidence,
			confidence_score: opts.score != null ? opts.score : CONFIDENCE_SCORE_DEFAULTS[confidence],
			context: opts.context || undefined,
			source_file: opts.file || undefined,
			source_location: opts.line ? "L" + opts.line : undefined,
			weight: 1.0,
			_deferred: opts.deferred || undefined,
		});
	};

	// -- phase 1+2: decls → nodes, contains/defines/method edges
	for (const abs of files) {
		const rel = path.relative(root, abs).split(path.sep).join("/");
		const ext = path.extname(rel).toLowerCase();
		const lang = KG_LANG_BY_EXT[ext];
		let content;
		try { content = fs.readFileSync(abs, "utf-8"); } catch { continue; }
		if (content.length > 2_000_000) continue;
		const decls = parseDecls(rel, content, lang);
		const stripped = stripCode(content, lang);
		const fileNid = fileNodeId(rel);
		const fileNode = addNode({ id: fileNid, label: path.basename(rel), file_type: "code", source_file: rel, source_location: "L1" });
		if (decls.docstring) fileNode.rationale = decls.docstring;
		const localDefs = new Map();

		for (const c of decls.classes) {
			const nid = symbolNodeId(rel, c.name);
			addNode({ id: nid, label: c.name, file_type: "code", source_file: rel, source_location: "L" + c.line, type: "class" });
			addEdge(fileNid, nid, "contains", { file: rel, line: c.line });
			localDefs.set(c.name, nid);
			for (const meth of c.methods) {
				const mid = makeId(fileStem(rel), c.name, meth.name);
				addNode({ id: mid, label: meth.name + "()", file_type: "code", source_file: rel, source_location: "L" + meth.line, _callable: true });
				addEdge(nid, mid, "method", { file: rel, line: meth.line });
			}
		}
		for (const f of decls.functions) {
			if (localDefs.has(f.name)) continue;
			const nid = symbolNodeId(rel, f.name);
			addNode({ id: nid, label: f.name + "()", file_type: "code", source_file: rel, source_location: "L" + f.line, _callable: true });
			addEdge(fileNid, nid, "defines", { file: rel, line: f.line });
			localDefs.set(f.name, nid);
		}
		for (const t of decls.types) {
			if (localDefs.has(t.name)) continue;
			const nid = symbolNodeId(rel, t.name);
			addNode({ id: nid, label: t.name, file_type: "code", source_file: rel, source_location: "L" + t.line, type: t.kind });
			addEdge(fileNid, nid, "defines", { file: rel, line: t.line });
			localDefs.set(t.name, nid);
		}
		perFile.set(rel, { lang, decls, stripped, localDefs, importedNames: new Map(), fileNid });
	}

	// -- workspace package resolution (js/ts monorepos)
	const rels = [...perFile.keys()];
	const relSet = new Set(rels);
	const workspaceEntry = new Map();
	{
		const pkgDirs = new Set([""]);
		for (const rel of rels) {
			const parts = rel.split("/");
			for (let i = 1; i < parts.length; i++) pkgDirs.add(parts.slice(0, i).join("/"));
		}
		for (const dir of [...pkgDirs].sort()) {
			const pjPath = path.join(root, dir, "package.json");
			try {
				const pj = JSON.parse(fs.readFileSync(pjPath, "utf-8"));
				if (!pj.name) continue;
				const candidates = [];
				if (typeof pj.main === "string") candidates.push(pj.main);
				if (typeof pj.module === "string") candidates.push(pj.module);
				const collect = (v) => { if (typeof v === "string") candidates.push(v); else if (v && typeof v === "object") for (const k of Object.values(v)) collect(k); };
				if (pj.exports) collect(pj.exports);
				candidates.push("src/index.ts", "src/index.js", "index.ts", "index.js");
				for (const c of candidates) {
					if (typeof c !== "string") continue;
					const base = path.posix.normalize(path.posix.join(dir, c.replace(/^\.\//, "")));
					const stems = [base, base.replace(/\.(js|mjs|cjs|jsx)$/, "")];
					let hit = null;
					for (const stem of stems) {
						for (const e of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) {
							if (relSet.has(stem + e)) { hit = stem + e; break; }
						}
						if (hit) break;
					}
					if (hit) { if (!workspaceEntry.has(pj.name)) workspaceEntry.set(pj.name, hit); break; }
				}
			} catch { /* empty */ }
		}
	}

	const resolveSpec = (fromRel, spec) => {
		const fromDir = path.posix.dirname(fromRel);
		if (spec.startsWith(".")) {
			const base = path.posix.normalize(path.posix.join(fromDir, spec));
			const stems = [base];
			if (/\.(js|mjs|cjs|jsx)$/.test(base)) stems.push(base.replace(/\.(js|mjs|cjs|jsx)$/, ""));
			for (const stem of stems) {
				for (const e of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs"]) {
					if (relSet.has(stem + e)) return stem + e;
				}
				for (const e of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
					if (relSet.has(path.posix.join(stem, "index" + e))) return path.posix.join(stem, "index" + e);
				}
			}
			return null;
		}
		if (workspaceEntry.has(spec)) return workspaceEntry.get(spec);
		const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
		if (slash > 0 && workspaceEntry.has(spec.slice(0, slash))) return workspaceEntry.get(spec.slice(0, slash));
		// python dotted module → path
		if (/^[\w.]+$/.test(spec) && spec.includes(".")) {
			const p = spec.replace(/\./g, "/");
			for (const c of [p + ".py", p + "/__init__.py"]) if (relSet.has(c)) return c;
		}
		if (relSet.has(spec + ".py")) return spec + ".py";
		return null;
	};

	// -- phase 3: import edges
	for (const rel of rels) {
		const pf = perFile.get(rel);
		for (const imp of pf.decls.imports) {
			const resolved = resolveSpec(rel, imp.spec);
			let targetFileNid;
			if (resolved) {
				targetFileNid = perFile.get(resolved).fileNid;
			} else {
				// external module node (concept-style: no source_file, like graphify module nodes)
				targetFileNid = makeId(imp.spec);
				if (!targetFileNid) continue;
				addNode({ id: targetFileNid, label: imp.spec, file_type: "code", source_file: "", source_location: "", type: "module" });
			}
			const relation = imp.dynamic ? "dynamic_import" : imp.reExport ? "re_exports" : "imports_from";
			addEdge(pf.fileNid, targetFileNid, relation, { file: rel, line: imp.line, context: "import", deferred: imp.dynamic || undefined });
			// symbol-level imports edges (only when target resolves in-repo)
			if (resolved && !imp.dynamic) {
				const tpf = perFile.get(resolved);
				for (const n of imp.names) {
					const tnid = tpf.localDefs.get(n.imported);
					if (tnid) {
						if (!imp.reExport) addEdge(pf.fileNid, tnid, "imports", { file: rel, line: imp.line, context: "import" });
						pf.importedNames.set(n.local, { rel: resolved, name: n.imported, nid: tnid });
					} else {
						pf.importedNames.set(n.local, { rel: resolved, name: n.imported, nid: null });
					}
				}
				if (imp.default) pf.importedNames.set(imp.default, { rel: resolved, name: "default", nid: null });
				if (imp.namespace && imp.namespace !== "*") pf.importedNames.set(imp.namespace, { rel: resolved, name: "*", nid: null });
			}
		}
	}

	// -- phase 4: inherits / implements / extends
	const globalDefs = new Map(); // name -> [ {rel, nid, family} ]
	for (const rel of rels) {
		const pf = perFile.get(rel);
		for (const [name, nid] of pf.localDefs) {
			if (!globalDefs.has(name)) globalDefs.set(name, []);
			globalDefs.get(name).push({ rel, nid, family: LANG_FAMILY[pf.lang] });
		}
	}
	const resolveName = (pf, name) => {
		// local → import evidence → unique global (same family) → null
		if (pf.localDefs.has(name)) return { nid: pf.localDefs.get(name), confidence: "EXTRACTED" };
		const imp = pf.importedNames.get(name);
		if (imp && imp.nid) return { nid: imp.nid, confidence: "EXTRACTED" };
		if (imp && imp.rel) {
			const tpf = perFile.get(imp.rel);
			const t = tpf && tpf.localDefs.get(imp.name === "default" ? name : imp.name);
			if (t) return { nid: t, confidence: "EXTRACTED" };
			return null;
		}
		const cands = (globalDefs.get(name) || []).filter((c) => c.family === LANG_FAMILY[pf.lang]);
		if (cands.length === 1 && !TS_LIKE.has(pf.lang)) return { nid: cands[0].nid, confidence: "INFERRED" };
		return null;
	};
	for (const rel of rels) {
		const pf = perFile.get(rel);
		for (const c of pf.decls.classes) {
			const cnid = pf.localDefs.get(c.name);
			if (!cnid) continue;
			if (c.extends && !BUILTIN_NOISE_LABELS.has(c.extends)) {
				const r = resolveName(pf, c.extends);
				if (r) addEdge(cnid, r.nid, "inherits", { file: rel, line: c.line, confidence: r.confidence, score: r.confidence === "INFERRED" ? INFERRED_CALL_SCORE : undefined });
			}
			for (const iface of c.implements || []) {
				if (BUILTIN_NOISE_LABELS.has(iface)) continue;
				const r = resolveName(pf, iface);
				if (r) addEdge(cnid, r.nid, "implements", { file: rel, line: c.line, confidence: r.confidence, score: r.confidence === "INFERRED" ? INFERRED_CALL_SCORE : undefined });
			}
		}
		for (const t of pf.decls.types) {
			if (t.extends && pf.localDefs.has(t.name)) {
				const r = resolveName(pf, t.extends);
				if (r) addEdge(pf.localDefs.get(t.name), r.nid, "extends", { file: rel, line: t.line, confidence: r.confidence });
			}
		}
	}

	// -- phase 5: calls / instantiates / indirect_call
	for (const rel of rels) {
		const pf = perFile.get(rel);
		const lines = pf.stripped.split("\n");
		// symbol regions: decl line → next decl line
		const anchors = [];
		for (const c of pf.decls.classes) {
			for (const meth of c.methods) anchors.push({ nid: makeId(fileStem(rel), c.name, meth.name), line: meth.line });
			anchors.push({ nid: pf.localDefs.get(c.name), line: c.line });
		}
		for (const f of pf.decls.functions) anchors.push({ nid: pf.localDefs.get(f.name), line: f.line });
		anchors.sort((a, b) => a.line - b.line);
		const regionOf = (lineNo) => {
			let cur = null;
			for (const a of anchors) { if (a.line <= lineNo) cur = a; else break; }
			return cur ? cur.nid : pf.fileNid;
		};
		const seenCalls = new Set();
		const callRe = /(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
		const newRe = /\bnew\s+([A-Za-z_$][\w$.]*)\s*[(<]/g;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			let m;
			callRe.lastIndex = 0;
			while ((m = callRe.exec(ln)) !== null) {
				const name = m[1];
				if (CALL_KEYWORDS.has(name) || BUILTINS.has(name)) continue;
				const caller = regionOf(i + 1);
				const r = resolveName(pf, name);
				if (!r || r.nid === caller) continue;
				const key = caller + "|" + r.nid + "|calls";
				if (seenCalls.has(key)) continue;
				seenCalls.add(key);
				const target = nodeById.get(r.nid);
				if (!target || !target._callable) {
					// calling a class = instantiation in py; skip non-callables otherwise
					if (target && target.type === "class" && pf.lang === "python") {
						addEdge(caller, r.nid, "instantiates", { file: rel, line: i + 1, confidence: r.confidence, context: "call" });
					}
					continue;
				}
				addEdge(caller, r.nid, "calls", { file: rel, line: i + 1, confidence: r.confidence, score: r.confidence === "INFERRED" ? INFERRED_CALL_SCORE : undefined, context: "call" });
			}
			// this.x()/self.x() → own class method
			let sm;
			const selfRe = /\b(?:this|self)\.([A-Za-z_][\w$]*)\s*\(/g;
			while ((sm = selfRe.exec(ln)) !== null) {
				const caller = regionOf(i + 1);
				for (const c of pf.decls.classes) {
					if (c.line <= i + 1 && c.methods.some((x) => x.name === sm[1])) {
						const mid = makeId(fileStem(rel), c.name, sm[1]);
						const key = caller + "|" + mid + "|calls";
						if (!seenCalls.has(key) && mid !== caller) { seenCalls.add(key); addEdge(caller, mid, "calls", { file: rel, line: i + 1, context: "call" }); }
						break;
					}
				}
			}
			newRe.lastIndex = 0;
			while ((m = newRe.exec(ln)) !== null) {
				const name = m[1].split(".")[0];
				if (BUILTINS.has(name) || BUILTIN_NOISE_LABELS.has(name)) continue;
				const r = resolveName(pf, name);
				if (!r) continue;
				const caller = regionOf(i + 1);
				const key = caller + "|" + r.nid + "|instantiates";
				if (seenCalls.has(key) || r.nid === caller) continue;
				seenCalls.add(key);
				addEdge(caller, r.nid, "instantiates", { file: rel, line: i + 1, confidence: r.confidence, context: "call" });
			}
			// indirect_call: known callable passed as a bare argument — f(cb) / f(x, cb)
			const argRe = /[(,]\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
			while ((m = argRe.exec(ln)) !== null) {
				const name = m[1];
				if (CALL_KEYWORDS.has(name) || BUILTINS.has(name)) continue;
				const r = pf.localDefs.has(name) ? { nid: pf.localDefs.get(name) } : (pf.importedNames.get(name) && pf.importedNames.get(name).nid ? { nid: pf.importedNames.get(name).nid } : null);
				if (!r) continue;
				const target = nodeById.get(r.nid);
				if (!target || !target._callable) continue;
				const caller = regionOf(i + 1);
				const key = caller + "|" + r.nid + "|indirect_call";
				if (seenCalls.has(key) || r.nid === caller || seenCalls.has(caller + "|" + r.nid + "|calls")) continue;
				seenCalls.add(key);
				addEdge(caller, r.nid, "indirect_call", { file: rel, line: i + 1, confidence: "INFERRED", score: INFERRED_CALL_SCORE, context: "call" });
			}
		}
	}

	// -- phase 6: dedupe + sort (determinism)
	const edgeKey = (e) => e.source + " " + e.target + " " + e.relation;
	const seenEdge = new Set();
	const dedupedEdges = [];
	for (const e of edges) {
		const k = edgeKey(e);
		if (seenEdge.has(k)) continue;
		if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
		seenEdge.add(k);
		dedupedEdges.push(e);
	}
	nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	dedupedEdges.sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : 1));

	// -- phase 7: communities + analysis
	const { communityOf, communities } = computeCommunities(nodes, dedupedEdges);
	for (const n of nodes) {
		n.community = communityOf.get(n.id);
		n.community_name = communities[n.community] ? communities[n.community].name : undefined;
		n.norm_label = normalizeId(n.label).replace(/_/g, " ");
	}

	return { nodes, edges: dedupedEdges, communities };
}

// ---------------------------------------------------------------------------
// Communities — deterministic LPA + graphify cluster.py post-processing
// ---------------------------------------------------------------------------

function computeCommunities(nodes, edges) {
	const adj = new Map();
	for (const n of nodes) adj.set(n.id, new Set());
	for (const e of edges) {
		if (e.source === e.target) continue;
		adj.get(e.source).add(e.target);
		adj.get(e.target).add(e.source);
	}
	const ids = nodes.map((n) => n.id); // already sorted
	const label = new Map(ids.map((id) => [id, id]));
	for (let pass = 0; pass < 10; pass++) {
		let changed = false;
		for (const id of ids) {
			const counts = new Map();
			for (const nb of adj.get(id)) {
				const l = label.get(nb);
				counts.set(l, (counts.get(l) || 0) + 1);
			}
			if (!counts.size) continue;
			let best = null, bestC = -1;
			for (const [l, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
				if (c > bestC) { best = l; bestC = c; }
			}
			if (best !== label.get(id)) { label.set(id, best); changed = true; }
		}
		if (!changed) break;
	}
	let groups = new Map();
	for (const id of ids) {
		const l = label.get(id);
		if (!groups.has(l)) groups.set(l, []);
		groups.get(l).push(id);
	}
	// graphify: oversized (>25% of graph, min 10) and low-cohesion (<0.05, >=50)
	// communities are re-split. Splitter: two-level source-dir prefix (deterministic).
	const nodeById = new Map(nodes.map((n) => [n.id, n]));
	const intraEdges = (members) => {
		const s = new Set(members);
		let c = 0;
		for (const id of members) for (const nb of adj.get(id)) if (s.has(nb) && id < nb) c++;
		return c;
	};
	const cohesion = (members) => {
		const n = members.length;
		if (n < 2) return 0;
		return intraEdges(members) / ((n * (n - 1)) / 2);
	};
	// In a monorepo a 2-segment prefix is just "packages/<pkg>", which can still be
	// a third of the graph — recurse deeper (up to 6 segments) until no subgroup
	// stays oversized. Deterministic: prefix-sorted, fixed depth cap.
	const total = nodes.length || 1;
	const oversized = (members) => members.length > total * 0.25 && members.length >= 10;
	const splitByDir = (members, depth) => {
		if (depth > 6) return [members];
		const sub = new Map();
		for (const id of members) {
			const src = nodeById.get(id).source_file || "(external)";
			const key = src.split("/").slice(0, depth).join("/");
			if (!sub.has(key)) sub.set(key, []);
			sub.get(key).push(id);
		}
		if (sub.size === 1) return splitByDir(members, depth + 1);
		const out = [];
		for (const [, v] of [...sub.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			if (oversized(v)) out.push(...splitByDir(v, depth + 1));
			else out.push(v);
		}
		return out;
	};
	let finalGroups = [];
	for (const members of [...groups.values()]) {
		if (oversized(members) || (members.length >= 50 && cohesion(members) < 0.05)) {
			finalGroups.push(...splitByDir(members, 2));
		} else finalGroups.push(members);
	}
	// re-index by size desc, tiebreak on sorted member tuple (cluster.py)
	finalGroups = finalGroups.map((m) => m.slice().sort());
	finalGroups.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
	const communityOf = new Map();
	const degree = new Map();
	for (const id of ids) degree.set(id, adj.get(id).size);
	const communities = finalGroups.map((members, idx) => {
		for (const id of members) communityOf.set(id, idx);
		// hub label: highest-degree member (label_communities_by_hub), lexicographic tiebreak
		let hub = members[0];
		for (const id of members) {
			if (degree.get(id) > degree.get(hub) || (degree.get(id) === degree.get(hub) && id < hub)) hub = id;
		}
		return {
			id: idx,
			name: nodeById.get(hub).label,
			size: members.length,
			cohesion: +cohesion(members).toFixed(4),
			members,
		};
	});
	return { communityOf, communities };
}

// ---------------------------------------------------------------------------
// Analysis — ports of analyze.py
// ---------------------------------------------------------------------------

function buildAdjacency(graph) {
	const out = new Map(), inn = new Map(), deg = new Map();
	for (const n of graph.nodes) { out.set(n.id, []); inn.set(n.id, []); deg.set(n.id, 0); }
	for (const e of graph.edges) {
		if (!out.has(e.source) || !inn.has(e.target)) continue;
		out.get(e.source).push(e);
		inn.get(e.target).push(e);
		deg.set(e.source, deg.get(e.source) + 1);
		deg.set(e.target, deg.get(e.target) + 1);
	}
	return { out, inn, deg };
}

function isFileNode(n) {
	return n.source_file && path.basename(n.source_file) === n.label;
}
function isConceptNode(n) {
	if (!n.source_file) return true;
	return !n.source_file.split("/").pop().includes(".");
}

function godNodes(graph, adj, topN = 10) {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const sorted = [...adj.deg.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const result = [];
	for (const [id, deg] of sorted) {
		const n = byId.get(id);
		if (isFileNode(n) || isConceptNode(n)) continue;
		if (BUILTIN_NOISE_LABELS.has(n.label)) continue;
		if (n.label.endsWith("()") && deg <= 1) continue;
		result.push({ id, label: n.label, degree: deg, source_file: n.source_file, community: n.community });
		if (result.length >= topN) break;
	}
	return result;
}

function surprisingConnections(graph, adj, topN = 10) {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const skipRel = new Set(["imports", "imports_from", "contains", "method", "defines"]);
	const scored = [];
	for (const e of graph.edges) {
		if (skipRel.has(e.relation)) continue;
		const u = byId.get(e.source), v = byId.get(e.target);
		if (!u || !v || isConceptNode(u) || isConceptNode(v) || isFileNode(u) || isFileNode(v)) continue;
		if (u.source_file === v.source_file) continue;
		let score = 0;
		const reasons = [];
		const confBonus = { AMBIGUOUS: 3, INFERRED: 2, EXTRACTED: 1 }[e.confidence] || 1;
		score += confBonus;
		if (e.confidence === "AMBIGUOUS" || e.confidence === "INFERRED") reasons.push(`${e.confidence.toLowerCase()} connection - not explicitly stated in source`);
		const topU = u.source_file.split("/")[0], topV = v.source_file.split("/")[0];
		if (topU !== topV) { score += 2; reasons.push("connects across different repos/directories"); }
		if (u.community != null && v.community != null && u.community !== v.community) { score += 1; reasons.push("bridges separate communities"); }
		const degU = adj.deg.get(e.source) || 0, degV = adj.deg.get(e.target) || 0;
		if (Math.min(degU, degV) <= 2 && Math.max(degU, degV) >= 5) { score += 1; reasons.push("peripheral node connects to a hub"); }
		if (score >= 3) scored.push({ score, source: u.label, target: v.label, source_id: e.source, target_id: e.target, relation: e.relation, confidence: e.confidence, reasons });
	}
	scored.sort((a, b) => b.score - a.score || (a.source_id < b.source_id ? -1 : 1) || (a.target_id < b.target_id ? -1 : 1));
	// dedupe: one per community pair
	const seenPair = new Set();
	const out = [];
	for (const s of scored) {
		const cu = byId.get(s.source_id).community, cv = byId.get(s.target_id).community;
		const key = Math.min(cu, cv) + ":" + Math.max(cu, cv);
		if (seenPair.has(key)) continue;
		seenPair.add(key);
		out.push(s);
		if (out.length >= topN) break;
	}
	return out;
}

function suggestQuestions(graph, adj, communities, gods) {
	const q = [];
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const ambiguous = graph.edges.filter((e) => e.confidence === "AMBIGUOUS").slice(0, 3);
	for (const e of ambiguous) {
		q.push(`Is the ${e.relation} edge ${byId.get(e.source)?.label} → ${byId.get(e.target)?.label} real? (marked AMBIGUOUS)`);
	}
	for (const g of gods.slice(0, 3)) {
		const inferredCount = (adj.out.get(g.id) || []).concat(adj.inn.get(g.id) || []).filter((e) => e.confidence === "INFERRED").length;
		if (inferredCount >= 2) q.push(`\`${g.label}\` has ${inferredCount} inferred edges — verify how it is actually used.`);
		else q.push(`Why does \`${g.label}\` have ${g.degree} connections — is it doing too much?`);
	}
	const isolated = graph.nodes.filter((n) => (adj.deg.get(n.id) || 0) === 0 && !isConceptNode(n)).slice(0, 2);
	for (const n of isolated) q.push(`\`${n.label}\` (${n.source_file}) has no connections — dead code or missed extraction?`);
	for (const c of communities) {
		if (c.size >= 5 && c.cohesion < 0.15) { q.push(`Community "${c.name}" (${c.size} nodes) has low cohesion ${c.cohesion} — is it really one concept?`); break; }
	}
	return q.slice(0, 8);
}

function importCycles(graph, maxLen = 5) {
	// file-level digraph over imports_from/re_exports, excluding deferred (dynamic) imports
	const adj = new Map();
	for (const e of graph.edges) {
		if (e.relation !== "imports_from" && e.relation !== "re_exports") continue;
		if (e._deferred) continue;
		if (!adj.has(e.source)) adj.set(e.source, []);
		adj.get(e.source).push(e.target);
	}
	const cycles = [];
	const seen = new Set();
	const nodes = [...adj.keys()].sort();
	for (const start of nodes) {
		const stack = [[start, [start]]];
		while (stack.length && cycles.length < 20) {
			const [cur, pathArr] = stack.pop();
			for (const nb of (adj.get(cur) || [])) {
				if (nb === start && pathArr.length > 1) {
					const rot = [...pathArr];
					const minIdx = rot.indexOf([...rot].sort()[0]);
					const canon = rot.slice(minIdx).concat(rot.slice(0, minIdx)).join("→");
					if (!seen.has(canon)) { seen.add(canon); cycles.push([...pathArr, start]); }
				} else if (!pathArr.includes(nb) && pathArr.length < maxLen) {
					stack.push([nb, [...pathArr, nb]]);
				}
			}
		}
	}
	return cycles.slice(0, 10);
}

// ---------------------------------------------------------------------------
// graph.json IO
// ---------------------------------------------------------------------------

function outDir(root) {
	return path.join(root, OUT_DIRNAME);
}

function writeGraph(root, graph) {
	const dir = outDir(root);
	fs.mkdirSync(dir, { recursive: true });
	const nodes = graph.nodes.map((n) => {
		const { _callable, ...rest } = n;
		return rest;
	});
	const edges = graph.edges.map((e) => {
		const { _deferred, ...rest } = e;
		if (_deferred) rest.deferred = true;
		for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
		return rest;
	});
	const payload = {
		directed: true,
		multigraph: false,
		graph: { generated_by: "draht-tools kg build", schema: "graphify-node-link", communities: graph.communities.map(({ members, ...c }) => c) },
		nodes,
		edges,
		hyperedges: [],
	};
	const jsonPath = path.join(dir, GRAPH_BASENAME);
	const next = JSON.stringify(payload, null, 1);
	let prev = null;
	try { prev = fs.readFileSync(jsonPath, "utf-8"); } catch { /* empty */ }
	if (prev !== next) fs.writeFileSync(jsonPath, next, "utf-8");
	return jsonPath;
}

function loadGraph(root) {
	const jsonPath = path.join(outDir(root), GRAPH_BASENAME);
	let raw;
	try { raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")); } catch { return null; }
	const edges = raw.edges || raw.links || [];
	return { nodes: raw.nodes || [], edges, communities: (raw.graph && raw.graph.communities) || [], path: jsonPath };
}

// ---------------------------------------------------------------------------
// Query engine — ports of serve.py
// ---------------------------------------------------------------------------

function stripDiacritics(s) {
	return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function searchTokens(text) {
	return (stripDiacritics(String(text)).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
}
function isSearchable(term) {
	if (/^[a-z]+$/.test(term)) return term.length > 2;
	return true;
}
function queryTerms(question) {
	const terms = [];
	for (const raw of String(question).split(/\s+/)) {
		for (const tok of (raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])) {
			if (isSearchable(tok)) terms.push(tok);
		}
	}
	const content = terms.filter((t) => !QUERY_STOPWORDS.has(t));
	return content.length ? content : terms;
}

function nodeNormLabel(n) {
	return (n.norm_label || stripDiacritics(n.label || "").toLowerCase());
}

function computeIdf(graph, terms) {
	const N = graph.nodes.length || 1;
	const idf = {};
	for (const t of terms) {
		let df = 0;
		for (const n of graph.nodes) if (nodeNormLabel(n).includes(t)) df++;
		idf[t] = Math.log(1 + N / (1 + df));
	}
	return idf;
}

function scoreNodes(graph, terms) {
	const normTerms = [...new Set(terms.flatMap((t) => searchTokens(t)))];
	const nTerms = normTerms.length || 1;
	const idf = computeIdf(graph, normTerms);
	const joined = normTerms.join(" ");
	const joinedW = Math.max(1.0, ...normTerms.map((t) => idf[t] || 1.0));
	const scored = [];
	for (const n of graph.nodes) {
		const normLabel = nodeNormLabel(n);
		const bareLabel = normLabel.replace(/\(\)+$/, "");
		const labelTokens = searchTokens(n.label || "").join(" ");
		const source = (n.source_file || "").toLowerCase();
		let score = 0;
		if (joined) {
			const nidLower = n.id.toLowerCase();
			if (joined === normLabel || joined === bareLabel || joined === labelTokens || joined === nidLower) {
				score += EXACT_MATCH_BONUS * 10 * joinedW;
			} else if (normLabel.startsWith(joined) || bareLabel.startsWith(joined) || labelTokens.startsWith(joined)) {
				score += PREFIX_MATCH_BONUS * 10 * joinedW;
			}
		}
		let matched = 0, tiered = 0;
		for (const t of normTerms) {
			const w = idf[t] || 1.0;
			if (t === normLabel || t === bareLabel) { tiered += EXACT_MATCH_BONUS * w; matched++; }
			else if (normLabel.startsWith(t) || bareLabel.startsWith(t)) { tiered += PREFIX_MATCH_BONUS * w; matched++; }
			else if (normLabel.includes(t)) { score += SUBSTRING_MATCH_BONUS * w; matched++; }
			if (source.includes(t)) score += SOURCE_MATCH_BONUS * w;
		}
		if (tiered) score += tiered * (matched / nTerms) ** 2;
		if (score > 0) scored.push([score, n.id]);
	}
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	scored.sort((a, b) => b[0] - a[0] || ((byId.get(a[1]).label || a[1]).length - (byId.get(b[1]).label || b[1]).length) || (a[1] < b[1] ? -1 : 1));
	return scored;
}

function pickSeeds(graph, scored, terms, adjDeg, maxK = 3, gapRatio = 0.2) {
	if (!scored.length) return [];
	const topScore = scored[0][0];
	const seeds = [];
	for (const [score, nid] of scored.slice(0, maxK)) {
		if (seeds.length && score < topScore * gapRatio) break;
		seeds.push(nid);
	}
	// per-term guaranteed seed, degree-broken ties
	const normTerms = [...new Set(terms.flatMap((t) => searchTokens(t)))].sort();
	for (const term of normTerms) {
		const termScored = scoreNodes(graph, [term]);
		if (!termScored.length) continue;
		const best = termScored[0][0];
		const tied = termScored.filter(([s]) => s === best).map(([, nid]) => nid);
		let bestNid = tied[0];
		if (tied.length > 1) for (const nid of tied) if ((adjDeg.get(nid) || 0) > (adjDeg.get(bestNid) || 0)) bestNid = nid;
		if (!seeds.includes(bestNid)) seeds.push(bestNid);
	}
	return seeds;
}

function pickScoredEndpoint(graph, scored, query) {
	const qtokens = new Set(searchTokens(query));
	if (!qtokens.size) return scored[0][1];
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	for (const [, nid] of scored) {
		const ltokens = new Set(searchTokens(byId.get(nid).label || nid));
		if ([...qtokens].every((t) => ltokens.has(t))) return nid;
	}
	return scored[0][1];
}

function undirectedNeighbors(graph) {
	const nbrs = new Map();
	const deg = new Map();
	for (const n of graph.nodes) { nbrs.set(n.id, new Set()); deg.set(n.id, 0); }
	for (const e of graph.edges) {
		if (!nbrs.has(e.source) || !nbrs.has(e.target) || e.source === e.target) continue;
		nbrs.get(e.source).add(e.target);
		nbrs.get(e.target).add(e.source);
	}
	for (const [id, s] of nbrs) deg.set(id, s.size);
	return { nbrs, deg };
}

function hubThreshold(deg) {
	const degrees = [...deg.values()].sort((a, b) => a - b);
	if (!degrees.length) return 50;
	const p99 = degrees[Math.min(degrees.length - 1, Math.floor(degrees.length * 0.99))];
	return Math.max(50, p99);
}

function traverse(graph, startNodes, depth, mode, contextFilter) {
	let edges = graph.edges;
	if (contextFilter && contextFilter.length) {
		const f = new Set(contextFilter);
		edges = edges.filter((e) => f.has(e.context));
	}
	const g = { nodes: graph.nodes, edges };
	const { nbrs, deg } = undirectedNeighbors(g);
	const hub = hubThreshold(deg);
	const seedSet = new Set(startNodes);
	const visited = new Set(startNodes);
	const edgesSeen = [];
	if (mode === "dfs") {
		visited.clear();
		const stack = startNodes.slice().reverse().map((n) => [n, 0]);
		while (stack.length) {
			const [node, d] = stack.pop();
			if (visited.has(node) || d > depth) continue;
			visited.add(node);
			if (!seedSet.has(node) && (deg.get(node) || 0) >= hub) continue;
			for (const nb of [...(nbrs.get(node) || [])].sort()) {
				if (!visited.has(nb)) { stack.push([nb, d + 1]); edgesSeen.push([node, nb]); }
			}
		}
	} else {
		let frontier = new Set(startNodes);
		for (let i = 0; i < depth; i++) {
			const next = new Set();
			for (const n of [...frontier].sort()) {
				if (!seedSet.has(n) && (deg.get(n) || 0) >= hub) continue;
				for (const nb of [...(nbrs.get(n) || [])].sort()) {
					if (!visited.has(nb)) { next.add(nb); edgesSeen.push([n, nb]); }
				}
			}
			for (const n of next) visited.add(n);
			frontier = next;
		}
	}
	return { visited, edgesSeen, edges, deg };
}

function edgeBetween(edges, u, v) {
	for (const e of edges) {
		if ((e.source === u && e.target === v) || (e.source === v && e.target === u)) return e;
	}
	return {};
}

function subgraphToText(graph, visited, edgesSeen, edges, deg, tokenBudget, seeds) {
	const charBudget = tokenBudget * 3;
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const lines = [];
	const seedSet = new Set(seeds || []);
	const ordered = (seeds || []).filter((s) => visited.has(s))
		.concat([...visited].filter((n) => !seedSet.has(n)).sort((a, b) => (deg.get(b) || 0) - (deg.get(a) || 0) || (a < b ? -1 : 1)));
	for (const nid of ordered) {
		const d = byId.get(nid) || {};
		lines.push(`NODE ${d.label || nid} [src=${d.source_file || ""} loc=${d.source_location || ""} community=${d.community_name != null ? d.community_name : (d.community != null ? d.community : "")}]`);
	}
	// index edges for fast lookup
	const eIdx = new Map();
	for (const e of edges) {
		eIdx.set(e.source + " " + e.target, e);
		if (!eIdx.has(e.target + " " + e.source)) eIdx.set(e.target + " " + e.source, e);
	}
	for (const [u, v] of edgesSeen) {
		if (!visited.has(u) || !visited.has(v)) continue;
		const e = eIdx.get(u + " " + v) || {};
		const ctx = e.context ? ` context=${e.context}` : "";
		lines.push(`EDGE ${(byId.get(u) || {}).label || u} --${e.relation || ""} [${e.confidence || ""}${ctx}]--> ${(byId.get(v) || {}).label || v}`);
	}
	let output = lines.join("\n");
	if (output.length > charBudget) {
		let cutAt = output.slice(0, charBudget).lastIndexOf("\n");
		if (cutAt <= 0) cutAt = charBudget;
		const totalNodes = lines.filter((l) => l.startsWith("NODE ")).length;
		const head = output.slice(0, cutAt);
		const shownNodes = (head.match(/\nNODE /g) || []).length + (head.startsWith("NODE ") ? 1 : 0);
		output = head + `\n... (truncated — ${totalNodes - shownNodes} more nodes cut by ~${tokenBudget}-token budget. Narrow with --context call or use kg explain for a specific symbol)`;
	}
	return output;
}

function findNode(graph, label) {
	const term = searchTokens(label).join(" ");
	if (!term) return [];
	const bySource = [], exact = [], prefix = [], substr = [];
	for (const n of graph.nodes) {
		const normLabel = nodeNormLabel(n);
		const tokens = searchTokens(n.label || "").join(" ");
		if ((n.source_file || "").toLowerCase() === label.toLowerCase()) bySource.push(n.id);
		else if (term === normLabel || term === tokens || term === n.id.toLowerCase()) exact.push(n.id);
		else if (normLabel.startsWith(term) || tokens.startsWith(term)) prefix.push(n.id);
		else if (normLabel.includes(term)) substr.push(n.id);
	}
	return [...bySource, ...exact, ...prefix, ...substr];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseFlags(args, valueFlags = []) {
	const flags = {}, positional = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const name = a.slice(2);
			if (valueFlags.includes(name) && i + 1 < args.length) { flags[name] = flags[name] ? [].concat(flags[name], args[++i]) : args[++i]; }
			else flags[name] = true;
		} else positional.push(a);
	}
	return { flags, positional };
}

function requireGraph(root) {
	const g = loadGraph(root);
	if (!g) {
		console.log("no graph — run `draht-tools kg build` first");
		return null;
	}
	return g;
}

const kgCommands = {};

kgCommands.build = function (root, args) {
	const { flags } = parseFlags(args, []);
	const t0 = Date.now();
	const graph = buildGraph(root);
	const jsonPath = writeGraph(root, graph);
	const reportPath = writeReport(root, graph);
	const codeNodes = graph.nodes.filter((n) => n.source_file).length;
	const byConf = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
	for (const e of graph.edges) byConf[e.confidence] = (byConf[e.confidence] || 0) + 1;
	if (!flags.quiet) {
		console.log(`kg build: ${graph.nodes.length} nodes (${codeNodes} in-repo) · ${graph.edges.length} edges · ${graph.communities.length} communities · ${Date.now() - t0}ms`);
		const pct = (k) => graph.edges.length ? Math.round((byConf[k] / graph.edges.length) * 100) : 0;
		console.log(`confidence: ${pct("EXTRACTED")}% EXTRACTED · ${pct("INFERRED")}% INFERRED · ${pct("AMBIGUOUS")}% AMBIGUOUS`);
		console.log(`→ ${jsonPath}\n→ ${reportPath}`);
	}
};

kgCommands.query = function (root, args) {
	const { flags, positional } = parseFlags(args, ["depth", "budget", "context"]);
	const question = positional.join(" ");
	if (!question) { console.log('usage: kg query "<question>" [--dfs] [--depth N] [--budget N] [--context C]'); return; }
	const graph = requireGraph(root);
	if (!graph) return;
	const terms = queryTerms(question);
	const scored = scoreNodes(graph, terms);
	const { deg } = undirectedNeighbors(graph);
	const seeds = pickSeeds(graph, scored, terms, deg);
	if (!seeds.length) { console.log("No matching nodes found."); return; }
	const mode = flags.dfs ? "dfs" : "bfs";
	const depth = Math.min(6, parseInt(flags.depth, 10) || 2);
	const budget = parseInt(flags.budget, 10) || 2000;
	const contextFilter = flags.context ? [].concat(flags.context) : null;
	const t = traverse(graph, seeds, depth, mode, contextFilter);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const headerParts = [`Traversal: ${mode.toUpperCase()} depth=${depth}`, `Start: [${seeds.map((s) => (byId.get(s) || {}).label || s).join(", ")}]`];
	if (contextFilter) headerParts.push(`Context: ${contextFilter.join(", ")}`);
	headerParts.push(`${t.visited.size} nodes found`);
	console.log(headerParts.join(" | ") + "\n");
	console.log(subgraphToText(graph, t.visited, t.edgesSeen, t.edges, t.deg, budget, seeds));
};

kgCommands.explain = function (root, args) {
	const { positional } = parseFlags(args, []);
	const label = positional.join(" ");
	if (!label) { console.log('usage: kg explain "<node>"'); return; }
	const graph = requireGraph(root);
	if (!graph) return;
	const matches = findNode(graph, label);
	if (!matches.length) { console.log(`No node matching '${label}' found.`); return; }
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const nid = matches[0];
	const d = byId.get(nid);
	const adj = buildAdjacency(graph);
	console.log(`Node: ${d.label || nid}`);
	console.log(`  ID:        ${nid}`);
	console.log(`  Source:    ${d.source_file || ""} ${d.source_location || ""}`.trimEnd());
	console.log(`  Type:      ${d.type || d.file_type || ""}`);
	console.log(`  Community: ${d.community_name != null ? d.community_name : (d.community != null ? d.community : "")}`);
	console.log(`  Degree:    ${adj.deg.get(nid) || 0}`);
	const connections = [];
	for (const e of adj.out.get(nid) || []) connections.push(["-->", e.target, e]);
	for (const e of adj.inn.get(nid) || []) connections.push(["<--", e.source, e]);
	if (connections.length) {
		console.log(`\nConnections (${connections.length}):`);
		connections.sort((a, b) => (adj.deg.get(b[1]) || 0) - (adj.deg.get(a[1]) || 0) || (a[1] < b[1] ? -1 : 1));
		for (const [arrow, nb, e] of connections.slice(0, 20)) {
			console.log(`  ${arrow} ${(byId.get(nb) || {}).label || nb} [${e.relation}] [${e.confidence}]`);
		}
		if (connections.length > 20) console.log(`  ... and ${connections.length - 20} more`);
	}
	if (d.rationale) console.log(`\nRationale: ${d.rationale.slice(0, 300)}`);
};

kgCommands.path = function (root, args) {
	const { positional } = parseFlags(args, []);
	if (positional.length < 2) { console.log('usage: kg path "<source>" "<target>"'); return; }
	const graph = requireGraph(root);
	if (!graph) return;
	const [srcLabel, tgtLabel] = [positional[0], positional[1]];
	const srcScored = scoreNodes(graph, srcLabel.toLowerCase().split(/\s+/));
	const tgtScored = scoreNodes(graph, tgtLabel.toLowerCase().split(/\s+/));
	if (!srcScored.length) { console.log(`No node matching '${srcLabel}' found.`); return; }
	if (!tgtScored.length) { console.log(`No node matching '${tgtLabel}' found.`); return; }
	const src = pickScoredEndpoint(graph, srcScored, srcLabel);
	const tgt = pickScoredEndpoint(graph, tgtScored, tgtLabel);
	if (src === tgt) { console.log(`'${srcLabel}' and '${tgtLabel}' both resolved to the same node '${src}'. Use a more specific label.`); return; }
	const { nbrs } = undirectedNeighbors(graph);
	// External module nodes (no source_file) are import hubs shared by everything —
	// a "path" through node:fs connects nothing meaningfully, so they can't be transit.
	const byIdT = new Map(graph.nodes.map((n) => [n.id, n]));
	const isTransit = (id) => id === src || id === tgt || Boolean((byIdT.get(id) || {}).source_file);
	const prev = new Map([[src, null]]);
	const q = [src];
	while (q.length) {
		const cur = q.shift();
		if (cur === tgt) break;
		if (!isTransit(cur)) continue;
		for (const nb of [...(nbrs.get(cur) || [])].sort()) {
			if (!prev.has(nb)) { prev.set(nb, cur); q.push(nb); }
		}
	}
	if (!prev.has(tgt)) { console.log(`No path found between '${srcLabel}' and '${tgtLabel}'.`); return; }
	const chain = [];
	for (let x = tgt; x != null; x = prev.get(x)) chain.unshift(x);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	// directed arrow recovery per hop
	const dirEdge = new Map();
	for (const e of graph.edges) dirEdge.set(e.source + " " + e.target, e);
	let line = (byId.get(chain[0]) || {}).label || chain[0];
	for (let i = 0; i < chain.length - 1; i++) {
		const fwd = dirEdge.get(chain[i] + " " + chain[i + 1]);
		const rev = dirEdge.get(chain[i + 1] + " " + chain[i]);
		const e = fwd || rev || {};
		const arrow = fwd ? `--${e.relation} [${e.confidence}]-->` : `<--${e.relation} [${e.confidence}]--`;
		line += ` ${arrow} ${(byId.get(chain[i + 1]) || {}).label || chain[i + 1]}`;
	}
	console.log(`Shortest path (${chain.length - 1} hops): ${line}`);
};

kgCommands.affected = function (root, args) {
	const { flags, positional } = parseFlags(args, ["depth", "relation"]);
	const label = positional.join(" ");
	if (!label) { console.log('usage: kg affected "<node>" [--depth N] [--relation R]'); return; }
	const graph = requireGraph(root);
	if (!graph) return;
	const matches = findNode(graph, label);
	if (!matches.length) { console.log(`No node matching '${label}' found.`); return; }
	const start = matches[0];
	const depth = parseInt(flags.depth, 10) || 2;
	const relations = new Set(flags.relation ? [].concat(flags.relation) : DEFAULT_AFFECTED_RELATIONS);
	// reverse traversal: who depends on start (edges pointing AT the affected set)
	const rin = new Map();
	for (const e of graph.edges) {
		if (!relations.has(e.relation)) continue;
		if (!rin.has(e.target)) rin.set(e.target, []);
		rin.get(e.target).push(e);
	}
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const hits = [];
	const seen = new Set([start]);
	let frontier = [start];
	for (let d = 1; d <= depth && frontier.length; d++) {
		const next = [];
		for (const nid of frontier) {
			for (const e of (rin.get(nid) || [])) {
				if (seen.has(e.source)) continue;
				seen.add(e.source);
				hits.push({ id: e.source, depth: d, via: e.relation });
				next.push(e.source);
			}
		}
		frontier = next;
	}
	console.log(`Affected by changes to '${(byId.get(start) || {}).label || start}' (depth ${depth}): ${hits.length} nodes`);
	let curDepth = 0;
	for (const h of hits) {
		if (h.depth !== curDepth) { curDepth = h.depth; console.log(`\n  depth ${curDepth}:`); }
		const n = byId.get(h.id) || {};
		console.log(`    ${n.label || h.id} [via ${h.via}] (${n.source_file || ""}${n.source_location ? ":" + n.source_location : ""})`);
	}
};

kgCommands.stats = function (root) {
	const graph = requireGraph(root);
	if (!graph) return;
	const byConf = {}, byRel = {};
	for (const e of graph.edges) {
		byConf[e.confidence] = (byConf[e.confidence] || 0) + 1;
		byRel[e.relation] = (byRel[e.relation] || 0) + 1;
	}
	console.log(`nodes: ${graph.nodes.length} · edges: ${graph.edges.length} · communities: ${graph.communities.length}`);
	console.log("confidence: " + Object.entries(byConf).sort().map(([k, v]) => `${k}=${v}`).join(" · "));
	console.log("relations:");
	for (const [k, v] of Object.entries(byRel).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
};

kgCommands.report = function (root) {
	const graph = requireGraph(root);
	if (!graph) return;
	console.log("→ " + writeReport(root, graph));
};

// ---------------------------------------------------------------------------
// KG_REPORT.md — graphify report.py section list
// ---------------------------------------------------------------------------

function writeReport(root, graph) {
	const adj = buildAdjacency(graph);
	const communities = graph.communities.length ? graph.communities : [];
	const gods = godNodes(graph, adj, 10);
	const surprises = surprisingConnections(graph, adj, 10);
	const cycles = importCycles(graph);
	const questions = suggestQuestions(graph, adj, communities, gods);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const byConf = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
	for (const e of graph.edges) byConf[e.confidence] = (byConf[e.confidence] || 0) + 1;
	const pct = (k) => graph.edges.length ? Math.round((byConf[k] / graph.edges.length) * 100) : 0;

	const L = [];
	L.push(`# Graph Report - ${path.basename(root)}`);
	L.push("");
	L.push("_Generated by `draht-tools kg build`. Do not edit; regenerated each build._");
	L.push("");
	L.push("## Summary");
	L.push("");
	L.push(`${graph.nodes.length} nodes · ${graph.edges.length} edges · ${communities.length} communities`);
	L.push("");
	L.push(`${pct("EXTRACTED")}% EXTRACTED · ${pct("INFERRED")}% INFERRED · ${pct("AMBIGUOUS")}% AMBIGUOUS`);
	L.push("");
	L.push("## Community Hubs (Navigation)");
	L.push("");
	for (const c of communities.slice(0, 15)) L.push(`- **${c.name}** — community ${c.id}, ${c.size} nodes, cohesion ${c.cohesion}`);
	L.push("");
	L.push("## God Nodes");
	L.push("");
	L.push("| Node | Degree | Source |");
	L.push("| --- | --- | --- |");
	for (const g of gods) L.push(`| \`${g.label}\` | ${g.degree} | ${g.source_file || "-"} |`);
	L.push("");
	L.push("## Surprising Connections");
	L.push("");
	if (surprises.length) {
		for (const s of surprises) L.push(`- \`${s.source}\` --${s.relation} [${s.confidence}]--> \`${s.target}\` (score ${s.score}): ${s.reasons.join("; ")}`);
	} else L.push("(none detected)");
	L.push("");
	L.push("## Import Cycles");
	L.push("");
	if (cycles.length) {
		for (const cyc of cycles) L.push(`- ${cyc.map((id) => (byId.get(id) || {}).label || id).join(" → ")}`);
	} else L.push("(none — no file-level import cycles)");
	L.push("");
	L.push("## Communities");
	L.push("");
	for (const c of communities) {
		if (c.size < 3) continue;
		const sample = (c.members || []).slice(0, 8).map((id) => (byId.get(id) || {}).label || id);
		L.push(`### ${c.name} (community ${c.id})`);
		L.push("");
		L.push(`${c.size} nodes · cohesion ${c.cohesion}`);
		if (sample.length) L.push(`Members: ${sample.map((s) => "`" + s + "`").join(", ")}${c.size > 8 ? " …" : ""}`);
		L.push("");
	}
	L.push("## Ambiguous Edges - Review These");
	L.push("");
	const amb = graph.edges.filter((e) => e.confidence === "AMBIGUOUS").slice(0, 15);
	if (amb.length) {
		for (const e of amb) L.push(`- \`${(byId.get(e.source) || {}).label || e.source}\` --${e.relation}--> \`${(byId.get(e.target) || {}).label || e.target}\` (${e.source_file || ""}${e.source_location ? ":" + e.source_location : ""})`);
	} else L.push("(none)");
	L.push("");
	L.push("## Knowledge Gaps");
	L.push("");
	const isolated = graph.nodes.filter((n) => (adj.deg.get(n.id) || 0) === 0 && n.source_file).slice(0, 10);
	if (isolated.length) {
		L.push(`Isolated nodes (${isolated.length} shown):`);
		for (const n of isolated) L.push(`- \`${n.label}\` (${n.source_file})`);
	} else L.push("(no isolated nodes)");
	L.push("");
	L.push("## Suggested Questions");
	L.push("");
	for (const q of questions) L.push(`- ${q}`);
	L.push("");
	L.push("---");
	L.push("Query the graph: `draht-tools kg query \"<question>\"` · `kg explain \"<node>\"` · `kg path \"<a>\" \"<b>\"` · `kg affected \"<node>\"` · `kg export tree|wiki|graphml`.");
	L.push("");
	const p = path.join(outDir(root), "KG_REPORT.md");
	const next = L.join("\n");
	let prev = null;
	try { prev = fs.readFileSync(p, "utf-8"); } catch { /* empty */ }
	if (prev !== next) fs.writeFileSync(p, next, "utf-8");
	return p;
}

// ---------------------------------------------------------------------------
// Exports: tree html / wiki / graphml
// ---------------------------------------------------------------------------

kgCommands.export = function (root, args) {
	const { flags, positional } = parseFlags(args, ["output"]);
	const format = positional[0];
	const graph = requireGraph(root);
	if (!graph) return;
	if (format === "tree") console.log("→ " + exportTree(root, graph, flags.output));
	else if (format === "wiki") console.log("→ " + exportWiki(root, graph));
	else if (format === "graphml") console.log("→ " + exportGraphml(root, graph, flags.output));
	else console.log("usage: kg export tree|wiki|graphml [--output path]");
};

function escapeHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function exportTree(root, graph, output) {
	// Hierarchy: directory → file → symbols, with descendant counts. Self-contained
	// vanilla-JS collapsible tree (offline parity with graphify's GRAPH_TREE.html).
	const tree = { name: path.basename(root), children: new Map(), symbols: [] };
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const fileSymbols = new Map();
	for (const e of graph.edges) {
		if (e.relation !== "contains" && e.relation !== "defines" && e.relation !== "method") continue;
		const src = byId.get(e.source), tgt = byId.get(e.target);
		if (!src || !tgt || !tgt.source_file) continue;
		if (!fileSymbols.has(tgt.source_file)) fileSymbols.set(tgt.source_file, new Set());
		fileSymbols.get(tgt.source_file).add(tgt.label);
	}
	const files = [...new Set(graph.nodes.filter((n) => n.source_file).map((n) => n.source_file))].sort();
	for (const rel of files) {
		let cur = tree;
		const parts = rel.split("/");
		for (let i = 0; i < parts.length - 1; i++) {
			if (!cur.children.has(parts[i])) cur.children.set(parts[i], { name: parts[i], children: new Map(), symbols: [] });
			cur = cur.children.get(parts[i]);
		}
		const leafName = parts[parts.length - 1];
		if (!cur.children.has(leafName)) cur.children.set(leafName, { name: leafName, children: new Map(), symbols: [...(fileSymbols.get(rel) || [])].sort() });
	}
	const toObj = (node) => ({ name: node.name, symbols: node.symbols || [], children: [...node.children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(toObj) });
	const data = toObj(tree);
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(path.basename(root))} — graph tree</title>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,monospace;font-size:13px;margin:0;padding:20px}
h1{font-size:15px;color:#58a6ff} .node{margin-left:18px} .lbl{cursor:pointer;padding:1px 4px;border-radius:4px}
.lbl:hover{background:#161b22} .dir>.lbl{color:#58a6ff} .file>.lbl{color:#c9d1d9} .sym{color:#7ee787;margin-left:36px}
.count{color:#8b949e;font-size:11px;margin-left:6px} .hidden{display:none}
button{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;cursor:pointer;margin-right:6px}
</style></head><body>
<h1>${escapeHtml(path.basename(root))} — module tree (${files.length} files)</h1>
<div><button id="expand">expand all</button><button id="collapse">collapse all</button></div>
<div id="tree"></div>
<script>
var DATA=${JSON.stringify(data)};
function count(n){var c=(n.symbols||[]).length;(n.children||[]).forEach(function(k){c+=1+count(k)});return c}
function render(n,el,depth){
  var d=document.createElement('div');d.className='node '+((n.children&&n.children.length)?'dir':'file');
  var l=document.createElement('div');l.className='lbl';l.textContent=(n.children&&n.children.length? '▸ ':'· ')+n.name;
  var c=document.createElement('span');c.className='count';c.textContent='('+count(n)+')';l.appendChild(c);
  d.appendChild(l);
  var kids=document.createElement('div');kids.className='kids'+(depth>1?' hidden':'');
  (n.children||[]).forEach(function(k){render(k,kids,depth+1)});
  (n.symbols||[]).forEach(function(s){var sd=document.createElement('div');sd.className='sym';sd.textContent=s;kids.appendChild(sd)});
  d.appendChild(kids);
  l.onclick=function(){kids.classList.toggle('hidden');l.textContent=(kids.classList.contains('hidden')?'▸ ':'▾ ')+n.name;l.appendChild(c)};
  el.appendChild(d);
}
render(DATA,document.getElementById('tree'),0);
document.getElementById('expand').onclick=function(){document.querySelectorAll('.kids').forEach(function(k){k.classList.remove('hidden')})};
document.getElementById('collapse').onclick=function(){document.querySelectorAll('.kids').forEach(function(k){k.classList.add('hidden')})};
</script></body></html>`;
	const p = output || path.join(outDir(root), "GRAPH_TREE.html");
	fs.writeFileSync(p, html, "utf-8");
	return p;
}

function slugify(s) {
	return normalizeId(s).replace(/_/g, "-").slice(0, 60) || "node";
}

function exportWiki(root, graph) {
	const dir = path.join(outDir(root), "kg-wiki");
	fs.mkdirSync(dir, { recursive: true });
	const adj = buildAdjacency(graph);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const gods = godNodes(graph, adj, 10);
	const communities = graph.communities;
	const idx = ["# Knowledge Graph Wiki", "", "_Generated by `draht-tools kg export wiki`._", "", "## Communities", ""];
	for (const c of communities) {
		if (c.size < 3) continue;
		idx.push(`- [${c.name}](community-${c.id}.md) — ${c.size} nodes, cohesion ${c.cohesion}`);
	}
	idx.push("", "## God Nodes", "");
	for (const g of gods) idx.push(`- [${g.label}](${slugify(g.label)}.md) — degree ${g.degree}`);
	fs.writeFileSync(path.join(dir, "index.md"), idx.join("\n") + "\n", "utf-8");

	for (const c of communities) {
		if (c.size < 3) continue;
		const L = [`# ${c.name}`, "", `Community ${c.id} · ${c.size} nodes · cohesion ${c.cohesion}`, "", "## Key Concepts", ""];
		const members = (c.members || []).map((id) => byId.get(id)).filter(Boolean);
		members.sort((a, b) => (adj.deg.get(b.id) || 0) - (adj.deg.get(a.id) || 0) || (a.id < b.id ? -1 : 1));
		for (const m of members.slice(0, 15)) L.push(`- \`${m.label}\` (${m.source_file || "external"}${m.source_location ? ":" + m.source_location : ""})`);
		L.push("", "## Source Files", "");
		for (const f of [...new Set(members.map((m) => m.source_file).filter(Boolean))].sort().slice(0, 20)) L.push(`- ${f}`);
		L.push("", "## Connections by Relation", "");
		const memberSet = new Set(c.members || []);
		const byRel = new Map();
		for (const e of graph.edges) {
			if (!memberSet.has(e.source) && !memberSet.has(e.target)) continue;
			if (!byRel.has(e.relation)) byRel.set(e.relation, []);
			if (byRel.get(e.relation).length < 10) byRel.get(e.relation).push(e);
		}
		for (const [rel, es] of [...byRel.entries()].sort()) {
			L.push(`### ${rel}`, "");
			for (const e of es) L.push(`- \`${(byId.get(e.source) || {}).label || e.source}\` → \`${(byId.get(e.target) || {}).label || e.target}\` [${e.confidence}]`);
			L.push("");
		}
		fs.writeFileSync(path.join(dir, `community-${c.id}.md`), L.join("\n") + "\n", "utf-8");
	}
	for (const g of gods) {
		const L = [`# ${g.label}`, "", `Degree ${g.degree} · ${g.source_file || ""}`, "", "## Relationships", ""];
		const conns = (adj.out.get(g.id) || []).map((e) => ["→", e.target, e]).concat((adj.inn.get(g.id) || []).map((e) => ["←", e.source, e]));
		conns.sort((a, b) => (adj.deg.get(b[1]) || 0) - (adj.deg.get(a[1]) || 0));
		for (const [arrow, nb, e] of conns.slice(0, 30)) L.push(`- ${arrow} \`${(byId.get(nb) || {}).label || nb}\` [${e.relation}] [${e.confidence}]`);
		L.push("", "## Audit Trail", "", `Extraction: deterministic (draht-tools kg). Source: ${g.source_file || "-"}.`);
		fs.writeFileSync(path.join(dir, `${slugify(g.label)}.md`), L.join("\n") + "\n", "utf-8");
	}
	return dir;
}

function exportGraphml(root, graph, output) {
	const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const L = ['<?xml version="1.0" encoding="UTF-8"?>',
		'<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
		'<key id="label" for="node" attr.name="label" attr.type="string"/>',
		'<key id="source_file" for="node" attr.name="source_file" attr.type="string"/>',
		'<key id="community" for="node" attr.name="community" attr.type="int"/>',
		'<key id="relation" for="edge" attr.name="relation" attr.type="string"/>',
		'<key id="confidence" for="edge" attr.name="confidence" attr.type="string"/>',
		'<graph edgedefault="directed">'];
	for (const n of graph.nodes) {
		L.push(`<node id="${esc(n.id)}"><data key="label">${esc(n.label)}</data><data key="source_file">${esc(n.source_file || "")}</data><data key="community">${n.community != null ? n.community : -1}</data></node>`);
	}
	for (const e of graph.edges) {
		L.push(`<edge source="${esc(e.source)}" target="${esc(e.target)}"><data key="relation">${esc(e.relation)}</data><data key="confidence">${esc(e.confidence)}</data></edge>`);
	}
	L.push("</graph></graphml>");
	const p = output || path.join(outDir(root), "graph.graphml");
	fs.writeFileSync(p, L.join("\n"), "utf-8");
	return p;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KG_HELP = `draht-kg — graphify-parity symbol-level knowledge graph (deterministic, no LLM)

Usage: draht-tools kg <command> [args]

  build [--quiet]                 Index the repo → .planning/codebase/graph.json + KG_REPORT.md
  query "<question>" [--dfs] [--depth N] [--budget N] [--context C]
                                  BFS/DFS subgraph traversal from scored seeds (NODE/EDGE output)
  explain "<node>"                Node dump: id, source, community, degree, connections
  path "<a>" "<b>"                Shortest path with directed arrows and confidence
  affected "<node>" [--depth N] [--relation R]
                                  Reverse blast-radius over calls/imports/inherits/…
  stats                           Node/edge/relation/confidence counts
  report                          Regenerate KG_REPORT.md
  export tree|wiki|graphml        GRAPH_TREE.html / kg-wiki/ / graph.graphml

Nodes are symbols (files, classes, functions(), methods(), types); edges carry
graphify's relation set with EXTRACTED/INFERRED/AMBIGUOUS confidence. graph.json
is node-link format, directed — loadable by graphify's own tooling.`;

function kgMain(argv) {
	const [cmd, ...args] = argv;
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(KG_HELP); return 0; }
	if (!kgCommands[cmd]) { console.error(`unknown kg command: ${cmd}\n`); console.log(KG_HELP); return 1; }
	const root = findRepoRoot(process.cwd());
	kgCommands[cmd](root, args);
	return 0;
}

module.exports = { kgMain, buildGraph, writeGraph, loadGraph, queryTerms, scoreNodes, normalizeId, makeId, KG_HELP };

if (require.main === module) {
	process.exit(kgMain(process.argv.slice(2)));
}
