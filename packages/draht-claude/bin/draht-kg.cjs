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
 *  - serve.py          → query stopwords, label scoring for `path` endpoints,
 *                        BFS/DFS with hub guard, NODE/EDGE output (`query` ranks
 *                        files itself: rankFiles)
 *  - affected.py       → reverse traversal over the default relation set
 *  - analyze.py        → god nodes, surprising connections, suggested questions,
 *                        import cycles
 *  - cluster.py        → deterministic communities + cohesion + hub labels
 *  - report.py         → KG_REPORT.md section list
 *  - extract.py        → node/edge emission contract (hand-written scanners per
 *                        language stand in for tree-sitter)
 *
 * A Go port of this file lives in go/internal/kg (the `kg` command of the
 * `draht-graph` binary, which draht-tools.cjs prefers when one is installed).
 * The two must stay identical in output: go/internal/kg/parity_test.go compares
 * graph.json, reports, exports and every subcommand's output byte for byte, so
 * a change here needs the same change there.
 *
 * Zero runtime dependencies; Node >= 20. Loaded by draht-tools.cjs (`kg` command)
 * and runnable standalone: `node draht-kg.cjs build`.
 */

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
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

// Methods the languages' own objects have (arrays, strings, maps, promises,
// streams, emitters, dicts, files): a call to one of these on a receiver of
// unknown type says nothing about a repo class that happens to declare the
// same name.
const COMMON_METHOD_NAMES = new Set([
	"push", "pop", "shift", "unshift", "map", "filter", "reduce", "forEach", "find", "findIndex", "findLast", "some", "every", "includes",
	"indexOf", "lastIndexOf", "join", "split", "slice", "splice", "concat", "sort", "reverse", "keys", "values", "entries", "get", "set",
	"has", "delete", "add", "clear", "then", "catch", "finally", "toString", "valueOf", "toJSON", "trim", "trimStart", "trimEnd", "replace",
	"replaceAll", "match", "matchAll", "test", "exec", "startsWith", "endsWith", "padStart", "padEnd", "toLowerCase", "toUpperCase",
	"substring", "substr", "charAt", "charCodeAt", "codePointAt", "flat", "flatMap", "fill", "from", "call", "apply", "bind", "on", "off",
	"once", "emit", "addEventListener", "removeEventListener", "dispatchEvent", "addListener", "removeListener", "log", "error", "warn",
	"info", "debug", "trace", "write", "read", "end", "close", "open", "send", "next", "return", "throw", "resolve", "reject", "parse",
	"stringify", "assign", "freeze", "append", "remove", "update", "insert", "extend", "items", "copy", "format", "encode", "decode",
	"strip", "lstrip", "rstrip", "lower", "upper", "count", "index", "json", "text", "blob", "arrayBuffer", "abort", "cancel", "destroy",
	"pipe", "unref", "ref", "kill", "exit", "start", "stop", "run", "reset", "init", "setup", "render", "focus", "blur", "click",
	"toFixed", "toISOString", "getTime", "localeCompare", "normalize", "repeat", "search", "isdigit", "isalpha", "splitlines", "title",
	"setdefault", "popitem", "discard", "union", "intersection", "difference", "seek", "tell", "flush", "readline", "readlines", "writelines",
	"subscribe", "unsubscribe", "connect", "disconnect", "listen", "getAttribute", "setAttribute", "querySelector", "querySelectorAll",
	"appendChild", "removeChild", "preventDefault", "stopPropagation", "toBe", "toEqual", "mockReturnValue", "mockResolvedValue",
	"address", "clone", "formData", "getReader", "releaseLock", "enqueue", "terminate", "postMessage", "toLocaleString", "getItem",
	"setItem", "removeItem", "command", "option", "argument", "group", "route", "headers", "status", "redirect", "cookie", "header",
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

// Method name → node id for one class. makeId drops `_`, `$` and `#`, so
// `close()` / `#close()` or `load()` / `_load()` in one class would share
// an id and the second declaration would vanish. graphify's rule
// (extractors/engine.py _underscore_salted_nid, _js_member_nid): the one
// public name of such a group keeps the plain id, every other name gets a
// suffix taken from its own name, so the result never depends on declaration
// order. Accessor pairs and overloads are one name, not a collision. Applies
// where graphify's ids were checked: JS/TS and Python.
const PRIVATE_MEMBER_PREFIX = { js: /^[_$#]/, py: /^_/, go: /^[^A-Z]/ };
function methodNodeIds(rel, cls, lang) {
	const privatePrefix = PRIVATE_MEMBER_PREFIX[LANG_FAMILY[lang]];
	const groups = new Map(); // plain id -> distinct names
	for (const meth of cls.methods) {
		const id = makeId(fileStem(rel), cls.name, meth.name);
		if (!groups.has(id)) groups.set(id, new Set());
		groups.get(id).add(meth.name);
	}
	const ids = new Map();
	for (const [id, names] of groups) {
		const isPublic = privatePrefix ? [...names].filter((n) => !privatePrefix.test(n)) : [];
		for (const name of names) {
			const plain = !privatePrefix || names.size < 2 || (isPublic.length === 1 && name === isPublic[0]);
			ids.set(name, plain ? id : makeId(id, crypto.createHash("sha1").update(name, "utf8").digest("hex").slice(0, 6)));
		}
	}
	return ids;
}

// File-level names → node ids, by the same rule: names of one file that would
// share an id (Go's `ResponseWriter` / `responseWriter`, a class and a
// same-named constant in another case) each get their own.
function fileSymbolIds(rel, names, lang) {
	const privatePrefix = PRIVATE_MEMBER_PREFIX[LANG_FAMILY[lang]];
	const groups = new Map();
	for (const name of names) {
		const id = symbolNodeId(rel, name);
		if (!groups.has(id)) groups.set(id, new Set());
		groups.get(id).add(name);
	}
	const ids = new Map();
	for (const [id, set] of groups) {
		const isPublic = privatePrefix ? [...set].filter((n) => !privatePrefix.test(n)) : [];
		for (const name of set) {
			const plain = set.size < 2 || (isPublic.length === 1 && name === isPublic[0]);
			ids.set(name, plain ? id : makeId(id, crypto.createHash("sha1").update(name, "utf8").digest("hex").slice(0, 6)));
		}
	}
	return ids;
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

// Paths ordered by their "/"-normalized form. Sorting the OS form would order
// `a\b.ts` against `a0.ts` differently from `a/b.ts` (backslash sorts after
// digits and capitals, slash before), and the first file wins an id collision
// — so the same repo must not index differently per OS.
function sortByPosixPath(paths, sep = path.sep) {
	return paths
		.map((p) => [sep === "/" ? p : p.split(sep).join("/"), p])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map((x) => x[1]);
}

// Code files of a git checkout: tracked files and untracked ones git does not
// ignore, so a tracked dot-directory counts and ignored build output does
// not. Null outside a git checkout (or without git): the directory walk and
// its ignore list take over. A checkout with no code file of its own is an
// empty list, not null: the walk would read what git ignores.
function gitFiles(root, maxFiles) {
	if (!fs.existsSync(path.join(root, ".git"))) return null;
	let out;
	try {
		const r = childProcess.spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf-8", maxBuffer: 1 << 28 });
		if (r.status !== 0 || typeof r.stdout !== "string") return null;
		out = r.stdout;
	} catch { return null; }
	const files = [];
	for (const rel of out.split("\0")) {
		if (!rel || rel.endsWith("/") || !KG_LANG_BY_EXT[path.extname(rel).toLowerCase()]) continue;
		const parts = rel.split("/");
		if (parts.includes("node_modules") || parts.includes(".git")) continue;
		const full = path.join(root, ...parts);
		try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
		files.push(full);
		if (files.length >= maxFiles) break;
	}
	return sortByPosixPath(files);
}

// Write through a temporary file in the same directory and rename it into
// place: an interrupted build leaves the previous file whole, and a reader
// never sees a half-written one. The temporary name is short and does not
// build on the target's, which may already be as long as a name can be.
function writeFileAtomic(file, data) {
	const tmp = path.join(path.dirname(file), ".kg-" + process.pid + ".tmp");
	try {
		fs.writeFileSync(tmp, data, "utf-8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* empty */ }
		throw err;
	}
}

function walk(root, maxFiles = 20000) {
	const tracked = gitFiles(root, maxFiles);
	if (tracked) return tracked;
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
	return sortByPosixPath(files);
}

// ============================================================================
// Source masking — ONE lexer pass (comments, strings, templates, regex literals)
// ============================================================================

// Keywords after which a `/` starts a regex literal instead of dividing.
const REGEX_PREV_WORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
	"case", "do", "else", "yield", "await",
]);
// Punctuation after which an expression may start (so `/` opens a regex).
const REGEX_PREV_CHARS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";"]);

// Comments and string/regex/template TEXT become spaces — same length, same
// line breaks — so offsets, line numbers and indentation survive. Quote
// delimiters stay, and so does the code inside a template's `${ … }`
// (nested templates included). One pass decides what each character is: a
// `"src/*"` string cannot open a comment, a backtick inside a string or regex
// cannot open a template, and a `//` in a URL string is not a comment, which
// separate comment-then-string passes cannot guarantee across lines.
// Python: `#` comments and ''' / """ strings. Go: raw backtick strings and
// runes. Rust: nested block comments, raw strings, chars (a lifetime `'a` is
// not one). When `multiline` is an array, [start, end] offset pairs of
// multi-line (triple-quoted) strings are appended to it.
function maskSource(src, lang, multiline) {
	const js = TS_LIKE.has(lang), py = lang === "python", go = lang === "go", rust = lang === "rust";
	const n = src.length;
	const out = [];
	let flushed = 0;
	const blank = (a, b) => {
		if (b <= a) return;
		out.push(src.slice(flushed, a), src.slice(a, b).replace(/[^\r\n]/g, " "));
		flushed = b;
	};
	const eol = (from) => { const e = src.indexOf("\n", from); return e < 0 ? n : e; };
	const tplDepth = []; // brace depth inside each open `${ … }`
	let sig = -1; // index of the last significant code character

	// Opening quote at `start`; returns the index after the closing quote.
	// An unterminated single-line string ends at its line break.
	const scanString = (start, quote, multi) => {
		let j = start + 1;
		while (j < n) {
			const ch = src[j];
			if (ch === "\\") { j += src[j + 1] === "\r" && src[j + 2] === "\n" ? 3 : 2; continue; }
			if (ch === quote) { blank(start + 1, j); return j + 1; }
			if (ch === "\n" && !multi) break;
			j++;
		}
		j = Math.min(j, n);
		blank(start + 1, j);
		return j;
	};
	const scanPyString = (start, quote) => {
		if (src[start + 1] !== quote || src[start + 2] !== quote) return scanString(start, quote, false);
		let j = start + 3;
		while (j < n) {
			if (src[j] === "\\") { j += 2; continue; }
			if (src[j] === quote && src[j + 1] === quote && src[j + 2] === quote) {
				blank(start + 3, j);
				if (multiline) multiline.push(start, j + 3);
				return j + 3;
			}
			j++;
		}
		blank(start + 3, n);
		if (multiline) multiline.push(start, n);
		return n;
	};
	const scanRaw = (start, close) => {
		const e = src.indexOf(close, start + 1);
		const end = e < 0 ? n : e;
		blank(start + 1, end);
		return e < 0 ? n : e + close.length;
	};
	// Go rune / Rust char literal; -1 when the quote is not one (a Rust lifetime).
	const scanChar = (start) => {
		if (src[start + 1] === "\\") {
			const e = src.indexOf("'", start + 3);
			return e > 0 && e - start <= 12 && !src.slice(start, e).includes("\n") ? e + 1 : -1;
		}
		const hi = src.charCodeAt(start + 1);
		const close = hi >= 0xd800 && hi <= 0xdbff ? start + 3 : start + 2;
		return src[close] === "'" && src[start + 1] !== "\n" ? close + 1 : -1;
	};
	const scanBlock = (start) => {
		let depth = 1, j = start + 2;
		while (j < n && depth) {
			if (rust && src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; }
			else if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; }
			else j++;
		}
		j = Math.min(j, n);
		blank(start, j);
		return j;
	};
	// Template text from `from` (after the opening backtick or a closing `}`)
	// up to the closing backtick or the next `${`.
	const scanTemplate = (from) => {
		let j = from;
		while (j < n) {
			const ch = src[j];
			if (ch === "\\") { j += 2; continue; }
			if (ch === "`") { blank(from, j); sig = j; return j + 1; }
			if (ch === "$" && src[j + 1] === "{") { blank(from, j + 2); tplDepth.push(0); return j + 2; }
			j++;
		}
		blank(from, n);
		return n;
	};
	const regexAllowed = (at) => {
		let k = at - 1;
		while (k >= 0 && (src[k] === " " || src[k] === "\t")) k--;
		if (k < 0 || src[k] === "\n" || src[k] === "\r") return true; // first token on its line
		if (sig < 0) return true;
		const p = src[sig];
		if (isIdentChar(p)) {
			let s = sig;
			while (s > 0 && isIdentChar(src[s - 1])) s--;
			return REGEX_PREV_WORDS.has(src.slice(s, sig + 1));
		}
		if (p === ">") return src[sig - 1] === "="; // `=>`
		return REGEX_PREV_CHARS.has(p);
	};
	// Regex literal opening at `start`; returns the index after its flags, or
	// -1 when the line has no closing slash (so it was a division).
	const scanRegex = (start) => {
		let j = start + 1, inClass = false;
		while (j < n) {
			const ch = src[j];
			if (ch === "\n") return -1;
			if (ch === "\\") { j += 2; continue; }
			if (inClass) { if (ch === "]") inClass = false; }
			else if (ch === "[") inClass = true;
			else if (ch === "/") {
				if (j === start + 1) return -1;
				blank(start + 1, j);
				let e = j + 1;
				while (e < n && /[A-Za-z]/.test(src[e])) e++;
				return e;
			}
			j++;
		}
		return -1;
	};

	let i = 0;
	if (src.startsWith("#!")) { i = eol(0); blank(0, i); }
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
		if (isIdentChar(c)) {
			let j = i + 1;
			while (j < n && isIdentChar(src[j])) j++;
			if (rust && (src[j] === '"' || src[j] === "#") && (src.slice(i, j) === "r" || src.slice(i, j) === "br")) {
				let h = j;
				while (src[h] === "#") h++;
				if (src[h] === '"') {
					i = scanRaw(h, '"' + "#".repeat(h - j));
					sig = h;
					continue;
				}
			}
			sig = j - 1;
			i = j;
			continue;
		}
		if (c === "/" && !py) {
			const d = src[i + 1];
			if (d === "/") { const e = eol(i); blank(i, e); i = e; continue; }
			if (d === "*") { i = scanBlock(i); continue; }
			if (js && regexAllowed(i)) {
				const e = scanRegex(i);
				if (e > 0) { sig = i; i = e; continue; }
			}
		} else if (py && c === "#") {
			const e = eol(i);
			blank(i, e);
			i = e;
			continue;
		} else if (c === '"' || (c === "'" && !rust && !go)) {
			const start = i;
			i = py ? scanPyString(i, c) : scanString(i, c, rust);
			sig = start;
			continue;
		} else if (c === "'" && (rust || go)) {
			const e = scanChar(i);
			if (e > 0) { blank(i + 1, e - 1); sig = i; i = e; continue; }
		} else if (c === "`" && js) {
			i = scanTemplate(i + 1);
			continue;
		} else if (c === "`" && go) {
			const start = i;
			i = scanRaw(i, "`");
			sig = start;
			continue;
		} else if (js && tplDepth.length && (c === "{" || c === "}")) {
			if (c === "{") tplDepth[tplDepth.length - 1]++;
			else if (tplDepth[tplDepth.length - 1] === 0) {
				tplDepth.pop();
				blank(i, i + 1);
				i = scanTemplate(i + 1);
				continue;
			} else tplDepth[tplDepth.length - 1]--;
		}
		sig = i;
		i++;
	}
	out.push(src.slice(flushed));
	return out.join("");
}

// Offset ranges of interface bodies and type-alias right-hand sides in masked
// TypeScript. Calls cannot occur there, so their member signatures
// (`save(): number;`) must not be scanned as call sites.
function typeDeclRanges(masked) {
	const n = masked.length;
	const ranges = [];
	const declRe = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(interface|type)\s+[A-Za-z_$][\w$]*/gm;
	let m;
	while ((m = declRe.exec(masked)) !== null) {
		let j = declRe.lastIndex;
		// Generic parameters and heritage clauses may hold braces and `=>`.
		let angle = 0;
		if (m[1] === "interface") {
			for (; j < n; j++) {
				const ch = masked[j];
				if (ch === "<") angle++;
				else if (ch === ">" && masked[j - 1] !== "=") angle = Math.max(0, angle - 1);
				else if ((ch === "{" && !angle) || ch === ";") break;
			}
			if (masked[j] !== "{") continue;
			let depth = 0, k = j;
			for (; k < n; k++) {
				if (masked[k] === "{") depth++;
				else if (masked[k] === "}" && --depth === 0) break;
			}
			ranges.push([j + 1, Math.min(k, n)]);
			declRe.lastIndex = Math.max(declRe.lastIndex, Math.min(k, n));
			continue;
		}
		for (; j < n; j++) {
			const ch = masked[j];
			if (ch === "<") angle++;
			else if (ch === ">" && masked[j - 1] !== "=") angle = Math.max(0, angle - 1);
			else if (!angle && !/\s/.test(ch)) break;
		}
		if (masked[j] !== "=") continue;
		const rhs = ++j;
		let depth = 0;
		for (; j < n; j++) {
			const ch = masked[j];
			if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") { if (--depth < 0) break; }
			else if (ch === ">") { if (masked[j - 1] !== "=") depth = Math.max(0, depth - 1); }
			else if (ch === ";" && !depth) break;
			else if (ch === "\n" && !depth) {
				// A line break ends the alias unless the type visibly goes on.
				let p = j - 1;
				while (p > rhs && /\s/.test(masked[p])) p--;
				let q = j + 1;
				while (q < n && /\s/.test(masked[q])) q++;
				if (!"=|&?:,<(".includes(masked[p]) && !"|&?:.)".includes(masked[q] || "") && !(masked[p] === ">" && masked[p - 1] === "=")) break;
			}
		}
		ranges.push([rhs, Math.min(j, n)]);
		declRe.lastIndex = Math.max(declRe.lastIndex, Math.min(j, n));
	}
	return ranges;
}

// `text` with the given [start, end) ranges turned to spaces (line breaks kept).
function blankRanges(text, ranges) {
	if (!ranges.length) return text;
	const out = [];
	let at = 0;
	for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0] || y[1] - x[1])) {
		if (a < at) continue;
		out.push(text.slice(at, a), text.slice(a, b).replace(/[^\r\n]/g, " "));
		at = b;
	}
	out.push(text.slice(at));
	return out.join("");
}

// Line number (1-based) of a character offset, via precomputed line starts.
function lineIndex(content) {
	const starts = [0];
	for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
	return (idx) => {
		let lo = 0, hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
		}
		return lo + 1;
	};
}

// ============================================================================
// Per-language declaration extraction (phase 1)
// ============================================================================

const MAX_SYMBOLS_PER_FILE = 5000;
// Methods one class keeps. A class that declares more is named in the
// `kg build` output instead of losing the rest silently.
const MAX_METHODS_PER_CLASS = 1000;

// Python words that start a statement which is not an assignment.
const PY_STATEMENT_WORDS = new Set([
	"if", "elif", "else", "try", "except", "finally", "for", "while", "with", "def", "class", "return", "import", "from",
	"lambda", "pass", "raise", "global", "nonlocal", "assert", "del", "async", "await", "match", "case", "yield", "not", "print",
]);
const TS_EXPRESSION_WORDS = new Set([
	"return", "throw", "typeof", "void", "await", "yield", "new", "delete", "import",
	"super", "this", "case", "catch", "do", "else", "try", "in", "instanceof",
]);

// Adds a method to its class; false (and counted) past the limit.
function addMethod(cls, meth) {
	if (cls.methods.length >= MAX_METHODS_PER_CLASS) {
		cls.methodsOverLimit = (cls.methodsOverLimit || 0) + 1;
		return false;
	}
	cls.methods.push(meth);
	return true;
}
function isIdentChar(c) {
	return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";
}
// `implements A, B<T>, ns.C` (text up to the body brace) → ["A", "B", "ns"]:
// generic arguments removed, then each item's leading identifier.
function implementsList(text) {
	let s = text || "";
	while (/<[^<>]*>/.test(s)) s = s.replace(/<[^<>]*>/g, "");
	return s.split(",").map((x) => (x.trim().match(/^[A-Za-z_$][\w$]*/) || [""])[0]).filter(Boolean);
}
// ============================================================================
// Bracket helpers (masked text)
// ============================================================================

// Index of the bracket that closes the one at `open`, or -1.
function matchClose(text, open) {
	const o = text[open];
	const c = o === "{" ? "}" : o === "(" ? ")" : o === "[" ? "]" : o === "<" ? ">" : null;
	if (!c) return -1;
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === o) depth++;
		else if (ch === c && --depth === 0) return i;
	}
	return -1;
}

// The names a TS/JS parameter list binds, each with its written type name
// (or null): `a`, `b?: Type`, `...rest`, `{ c, d: e }`. A type (`x: Foo | Bar`)
// and a default value (`cb = log`) bind nothing. The list may be cut short
// (the callers stop at the first `)`).
function paramBindings(list) {
	const out = [];
	let depth = 0, angle = 0, from = 0;
	for (let i = 0; i <= list.length; i++) {
		const ch = list[i];
		if (i < list.length && !(ch === "," && depth === 0 && angle === 0)) {
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === "<") angle++;
			else if (ch === ">" && list[i - 1] !== "=") angle = Math.max(0, angle - 1);
			continue;
		}
		const piece = list.slice(from, i);
		from = i + 1;
		const m = piece.match(/^\s*(?:\.\.\.)?\s*(?:(?:public|private|protected|readonly|override)\s+)*([A-Za-z_$][\w$]*)\??\s*(?::\s*([A-Za-z_$][\w$.]*))?/);
		if (m) { out.push([m[1], m[2] || null]); continue; }
		const open = piece.search(/[^\s.]/);
		if (open < 0 || (piece[open] !== "{" && piece[open] !== "[")) continue;
		const close = matchClose(piece, open);
		for (const id of piece.slice(open + 1, close < 0 ? piece.length : close).matchAll(/(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)/g)) out.push([id[1], null]);
	}
	return out;
}

// Pieces of `text` split at commas outside every bracket.
function splitTopLevel(text) {
	const out = [];
	let depth = 0, from = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
	}
	out.push(text.slice(from));
	return out;
}

// ============================================================================
// Go declarations
// ============================================================================

const GO_TYPE_WORDS = new Set(["func", "map", "chan", "struct", "interface"]);
const GO_CALL_SKIP = new Set([
	"if", "for", "switch", "select", "return", "func", "go", "defer", "range", "case", "else", "var", "const", "type",
	"make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover", "close", "print", "println", "min", "max", "clear",
	"string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "byte", "rune",
	"float32", "float64", "complex64", "complex128", "bool", "error", "any",
]);

// A Go type expression reduced to the name a method is looked up on:
// `*pkg.T[K]` → "pkg.T"; `[]T` and `...T` → "[]T" (the elements are T). Null for
// maps, channels, function types and type literals.
function goTypeName(expr) {
	let t = String(expr || "").trim();
	let slice = false;
	for (;;) {
		if (t.startsWith("*")) t = t.slice(1).trim();
		else if (t.startsWith("...")) { slice = true; t = t.slice(3).trim(); }
		else if (t.startsWith("[")) {
			const e = matchClose(t, 0);
			if (e < 0) return null;
			slice = true;
			t = t.slice(e + 1).trim();
		} else break;
	}
	if (t.startsWith("map[")) {
		const e = matchClose(t, 3);
		const v = e > 0 ? goTypeName(t.slice(e + 1)) : null;
		return v ? "[]" + v.replace(/^\[\]/, "") : null;
	}
	const m = t.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
	if (!m || GO_TYPE_WORDS.has(m[1])) return null;
	return (slice ? "[]" : "") + m[1];
}

// `a, b int, c *T` → [{ name, type }], with Go's shared-type grouping. A list
// of bare types (unnamed parameters) gives [].
function goParams(text) {
	const out = [];
	let pending = [];
	for (const raw of splitTopLevel(text)) {
		const piece = raw.trim();
		if (!piece) continue;
		const m = piece.match(/^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/);
		if (m && !GO_TYPE_WORDS.has(m[1])) {
			const type = goTypeName(m[2]);
			for (const n of pending) out.push({ name: n, type });
			pending = [];
			out.push({ name: m[1], type });
		} else if (/^[A-Za-z_]\w*$/.test(piece)) pending.push(piece);
		else pending = [];
	}
	return out;
}

// The first result type of a signature's result text (`*T`, `(T, error)`,
// `(x T, err error)`).
function goFirstResult(text) {
	let t = String(text || "").trim();
	if (!t) return null;
	if (t.startsWith("(")) {
		const e = matchClose(t, 0);
		const first = (splitTopLevel(t.slice(1, e < 0 ? t.length : e))[0] || "").trim();
		const m = first.match(/^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/);
		t = m && !GO_TYPE_WORDS.has(m[1]) ? m[2] : first;
	}
	return goTypeName(t);
}

// Top-level Go declarations from masked source: functions and methods with
// receiver, parameter and result types; named types (struct fields and
// embedded types included); package-level constants and variables, single or
// in `( … )` groups. Offsets index `masked`.
function parseGoDecls(d, masked, lineOf) {
	const pm = masked.match(/^package\s+([A-Za-z_]\w*)/m);
	d.goPackage = pm ? pm[1] : "";
	d.goMethods = [];
	d.goVars = new Map(); // name -> { type, init }
	const n = masked.length;

	const addType = (name, at, rest, restAt) => {
		// generic parameters, then an optional alias `=`
		let r = rest, rAt = restAt;
		const lead = r.match(/^\s*/)[0].length;
		r = r.slice(lead); rAt += lead;
		if (r.startsWith("[")) {
			const e = matchClose(masked, rAt);
			// `type A [4]int` is an array type, not generics: generics hold an identifier pair
			if (e > 0 && /^\[\s*[A-Za-z_]\w*\s+[^\]]/.test(masked.slice(rAt, e + 1))) {
				rAt = e + 1;
				r = masked.slice(rAt, masked.indexOf("\n", rAt) < 0 ? n : masked.indexOf("\n", rAt));
				const l2 = r.match(/^\s*/)[0].length;
				r = r.slice(l2); rAt += l2;
			}
		}
		if (r.startsWith("=")) { const l3 = r.slice(1).match(/^\s*/)[0].length + 1; r = r.slice(l3); rAt += l3; }
		const kind = /^struct\b/.test(r) ? "struct" : /^interface\b/.test(r) ? "interface" : "type";
		const cls = { name, line: lineOf(at), end: null, kind, extends: null, implements: [], methods: [], fields: new Map(), embeds: [], bodyStart: -1, bodyEnd: -1 };
		if (kind !== "type") {
			const open = masked.indexOf("{", rAt);
			const close = open >= 0 ? matchClose(masked, open) : -1;
			if (open >= 0 && close > open) {
				cls.bodyStart = open; cls.bodyEnd = close; cls.end = lineOf(close);
				let depth = 0, lineStart = open + 1;
				for (let i = open + 1; i <= close; i++) {
					const ch = masked[i];
					if (ch === "\n" || i === close) {
						if (depth === 0) {
							const ln = masked.slice(lineStart, i).trim();
							const em = ln.match(/^\*?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)(?:\[[^\]]*\])?\s*(?:"\s*"|`\s*`)?$/);
							if (em) cls.embeds.push(em[1]);
							else if (kind === "struct") {
								const fm = ln.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+(\S.*)$/);
								if (fm) { const t = goTypeName(fm[2]); if (t) for (const f of fm[1].split(",")) cls.fields.set(f.trim(), t); }
							}
						}
						lineStart = i + 1;
					}
					if (ch === "{" || ch === "(") depth++;
					else if (ch === "}" || ch === ")") depth--;
				}
			}
		} else {
			const t = goTypeName(r);
			if (t && !t.startsWith("[]")) cls.underlying = t;
		}
		d.classes.push(cls);
	};

	const addValues = (names, at, rest) => {
		const list = names.split(",").map((s) => s.trim()).filter((s) => s && s !== "_");
		for (const name of list) d.types.push({ name, line: lineOf(at), kind: "const" });
		if (list.length !== 1) return;
		const eq = rest.indexOf("=");
		const typeText = (eq < 0 ? rest : rest.slice(0, eq)).trim();
		const init = eq < 0 ? "" : rest.slice(eq + 1).trim();
		d.goVars.set(list[0], { type: typeText ? goTypeName(typeText) : null, init });
	};

	const funcRe = /func\s*(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*(\[[^\]]*\]\s*)?\(/y;
	const addFunc = (at) => {
		funcRe.lastIndex = at;
		const m = funcRe.exec(masked);
		if (!m) return at;
		const paramsOpen = funcRe.lastIndex - 1;
		const paramsClose = matchClose(masked, paramsOpen);
		if (paramsClose < 0) return at;
		let bodyOpen = -1, paren = 0, i = paramsClose + 1, word = "";
		for (; i < n; i++) {
			const ch = masked[i];
			if (ch === "(" || ch === "[") paren++;
			else if (ch === ")" || ch === "]") paren--;
			else if (ch === "{") {
				if (word === "interface" || word === "struct") { const e = matchClose(masked, i); if (e < 0) break; i = e; word = ""; continue; }
				bodyOpen = i;
				break;
			} else if (ch === "\n" && paren <= 0) break;
			if (isIdentChar(ch)) word = isIdentChar(masked[i - 1]) ? word + ch : ch;
			else if (ch !== " " && ch !== "\t") word = "";
		}
		const bodyClose = bodyOpen >= 0 ? matchClose(masked, bodyOpen) : -1;
		const fn = {
			name: m[2], line: lineOf(at), end: bodyClose > 0 ? lineOf(bodyClose) : lineOf(i < n ? i : n - 1),
			params: goParams(masked.slice(paramsOpen + 1, paramsClose)),
			result: goFirstResult(masked.slice(paramsClose + 1, bodyOpen >= 0 ? bodyOpen : i)),
			declStart: at, bodyStart: bodyOpen, bodyEnd: bodyClose,
		};
		if (m[1] !== undefined) {
			const rm = m[1].match(/^\s*(?:([A-Za-z_]\w*)\s+)?\*?\s*([A-Za-z_]\w*)/);
			if (rm) {
				fn.recvName = rm[1] && rm[1] !== "_" ? rm[1] : null;
				fn.recvType = rm[2];
				d.goMethods.push(fn);
				return bodyClose > 0 ? bodyClose : i;
			}
		}
		d.functions.push(fn);
		return bodyClose > 0 ? bodyClose : i;
	};

	// Walk line starts at brace depth 0; `group` is the keyword of an open `( … )` block.
	let brace = 0, paren = 0, group = null, prevEnd = "", paren1Start = false;
	let i = 0;
	while (i < n) {
		const eol = masked.indexOf("\n", i) < 0 ? n : masked.indexOf("\n", i);
		const ln = masked.slice(i, eol);
		let skipTo = -1;
		if (brace === 0) {
			let m;
			if (paren === 0) {
				group = null;
				if (/^func\b/.test(ln)) skipTo = addFunc(i);
				else if ((m = ln.match(/^type\s+([A-Za-z_]\w*)/))) addType(m[1], i, ln.slice(m[0].length), i + m[0].length);
				else if ((m = ln.match(/^(type|const|var)\s*\(/))) { group = m[1]; paren1Start = true; }
				else if ((m = ln.match(/^(?:const|var)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/))) addValues(m[1], i, ln.slice(m[0].length));
			} else if (paren === 1 && group) {
				let m;
				if (group === "type") {
					if ((m = ln.match(/^\s*([A-Za-z_]\w*)\b/))) addType(m[1], i + ln.indexOf(m[1]), ln.slice(m[0].length), i + m[0].length);
				} else if (paren1Start || !/[+\-*/%&|^<>=,]$/.test(prevEnd)) { if ((m = ln.match(/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?=$|=|[A-Za-z_*\[]|\/\/)/))) {
					addValues(m[1], i + ln.indexOf(m[1]), ln.slice(m[0].length));
				} }
			}
		}
		if (skipTo > i) {
			// a function was consumed up to its closing brace: resume on the next line
			const next = masked.indexOf("\n", skipTo);
			i = next < 0 ? n : next + 1;
			prevEnd = "}";
			continue;
		}
		for (let k = i; k < eol; k++) {
			const ch = masked[k];
			if (ch === "{") brace++;
			else if (ch === "}") brace--;
			else if (ch === "(") paren++;
			else if (ch === ")") paren--;
		}
		const trimmed = ln.trimEnd();
		if (trimmed) { prevEnd = trimmed[trimmed.length - 1]; if (!/^(?:type|const|var)\s*\($/.test(trimmed)) paren1Start = false; }
		i = eol + 1;
	}
}

// ============================================================================
// Rust declarations
// ============================================================================

// Index after the `<…>` group opening at `open` (the `>` of `->` and `=>`
// closes nothing), or -1.
function skipAngles(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === "<") depth++;
		else if (ch === ">" && text[i - 1] !== "-" && text[i - 1] !== "=") { if (--depth === 0) return i + 1; }
		else if (ch === "{" || ch === ";") return -1;
	}
	return -1;
}

// `a::b::{c, d as e, f::*, self}` → [{ segs, alias, glob }].
function rustUseTree(text, prefix, out) {
	const t = text.trim();
	if (!t) return out;
	const brace = t.indexOf("{");
	if (brace >= 0) {
		const close = matchClose(t, brace);
		const head = t.slice(0, brace).replace(/::\s*$/, "").trim();
		const base = head ? prefix.concat(head.split("::").map((s) => s.trim()).filter(Boolean)) : prefix;
		for (const piece of splitTopLevel(t.slice(brace + 1, close < 0 ? t.length : close))) rustUseTree(piece, base, out);
		return out;
	}
	const m = t.match(/^((?:[A-Za-z_]\w*\s*::\s*)*)(\*|[A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
	if (!m) return out;
	const head = m[1].split("::").map((s) => s.trim()).filter(Boolean);
	if (m[2] === "*") out.push({ segs: prefix.concat(head), alias: null, glob: true });
	else if (m[2] === "self" && (prefix.length || head.length)) {
		const segs = prefix.concat(head);
		out.push({ segs, alias: m[3] || segs[segs.length - 1], glob: false });
	} else out.push({ segs: prefix.concat(head, [m[2]]), alias: m[3] || m[2], glob: false });
	return out;
}

// The name a type expression is known by: `&'a mut path::Type<T>` → "Type",
// with its full path segments (`["path", "Type"]`).
function rustTypePath(expr) {
	let t = String(expr || "").trim();
	for (;;) {
		const m = t.match(/^(?:&|\*\s*(?:const|mut)\b|'[A-Za-z_]\w*|mut\b|dyn\b|impl\b)\s*/);
		if (!m || !m[0]) break;
		t = t.slice(m[0].length);
	}
	const m = t.match(/^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)/);
	return m ? m[1].split("::").map((s) => s.trim()) : null;
}

const RUST_ITEM_RE = /(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:(?:const|async|unsafe)\s+)*(?:extern\s*(?:"[^"]*"\s*)?)?(fn|struct|enum|union|trait|impl|mod|type|const|static|use|macro_rules\s*!|extern\s+crate)(?![\w])/y;

// Rust items from masked source, at any module depth: functions, structs,
// enums, unions, traits (with their methods), impl blocks (methods grouped by
// the type they are for), inline and file modules, type aliases, constants,
// statics, macros and `use` trees. Offsets index `masked`.
function parseRustDecls(d, masked, lineOf) {
	d.rsScopes = new Map(); // inline module path ("" | "a::b") -> scope
	d.rsImpls = [];
	d.rsNested = [];
	d.rsFns = [];
	d.rsSkip = []; // ranges that hold no calls: type declarations, macro definitions
	const n = masked.length;
	const scopeOf = (inl, parent) => {
		let s = d.rsScopes.get(inl);
		if (!s) d.rsScopes.set(inl, s = { inl, items: new Map(), mods: new Map(), modDecls: [], uses: new Map(), globs: [], parent });
		return s;
	};
	const nameAt = (i) => {
		const m = /\s*((?:r#)?[A-Za-z_]\w*)/y;
		m.lastIndex = i;
		const r = m.exec(masked);
		return r ? { name: r[1], end: m.lastIndex } : null;
	};
	// End of a statement starting at `i`: its `;`, or the brace that closes its first top-level block.
	const statementEnd = (i, stopAtBlock) => {
		for (let k = i; k < n; k++) {
			const ch = masked[k];
			if (ch === "(" || ch === "[") { const e = matchClose(masked, k); if (e < 0) return n; k = e; }
			else if (ch === "{") { const e = matchClose(masked, k); if (e < 0) return n; if (stopAtBlock) return e; k = e; }
			else if (ch === ";") return k;
			else if (ch === "}") return k - 1;
		}
		return n;
	};
	// Body of an item whose header starts at `i`: { open, close } or { end } at its `;`.
	const bodyOf = (i) => {
		for (let k = i; k < n; k++) {
			const ch = masked[k];
			if (ch === "(" || ch === "[") { const e = matchClose(masked, k); if (e < 0) break; k = e; }
			else if (ch === "<") { const e = skipAngles(masked, k); if (e > 0) k = e - 1; }
			else if (ch === "{") { const e = matchClose(masked, k); return e < 0 ? { end: n } : { open: k, close: e }; }
			else if (ch === ";") return { end: k };
			else if (ch === "}") return { end: k - 1 };
		}
		return { end: n };
	};
	const nestedFnRe = /\b(fn|struct|enum)\s+((?:r#)?[A-Za-z_]\w*)/g;
	const addFn = (at, nameInfo, inl, owner, list) => {
		const b = bodyOf(nameInfo.end);
		const fn = { name: nameInfo.name, line: lineOf(at), end: lineOf(b.close != null ? b.close : Math.min(b.end, n - 1)), declStart: at, bodyStart: b.open != null ? b.open : -1, bodyEnd: b.close != null ? b.close : -1, inl, owner };
		list.push(fn);
		d.rsFns.push(fn);
		if (fn.bodyStart >= 0) {
			nestedFnRe.lastIndex = fn.bodyStart;
			let m;
			while ((m = nestedFnRe.exec(masked)) !== null && m.index < fn.bodyEnd) {
				const nb = bodyOf(m.index + m[0].length);
				d.rsNested.push({ name: m[2], kind: m[1], line: lineOf(m.index), end: lineOf(nb.close != null ? nb.close : Math.min(nb.end, n - 1)), parent: fn });
			}
		}
		return b.close != null ? b.close : b.end;
	};

	const scanItems = (from, to, inl, parent, ctx) => {
		const scope = ctx ? null : scopeOf(inl, parent);
		let i = from;
		while (i < to) {
			const ch = masked[i];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ";") { i++; continue; }
			if (ch === "#") { // attribute
				const open = masked.indexOf("[", i);
				const e = open >= 0 && open <= i + 2 ? matchClose(masked, open) : -1;
				i = e < 0 ? i + 1 : e + 1;
				continue;
			}
			RUST_ITEM_RE.lastIndex = i;
			const m = RUST_ITEM_RE.exec(masked);
			if (!m) { i = statementEnd(i, true) + 1; continue; }
			const kw = m[1].replace(/\s+/g, " ");
			const after = RUST_ITEM_RE.lastIndex;
			const nm = nameAt(after);
			if (kw === "fn") {
				if (!nm) { i = statementEnd(after, true) + 1; continue; }
				if (ctx) i = addFn(i, nm, inl, ctx.owner, ctx.methods) + 1;
				else {
					const list = [];
					i = addFn(i, nm, inl, null, list) + 1;
					const fn = list[0];
					d.functions.push(fn);
					if (!scope.items.has(fn.name)) scope.items.set(fn.name, { kind: "fn", name: fn.name, ref: fn });
				}
			} else if (kw === "struct" || kw === "enum" || kw === "union" || kw === "trait") {
				if (!nm || ctx) { i = statementEnd(after, true) + 1; continue; }
				const b = bodyOf(nm.end);
				const cls = { name: nm.name, line: lineOf(i), end: lineOf(b.close != null ? b.close : Math.min(b.end, n - 1)), kind: kw === "trait" ? "trait" : kw === "enum" ? "enum" : "struct", extends: null, implements: [], methods: [], inl, bodyStart: b.open != null ? b.open : -1, bodyEnd: b.close != null ? b.close : -1 };
				if (kw !== "trait") d.rsSkip.push([i, (b.close != null ? b.close : b.end) + 1]);
				d.classes.push(cls);
				if (!scope.items.has(cls.name)) scope.items.set(cls.name, { kind: cls.kind, name: cls.name, ref: cls });
				if (kw === "trait" && b.open != null) {
					const impl = { inl, typeName: nm.name, typeSegs: [nm.name], traitSegs: null, line: cls.line, methods: [], isTrait: true };
					d.rsImpls.push(impl);
					scanItems(b.open + 1, b.close, inl, parent, { owner: nm.name, methods: impl.methods });
				}
				i = (b.close != null ? b.close : b.end) + 1;
			} else if (kw === "impl") {
				let k = after;
				while (k < n && /\s/.test(masked[k])) k++;
				if (masked[k] === "<") { const e = skipAngles(masked, k); if (e > 0) k = e; }
				const b = bodyOf(k);
				if (b.open == null || ctx) { i = (b.close != null ? b.close : b.end) + 1; continue; }
				let header = masked.slice(k, b.open);
				const wh = header.search(/\bwhere\b/);
				if (wh >= 0) header = header.slice(0, wh);
				// the first ` for ` outside angle brackets separates trait and type
				let depth = 0, forAt = -1;
				for (let q = 0; q < header.length; q++) {
					const c = header[q];
					if (c === "<") depth++;
					else if (c === ">" && header[q - 1] !== "-" && header[q - 1] !== "=") depth--;
					else if (depth === 0 && c === "f" && /^for\s+[^<\s]/.test(header.slice(q)) && /\s/.test(header[q - 1] || " ")) { forAt = q; break; }
				}
				const typeSegs = rustTypePath(forAt >= 0 ? header.slice(forAt + 3) : header);
				const traitSegs = forAt >= 0 ? rustTypePath(header.slice(0, forAt).replace(/^\s*!/, "")) : null;
				if (typeSegs) {
					const impl = { inl, typeName: typeSegs[typeSegs.length - 1], typeSegs, traitSegs, line: lineOf(i), methods: [], isTrait: false };
					d.rsImpls.push(impl);
					scanItems(b.open + 1, b.close, inl, parent, { owner: impl.typeName, methods: impl.methods });
				}
				i = b.close + 1;
			} else if (kw === "mod") {
				if (!nm || ctx) { i = statementEnd(after, true) + 1; continue; }
				const b = bodyOf(nm.end);
				if (b.open != null) {
					const sub = inl ? inl + "::" + nm.name : nm.name;
					scope.mods.set(nm.name, { inline: sub });
					scanItems(b.open + 1, b.close, sub, inl, null);
					i = b.close + 1;
				} else {
					scope.modDecls.push({ name: nm.name, line: lineOf(i) });
					i = b.end + 1;
				}
			} else if (kw === "type" || kw === "const" || kw === "static") {
				let name = nm;
				if (name && name.name === "mut") name = nameAt(name.end);
				const end = statementEnd(after, false);
				if (name && name.name !== "_" && !ctx) {
					const t = { name: name.name, line: lineOf(i), kind: kw === "type" ? "type" : "const", inl };
					d.types.push(t);
					if (!scope.items.has(t.name)) scope.items.set(t.name, { kind: t.kind, name: t.name, ref: t });
				}
				i = end + 1;
			} else if (kw === "macro_rules !" || kw === "macro_rules!") {
				const b = nm ? bodyOf(nm.end) : { end: after };
				let end = b.close != null ? b.close : b.end;
				if (nm && b.open == null) { // macro_rules! name ( … );
					const open = masked.indexOf("(", nm.end);
					const e = open >= 0 ? matchClose(masked, open) : -1;
					if (e > 0) end = e;
				}
				d.rsSkip.push([i, end + 1]);
				if (nm && !ctx) {
					const t = { name: nm.name, line: lineOf(i), kind: "macro", inl };
					d.types.push(t);
					if (!scope.items.has(t.name)) scope.items.set(t.name, { kind: "macro", name: t.name, ref: t });
				}
				i = end + 1;
			} else if (kw === "use") {
				const end = statementEnd(after, false);
				if (!ctx) {
					for (const u of rustUseTree(masked.slice(after, end), [], [])) {
						if (u.glob) scope.globs.push(u.segs);
						else if (u.alias !== "_") {
							if (!scope.uses.has(u.alias)) scope.uses.set(u.alias, []);
							scope.uses.get(u.alias).push(u.segs);
						}
						d.imports.push({ spec: u.segs.join("::"), default: null, namespace: u.alias, names: [], reExport: false, dynamic: false, line: lineOf(i), rsInl: inl, rsSegs: u.segs, rsGlob: u.glob });
					}
				}
				i = end + 1;
			} else i = statementEnd(after, false) + 1; // extern crate
		}
	};
	scanItems(0, n, "", null, null);
}

// ============================================================================
// TypeScript / JavaScript declarations
// ============================================================================

// Index after the `<…>` group opening at `open` (a generic parameter or
// argument list: the `>` of `=>` closes nothing, brackets inside are skipped
// whole), or -1 when it is not one.
function tsAngles(text, open) {
	let depth = 0;
	const limit = Math.min(text.length, open + 4000);
	for (let i = open; i < limit; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") { const e = matchClose(text, i); if (e < 0) return -1; i = e; }
		else if (ch === "<") depth++;
		else if (ch === ">" && text[i - 1] !== "=") { if (--depth === 0) return i + 1; }
		else if (ch === ";" || ch === ")" || ch === "]" || ch === "}") return -1;
	}
	return -1;
}

const TS_TYPE_BRACE_PREV = new Set([":", "|", "&", ",", "(", "<", "?", "["]);
const TS_TYPE_WORDS = new Set(["is", "extends", "keyof", "typeof", "infer", "readonly", "asserts", "in"]);
const TS_LINE_CONTINUES = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "=", "?", ":", ",", ".", "(", "[", "{", "!", "~"]);
const TS_CONTINUE_WORDS = new Set(["return", "typeof", "new", "await", "yield", "extends", "in", "of", "instanceof", "as", "satisfies", "void", "delete", "throw", "case", "else"]);
const TS_NEXT_CONTINUES = new Set([".", "?", ":", "+", "*", "/", "%", "&", "|", "^", "<", ">", "=", ",", ")", "]"]);
const TS_NEXT_WORDS = new Set(["as", "satisfies", "instanceof", "in", "extends"]);
const TS_MEMBER_MODIFIERS = new Set(["public", "private", "protected", "static", "readonly", "override", "abstract", "async", "declare", "accessor", "get", "set"]);
const TS_NOT_A_NAME = new Set(["extends", "implements"]);

// Where a function's body opens after its parameter list closed at `from - 1`:
// { open } at the body brace, or { end } where a bodiless signature ends. A
// brace that belongs to the return type (`): { ok: boolean } {`) is skipped.
function tsBodyOpen(text, from) {
	const n = text.length;
	let prev = ")", word = "", arrow = false;
	for (let k = from; k < n; k++) {
		const ch = text[k];
		if (ch === " " || ch === "\t" || ch === "\r") continue;
		if (ch === "\n") {
			if (TS_TYPE_BRACE_PREV.has(prev) || arrow || TS_TYPE_WORDS.has(word)) continue;
			let q = k + 1;
			while (q < n && /\s/.test(text[q])) q++;
			const c2 = text[q];
			if (c2 === "{" || c2 === "|" || c2 === "&" || c2 === ":" || c2 === "<" || c2 === "=" || c2 === "." || c2 === "?" || c2 === "[") continue;
			if (prev === ")" && c2 === undefined) return { end: k };
			if (/^(?:is|extends|keyof)\b/.test(text.slice(q, q + 8))) continue;
			return { end: k };
		}
		if (ch === "{") {
			if (TS_TYPE_BRACE_PREV.has(prev) || arrow || TS_TYPE_WORDS.has(word)) {
				const e = matchClose(text, k);
				if (e < 0) return { end: n };
				k = e; prev = "}"; word = ""; arrow = false;
				continue;
			}
			return { open: k };
		}
		if (ch === "(" || ch === "[") { const e = matchClose(text, k); if (e < 0) return { end: n }; k = e; prev = ")"; word = ""; arrow = false; continue; }
		if (ch === "<") { const e = tsAngles(text, k); if (e > 0) { k = e - 1; prev = ">"; word = ""; arrow = false; continue; } }
		if (ch === ";") return { end: k };
		if (ch === "}" || ch === ")" || ch === "]") return { end: k - 1 };
		if (ch === "," && prev !== ")") return { end: k };
		if (ch === "=" && text[k + 1] === ">") { arrow = true; k++; prev = ">"; word = ""; continue; }
		arrow = false;
		word = isIdentChar(ch) ? (isIdentChar(text[k - 1]) ? word + ch : ch) : "";
		prev = ch;
	}
	return { end: n };
}

// End (exclusive of the terminator) of the expression that starts at `from`:
// its `;`, a top-level `,`, the bracket that closes the enclosing construct,
// or the line break after which a new statement begins.
function tsExprEnd(text, from) {
	const n = text.length;
	let prev = "", word = "";
	for (let k = from; k < n; k++) {
		const ch = text[k];
		if (ch === " " || ch === "\t" || ch === "\r") continue;
		if (ch === "(" || ch === "[" || ch === "{") { const e = matchClose(text, k); if (e < 0) return n; k = e; prev = ")"; word = ""; continue; }
		if (ch === ";" || ch === ",") return k;
		if (ch === ")" || ch === "]" || ch === "}") return k;
		if (ch === "\n") {
			const jsxClose = prev === ">" && k >= 2 && /[\w"'/}\])]/.test(text[k - 1] === ">" ? text[k - 2] : "");
			if (!prev || (TS_LINE_CONTINUES.has(prev) && !jsxClose) || TS_CONTINUE_WORDS.has(word)) continue;
			let q = k + 1;
			while (q < n && /\s/.test(text[q])) q++;
			if (q >= n) return k;
			if (TS_NEXT_CONTINUES.has(text[q]) && !(text[q] === "/" && text[q + 1] === "/")) continue;
			const nw = text.slice(q, q + 12).match(/^[A-Za-z]+/);
			if (nw && TS_NEXT_WORDS.has(nw[0])) continue;
			return k;
		}
		word = isIdentChar(ch) ? (isIdentChar(text[k - 1]) ? word + ch : ch) : "";
		prev = ch;
	}
	return n;
}

// The function or class an initializer is, when it is one: `(a) => …`,
// `async <T>(a: T): R => …`, `x => …`, `function (…) {…}`, `class {…}`.
// Returns { kind, open, close } with the body's braces (close = the end of a
// brace-less arrow body, open = -1), or null.
function tsFunctionInit(text, from) {
	const n = text.length;
	let k = from;
	const skipWs = () => { while (k < n && /\s/.test(text[k])) k++; };
	skipWs();
	let m = /async\b/y;
	m.lastIndex = k;
	if (m.test(text)) { const save = k; k = m.lastIndex; skipWs(); if (text[k] === "=" || text[k] === ";" || text[k] === "," || text[k] === ")") k = save; }
	m = /(function|class)\b/y;
	m.lastIndex = k;
	const kw = m.exec(text);
	if (kw && kw[1] === "function") {
		const open = text.indexOf("(", m.lastIndex);
		const pc = open >= 0 ? matchClose(text, open) : -1;
		if (pc < 0) return null;
		const b = tsBodyOpen(text, pc + 1);
		const close = b.open != null ? matchClose(text, b.open) : -1;
		return close > 0 ? { kind: "function", open: b.open, close } : null;
	}
	if (kw && kw[1] === "class") {
		const b = tsClassBody(text, m.lastIndex);
		return b ? { kind: "class", open: b.open, close: b.close, header: text.slice(m.lastIndex, b.open) } : null;
	}
	if (text[k] === "<") { const e = tsAngles(text, k); if (e < 0) return null; k = e; skipWs(); if (text[k] !== "(") return null; }
	let arrowAt = -1;
	if (text[k] === "(") {
		const pc = matchClose(text, k);
		if (pc < 0) return null;
		k = pc + 1;
		skipWs();
		if (text[k] === "=" && text[k + 1] === ">") arrowAt = k;
		else if (text[k] === ":") {
			// a return type, then the arrow
			for (let q = k + 1; q < n; q++) {
				const ch = text[q];
				if (ch === "(" || ch === "[" || ch === "{") { const e = matchClose(text, q); if (e < 0) return null; q = e; }
				else if (ch === "<") { const e = tsAngles(text, q); if (e > 0) q = e - 1; }
				else if (ch === "=" && text[q + 1] === ">") { arrowAt = q; break; }
				else if (ch === ";" || ch === ")" || ch === "]" || ch === "}" || (ch === "=" && text[q + 1] !== "=")) return null;
			}
		}
	} else {
		m = /[A-Za-z_$][\w$]*/y;
		m.lastIndex = k;
		if (!m.test(text)) return null;
		k = m.lastIndex;
		skipWs();
		if (text[k] === "=" && text[k + 1] === ">") arrowAt = k;
	}
	if (arrowAt < 0) return null;
	k = arrowAt + 2;
	skipWs();
	if (text[k] === "{") {
		const close = matchClose(text, k);
		return close > 0 ? { kind: "arrow", open: k, close } : null;
	}
	return { kind: "arrow", open: -1, close: tsExprEnd(text, k) };
}

// The body braces of a class whose name (or `class` keyword) ends at `from`.
function tsClassBody(text, from) {
	const n = text.length;
	for (let k = from; k < n; k++) {
		const ch = text[k];
		if (ch === "(" || ch === "[") { const e = matchClose(text, k); if (e < 0) return null; k = e; }
		else if (ch === "<") { const e = tsAngles(text, k); if (e > 0) k = e - 1; }
		else if (ch === "{") { const close = matchClose(text, k); return close > 0 ? { open: k, close } : null; }
		else if (ch === ";" || ch === "}" || ch === ")") return null;
	}
	return null;
}

// `extends` / `implements` of a class header (the text between its name and body).
function tsClassHeritage(header) {
	let h = header;
	const lead = h.match(/^\s*/)[0].length;
	if (h[lead] === "<") { const e = tsAngles(h, lead); if (e > 0) h = h.slice(e); }
	const ext = h.match(/\bextends\s+([A-Za-z_$][\w$.]*)/);
	const impl = h.match(/\bimplements\s+([\s\S]+)$/);
	return { extends: ext ? ext[1].split(".")[0] : null, implements: implementsList(impl ? impl[1] : "") };
}

// Members of a class body (between its braces): methods, the constructor,
// accessors, `#private` names and function-valued properties. A word followed
// by `(` at member position is a method header whatever the word is
// (`delete(id) {`, `get() {`); statements cannot occur there.
function tsClassMembers(cls, text, from, to, lineOf) {
	const identRe = /#?[A-Za-z_$][\w$]*/y;
	let i = from;
	while (i < to) {
		const ch = text[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ";" || ch === ",") { i++; continue; }
		if (ch === "@") { // decorator
			identRe.lastIndex = i + 1;
			let k = identRe.test(text) ? identRe.lastIndex : i + 1;
			while (text[k] === ".") { identRe.lastIndex = k + 1; if (!identRe.test(text)) break; k = identRe.lastIndex; }
			if (text[k] === "(") { const e = matchClose(text, k); k = e < 0 ? to : e + 1; }
			i = k;
			continue;
		}
		// modifiers, then the name
		let name = null, nameAt = i, k = i, accessor = false;
		for (;;) {
			while (k < to && (text[k] === " " || text[k] === "\t" || text[k] === "\n" || text[k] === "\r")) k++;
			if (text[k] === "*") { k++; continue; }
			identRe.lastIndex = k;
			const w = identRe.exec(text);
			if (!w) break;
			let q = identRe.lastIndex;
			while (q < to && (text[q] === " " || text[q] === "\t")) q++;
			const next = text[q];
			const startsName = next === "#" || next === "[" || next === '"' || next === "'" || next === "*" || (next !== undefined && isIdentChar(next)) || (next === "\n" && (w[0] === "static" || w[0] === "async"));
			if (TS_MEMBER_MODIFIERS.has(w[0]) && startsName) {
				if (w[0] === "get" || w[0] === "set" || w[0] === "accessor") accessor = true;
				k = identRe.lastIndex;
				continue;
			}
			name = w[0]; nameAt = k; k = identRe.lastIndex;
			break;
		}
		if (name === null) {
			if (text[k] === "{") { const e = matchClose(text, k); i = e < 0 ? to : e + 1; continue; } // static block
			if (text[k] === "[" || text[k] === '"' || text[k] === "'") { // computed or quoted name: not indexed
				if (text[k] === "[") { const e = matchClose(text, k); k = e < 0 ? to : e + 1; }
				else { const e = text.indexOf(text[k], k + 1); k = e < 0 ? to : e + 1; }
			} else if (/[0-9]/.test(text[k] || "")) { while (k < to && /[\w.]/.test(text[k])) k++; }
			else { i = k + 1; continue; }
		}
		while (k < to && (text[k] === " " || text[k] === "\t")) k++;
		if (text[k] === "?" || text[k] === "!") k++;
		while (k < to && (text[k] === " " || text[k] === "\t")) k++;
		let open = k;
		if (text[open] === "<") { const e = tsAngles(text, open); if (e > 0) { open = e; while (open < to && /\s/.test(text[open])) open++; } }
		if (text[open] === "(") {
			const pc = matchClose(text, open);
			if (pc < 0) return;
			const b = tsBodyOpen(text, pc + 1);
			const close = b.open != null ? matchClose(text, b.open) : -1;
			const end = close > 0 ? close : Math.min(b.end, to);
			if (name !== null) addMethod(cls, { name, line: lineOf(nameAt), end: lineOf(Math.min(end, text.length - 1)), bodyStart: close > 0 ? b.open : -1, bodyEnd: close });
			i = end + 1;
			continue;
		}
		// a property: its type annotation, then an initializer that may be a function
		let eq = -1, stop = to;
		for (let q = k; q < to; q++) {
			const c = text[q];
			if (c === "(" || c === "[" || c === "{") { const e = matchClose(text, q); if (e < 0) { stop = to; break; } q = e; }
			else if (c === "<") { const e = tsAngles(text, q); if (e > 0) q = e - 1; }
			else if (c === "=" && text[q + 1] === ">") q++;
			else if (c === "=") { eq = q; break; }
			else if (c === ";" || c === "}") { stop = q; break; }
			else if (c === "\n") {
				let p = q - 1;
				while (p > k && (text[p] === " " || text[p] === "\t" || text[p] === "\r")) p--;
				let nx = q + 1;
				while (nx < to && /\s/.test(text[nx])) nx++;
				if (!TS_TYPE_BRACE_PREV.has(text[p]) && !(text[p] === ">" && text[p - 1] === "=") && text[nx] !== "|" && text[nx] !== "&" && text[nx] !== "=" && text[nx] !== "?" && text[nx] !== ":") { stop = q; break; }
			}
		}
		if (name !== null && text[k] === ":") {
			const tm = text.slice(k + 1, eq < 0 ? stop : eq).match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$.]*)/);
			if (tm) (cls.fields ||= new Map()).set(name, tm[1]);
		}
		if (eq < 0) { i = stop + 1; continue; }
		if (name !== null && !(cls.fields && cls.fields.has(name))) {
			const nm = text.slice(eq + 1, eq + 200).match(/^\s*new\s+([A-Za-z_$][\w$.]*)/);
			if (nm) (cls.fields ||= new Map()).set(name, nm[1]);
		}
		const fn = accessor ? null : tsFunctionInit(text, eq + 1);
		if (fn && fn.kind !== "class") {
			if (name !== null) addMethod(cls, { name, line: lineOf(nameAt), end: lineOf(Math.min(fn.close, text.length - 1)), bodyStart: fn.open, bodyEnd: fn.close, property: true });
			i = fn.close + 1;
		} else i = tsExprEnd(text, eq + 1) + 1;
	}
}

// Declarations of a TS/JS module from masked source. Top level: classes
// (class expressions bound to a variable included), functions, function-valued
// variables, other variables, interfaces, enums, type aliases, namespaces.
// Below top level: named functions, function-valued variables, classes and
// types declared inside function bodies and callbacks (`d.nested`).
function parseTsDecls(d, masked, lineOf, lang) {
	const n = masked.length;
	d.nested = [];
	d.cjsFunctions = [];
	d.localExports = []; // `export { a as b }` without a source
	d.defaultName = null; // `export default name`
	const total = () => d.classes.length + d.functions.length + d.types.length;
	const addClass = (name, at, bodyOpen, bodyClose, header, isDefault) => {
		const h = tsClassHeritage(header);
		const cls = { name, line: lineOf(at), end: lineOf(bodyClose), isDefault, extends: h.extends, implements: h.implements, methods: [], bodyStart: bodyOpen, bodyEnd: bodyClose };
		d.classes.push(cls);
		tsClassMembers(cls, masked, bodyOpen + 1, bodyClose, lineOf);
		return cls;
	};
	const functionAt = (at, afterKeyword, name, isDefault) => {
		let k = afterKeyword;
		while (k < n && /\s/.test(masked[k])) k++;
		if (masked[k] === "<") { const e = tsAngles(masked, k); if (e > 0) k = e; }
		const open = masked.indexOf("(", k);
		const pc = open >= 0 ? matchClose(masked, open) : -1;
		if (pc < 0) return;
		const b = tsBodyOpen(masked, pc + 1);
		const close = b.open != null ? matchClose(masked, b.open) : -1;
		d.functions.push({ name, line: lineOf(at), end: lineOf(Math.min(close > 0 ? close : b.end, n - 1)), isDefault, bodyStart: close > 0 ? b.open : -1, bodyEnd: close });
	};
	// The `=` that starts a variable's initializer, after an optional type annotation.
	const initializerAt = (from) => {
		for (let q = from; q < n; q++) {
			const c = masked[q];
			if (c === "(" || c === "[" || c === "{") { const e = matchClose(masked, q); if (e < 0) return -1; q = e; }
			else if (c === "<") { const e = tsAngles(masked, q); if (e > 0) q = e - 1; }
			else if (c === "=" && masked[q + 1] === ">") q++;
			else if (c === "=") return q;
			else if (c === ";" || c === "}" || c === ")" || c === ",") return -1;
			else if (c === "\n" && masked[from] !== ":") return -1;
		}
		return -1;
	};
	// kind of `const name …`: { kind: "function" | "class" | "const", … }
	const variableAt = (nameEnd) => {
		let k = nameEnd;
		while (k < n && (masked[k] === " " || masked[k] === "\t")) k++;
		if (masked[k] === "!") k++;
		const eq = masked[k] === "=" && masked[k + 1] !== "=" && masked[k + 1] !== ">" ? k : masked[k] === ":" ? initializerAt(k) : -1;
		if (eq < 0) return { kind: "const", required: false };
		const fn = tsFunctionInit(masked, eq + 1);
		if (fn) return fn.kind === "class" ? fn : { kind: "function", open: fn.open, close: fn.close };
		return { kind: "const", required: /^\s*(?:await\s+)?(?:require|import)\s*\(/.test(masked.slice(eq + 1, eq + 40)) };
	};

	// -- top level: lines that start a declaration outside every bracket
	let brace = 0, paren = 0, i = 0, lineNo = 0;
	while (i < n && total() < MAX_SYMBOLS_PER_FILE) {
		const nl = masked.indexOf("\n", i);
		const eol = nl < 0 ? n : nl;
		if (brace === 0 && paren === 0) {
			const ln = masked.slice(i, eol);
			let m;
			if ((m = ln.match(/^(\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?)class\b\s*([A-Za-z_$][\w$]*)?/)) && (m[2] || /\bdefault\b/.test(m[1]))) {
				const named = m[2] && !TS_NOT_A_NAME.has(m[2]);
				const after = named ? i + m[0].length : i + m[1].length + 5;
				const b = tsClassBody(masked, after);
				if (b) addClass(named ? m[2] : "default", i + m[1].length, b.open, b.close, masked.slice(after, b.open), /\bdefault\b/.test(m[1]));
			} else if ((m = ln.match(/^(\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?)function\b\s*\*?\s*([A-Za-z_$][\w$]*)?/)) && (m[2] || /\bdefault\b/.test(m[1]))) {
				functionAt(i + m[1].length, i + m[0].length, m[2] || "default", /\bdefault\b/.test(m[1]));
			} else if ((m = ln.match(/^(\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/))) {
				const at = i + m[1].length;
				const v = variableAt(i + m[0].length);
				if (v.kind === "function") d.functions.push({ name: m[2], line: lineOf(at), end: lineOf(Math.min(v.close, n - 1)), bodyStart: v.open, bodyEnd: v.close });
				else if (v.kind === "class") addClass(m[2], at, v.open, v.close, v.header, false);
				else if (!v.required) d.types.push({ name: m[2], line: lineOf(at), kind: "const" });
			} else if ((m = ln.match(/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const\s+)?(interface|enum)\s+([A-Za-z_$][\w$]*)/))) {
				const t = { name: m[2], line: lineOf(i + ln.indexOf(m[1])), kind: m[1], extends: null, extendsAll: [] };
				if (m[1] === "interface") {
					const b = tsClassBody(masked, i + m[0].length);
					let header = b ? masked.slice(i + m[0].length, b.open) : "";
					const lead = header.match(/^\s*/)[0].length;
					if (header[lead] === "<") { const e = tsAngles(header, lead); if (e > 0) header = header.slice(e); }
					const em = header.match(/\bextends\s+([\s\S]+)$/);
					t.extendsAll = implementsList(em ? em[1] : "");
					t.extends = t.extendsAll[0] || null;
				}
				d.types.push(t);
			} else if ((m = ln.match(/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<|=|$)/))) {
				d.types.push({ name: m[1], line: lineOf(i + ln.indexOf("type")), kind: "type" });
			} else if ((m = ln.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/)) || (m = ln.match(/^\s*declare\s+(global)\s*\{/))) {
				d.types.push({ name: m[1], line: lineOf(i + ln.search(/\S/)), kind: "namespace" });
			} else if ((m = ln.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/)) || (m = ln.match(/^\s*(?:exports\s*=\s*)?module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/))) {
				d.defaultName = m[1];
			} else if ((m = ln.match(/^(\s*(?:module\.)?exports\.)([A-Za-z_$][\w$]*)\s*=(?!=)/))) {
				// `exports.name = function …` declares `name` when nothing else does
				const fn = tsFunctionInit(masked, i + m[0].length);
				if (fn && fn.kind !== "class") d.cjsFunctions.push({ name: m[2], line: lineOf(i + m[1].length), end: lineOf(Math.min(fn.close, n - 1)), bodyStart: fn.open, bodyEnd: fn.close });
			}
		}
		for (let k = i; k < eol; k++) {
			const ch = masked[k];
			if (ch === "{") brace++;
			else if (ch === "}") brace--;
			else if (ch === "(" || ch === "[") paren++;
			else if (ch === ")" || ch === "]") paren--;
		}
		i = eol + 1;
		lineNo++;
	}
	for (const fn of d.cjsFunctions) {
		if (!d.functions.some((f) => f.name === fn.name) && !d.classes.some((c) => c.name === fn.name) && !d.types.some((t) => t.name === fn.name)) d.functions.push(fn);
	}
	const exportRe = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
	let em;
	while ((em = exportRe.exec(masked)) !== null) {
		for (const piece of em[1].split(",")) {
			const pm = piece.trim().replace(/^type\s+/, "").match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
			if (pm) d.localExports.push({ local: pm[1], exported: pm[2] || pm[1] });
		}
	}

	// -- below top level
	const depthAt = new Int32Array(n + 1);
	{
		let depth = 0;
		for (let k = 0; k < n; k++) {
			depthAt[k] = depth;
			if (masked[k] === "{") depth++;
			else if (masked[k] === "}") depth--;
		}
		depthAt[n] = depth;
	}
	const nestedRe = /(?<![\w$.])(?:(function)\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?=[<(])|(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[:=])|(class)\s+([A-Za-z_$][\w$]*)|(type|interface|enum)\s+([A-Za-z_$][\w$]*)\s*(?=[<={]|extends\b))/g;
	let nm;
	while ((nm = nestedRe.exec(masked)) !== null && d.nested.length < MAX_SYMBOLS_PER_FILE) {
		if (depthAt[nm.index] === 0) continue;
		const line = lineOf(nm.index);
		if (nm[1]) d.nested.push({ name: nm[2], kind: "function", line });
		else if (nm[3]) {
			const v = variableAt(nm.index + nm[0].length);
			if (v.kind === "function") d.nested.push({ name: nm[4], kind: "function", line });
			else if (v.kind === "class") d.nested.push({ name: nm[4], kind: "class", line });
		} else if (nm[5]) {
			if (TS_NOT_A_NAME.has(nm[6])) continue;
			d.nested.push({ name: nm[6], kind: "class", line });
			const b = tsClassBody(masked, nm.index + nm[0].length);
			if (b) {
				const inner = { methods: [] };
				tsClassMembers(inner, masked, b.open + 1, b.close, lineOf);
				for (const meth of inner.methods) d.nested.push({ name: meth.name, kind: "function", line: meth.line });
			}
		}
		else if (lang === "typescript") d.nested.push({ name: nm[8], kind: nm[7], line });
	}
}

function parseDecls(rel, content, lang) {
	const d = { classes: [], functions: [], types: [], imports: [], docstring: null, masked: "", callText: "" };
	// ONE masked copy (see maskSource) with the same offsets and line structure
	// as `content`: declarations, brace depth and import statements are all
	// found on it, so a `{` inside `const marker = "{";`, an `export function`
	// inside a template literal or an `import` inside a string cannot
	// desynchronize `depth` or fabricate a symbol or dependency. Import
	// specifiers are read back from `content` at the match offsets.
	const multiline = [];
	const masked = maskSource(content, lang, multiline);
	d.masked = masked;
	const importRanges = []; // import statements are not call sites either
	const maskedLines = masked.split("\n");
	const lineOf = lineIndex(content);
	const specAt = (m, g) => content.slice(m.indices[g][0], m.indices[g][1]);

	if (TS_LIKE.has(lang)) {
		// Leading /** */ or run of // as module rationale
		const dm = content.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
		if (dm) d.docstring = dm[1].replace(/^\s*\*\s?/gm, "").trim().slice(0, 500) || null;

		parseTsDecls(d, masked, lineOf, lang);
		// imports (content-level, multi-line safe), on the masked copy so
		// commented-out examples and import text inside strings or templates are
		// not dependencies. A statement-level `type` (`import type OpenAI from
		// "openai"`) is skipped unless it is itself the default binding
		// (`import type from "./type"`).
		const importNames = (list) => list.split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean)
			.map((t) => { const am = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/); return am ? { imported: am[1], local: am[2] || am[1] } : null; })
			.filter(Boolean);
		const impRe = /import\s+(?:type\s+(?!from\s*["']))?(?:(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*)?["']([^"']+)["']/gd;
		let m2;
		while ((m2 = impRe.exec(masked)) !== null) {
			importRanges.push([m2.index, m2.index + m2[0].length]);
			d.imports.push({ spec: specAt(m2, 4), default: m2[1] || null, namespace: m2[2] || null, names: importNames(m2[3] || ""), reExport: false, dynamic: false, line: lineOf(m2.index) });
		}
		const reExpRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gd;
		while ((m2 = reExpRe.exec(masked)) !== null) {
			importRanges.push([m2.index, m2.index + m2[0].length]);
			d.imports.push({ spec: specAt(m2, 2), default: null, namespace: null, names: importNames(m2[1]), reExport: true, dynamic: false, line: lineOf(m2.index) });
		}
		// `export * from` re-exports every name (namespace "*"); `export * as ns
		// from` exposes only `ns`, so it carries that name instead.
		const starRe = /export\s+(?:type\s+)?\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s*["']([^"']+)["']/gd;
		while ((m2 = starRe.exec(masked)) !== null) {
			importRanges.push([m2.index, m2.index + m2[0].length]);
			d.imports.push({ spec: specAt(m2, 2), default: null, namespace: m2[1] || "*", names: [], reExport: true, dynamic: false, line: lineOf(m2.index) });
		}
		// CommonJS: `const x = require("m")`, `const { a, b: c } = require("m")`,
		// `const y = require("m").y`, and the comma-continued form
		// (`var a = require("a")\n  , b = require("b")`) bind like imports.
		const cjsRe = /(?:\b(?:const|let|var)\s+|,\s*)(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/gd;
		const cjsRanges = [];
		while ((m2 = cjsRe.exec(masked)) !== null) {
			cjsRanges.push([m2.index, m2.index + m2[0].length]);
			const rec = { spec: specAt(m2, 3), default: null, namespace: null, names: [], reExport: false, dynamic: false, cjs: true, line: lineOf(m2.index + m2[0].search(/[A-Za-z_$\{]/)) };
			if (m2[2] !== undefined) {
				for (const piece of m2[2].split(",")) {
					const pm = piece.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
					if (pm) rec.names.push({ imported: pm[1], local: pm[2] || pm[1] });
				}
			} else if (m2[4]) rec.names.push({ imported: m2[4], local: m2[1] });
			else rec.namespace = m2[1];
			d.imports.push(rec);
		}
		const dynRe = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gd;
		while ((m2 = dynRe.exec(masked)) !== null) {
			if (cjsRanges.some(([a, b]) => m2.index >= a && m2.index < b)) continue;
			d.imports.push({ spec: specAt(m2, 1), default: null, namespace: null, names: [], reExport: false, dynamic: true, line: lineOf(m2.index) });
		}
	} else if (lang === "python") {
		const dm = content.match(/^(?:#[^\n]*\n|\s*\n)*\s*("""|''')([\s\S]*?)\1/);
		if (dm) d.docstring = dm[2].trim().slice(0, 500) || null;
		// Scope follows indentation: a class or def ends before the next logical
		// line at its own indent or less, so module-level code after it (an
		// `if __name__ == "__main__":` block) belongs to the file, and `self.x()`
		// can only bind inside the enclosing class. Lines inside brackets, after a
		// backslash, or inside a triple-quoted string continue the previous
		// statement and never open or close a scope.
		const inString = new Set();
		for (let k = 0; k < multiline.length; k += 2) {
			for (let l = lineOf(multiline[k]) + 1; l <= lineOf(multiline[k + 1] - 1); l++) inString.add(l - 1);
		}
		// Declarations count wherever module-level code can put them: under an
		// `if TYPE_CHECKING:`, a `try:`, a platform check. Only a def or class
		// body ends module level. A decorator belongs to what it decorates, so
		// `start` is the first decorator line.
		const scopes = [];
		let bracket = 0, continued = false, lastCode = 0, decoStart = null;
		const lineStarts = [0];
		for (let k = masked.indexOf("\n"); k >= 0; k = masked.indexOf("\n", k + 1)) lineStarts.push(k + 1);
		for (let i = 0; i < maskedLines.length; i++) {
			const ln = maskedLines[i];
			const hasCode = /\S/.test(ln);
			if (hasCode && bracket === 0 && !continued && !inString.has(i)) {
				const indent = ln.match(/^[ \t]*/)[0].replace(/\t/g, "        ").length;
				while (scopes.length && indent <= scopes[scopes.length - 1].indent) scopes.pop().ref.end = lastCode;
				const top = scopes[scopes.length - 1];
				let m;
				if (/^[ \t]*@/.test(ln)) {
					if (decoStart === null) decoStart = i + 1;
				} else {
					const start = decoStart !== null ? decoStart : i + 1;
					decoStart = null;
					if ((m = ln.match(/^[ \t]*class\s+([A-Za-z_][\w]*)\s*(\()?/))) {
						if (top) scopes.push({ ref: {}, indent, kind: "inner" });
						else {
							let basesText = "";
							if (m[2]) {
								const open = lineStarts[i] + m[0].length - 1;
								const close = matchClose(masked, open);
								if (close > open) basesText = masked.slice(open + 1, close);
							}
							const bases = [];
							for (const piece of splitTopLevel(basesText)) {
								const bm = piece.trim().match(/^((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\s*(?:\[[\s\S]*\])?$/);
								if (bm) bases.push({ module: bm[1].replace(/\.$/, ""), name: bm[2] });
							}
							const cls = { name: m[1], line: i + 1, start, end: null, extends: null, bases, implements: [], methods: [] };
							d.classes.push(cls);
							scopes.push({ ref: cls, indent, kind: "class" });
						}
					} else if ((m = ln.match(/^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)/))) {
						if (!top) {
							const fn = { name: m[1], line: i + 1, start, end: null };
							d.functions.push(fn);
							scopes.push({ ref: fn, indent, kind: "def" });
						} else if (top.kind === "class") {
							const meth = { name: m[1], line: i + 1, start, end: null };
							scopes.push({ ref: addMethod(top.ref, meth) ? meth : {}, indent, kind: "def" });
						} else scopes.push({ ref: {}, indent, kind: "inner" });
					} else if (!top && (m = ln.match(/^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]*\S[^=\n]*(?:=(?!=)|$)|=(?!=))/)) && !PY_STATEMENT_WORDS.has(m[1])) {
						d.types.push({ name: m[1], line: i + 1, kind: "const" });
					}
				}
			}
			for (const ch of ln) {
				if (ch === "(" || ch === "[" || ch === "{") bracket++;
				else if ((ch === ")" || ch === "]" || ch === "}") && bracket > 0) bracket--;
			}
			continued = /\\\s*$/.test(ln);
			if (hasCode) lastCode = i + 1;
		}
		for (const sc of scopes) sc.ref.end = lastCode;
		// `import a.b as c, d` binds `c` and `d`; without an alias the dotted path
		// itself is the name calls go through (`a.b.f()`).
		const impRe = /^[ \t]*from\s+(\S+)\s+import\s+([^\n(]+|\([^)]*\))|^[ \t]*import\s+([^\n]+)/gm;
		let m2;
		while ((m2 = impRe.exec(masked)) !== null) {
			importRanges.push([m2.index, m2.index + m2[0].length]);
			const line = lineOf(m2.index + m2[0].search(/\S/));
			if (m2[3]) {
				for (const piece of m2[3].split(",")) {
					const im = piece.trim().match(/^([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?$/);
					if (im) d.imports.push({ spec: im[1], default: null, namespace: im[2] || im[1], names: [], reExport: false, dynamic: false, line });
				}
			} else {
				const names = m2[2].replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/)).filter((q) => q[0])
					.map((q) => ({ imported: q[0], local: q[1] || q[0] }));
				d.imports.push({ spec: m2[1], default: null, namespace: null, names, reExport: false, dynamic: false, line });
			}
		}
	} else if (lang === "go") {
		parseGoDecls(d, masked, lineOf);
		// Named (`import foo "path"`), blank (`_`) and dot (`.`) imports all count;
		// a named alias becomes the local namespace so call binding can resolve
		// through it. Applies to both single-line and block forms.
		const impRe = /^import\s+(?:([\w.]+)\s+)?"([^"]+)"|^import\s+\(([^)]*)\)/gmd;
		let m2;
		while ((m2 = impRe.exec(masked)) !== null) {
			const entries = [];
			if (m2[2]) entries.push({ alias: m2[1] || null, spec: specAt(m2, 2) });
			else if (m2[3]) {
				const block = m2.indices[3][0];
				for (const lm of m2[3].matchAll(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/gmd)) {
					entries.push({ alias: lm[1] || null, spec: content.slice(block + lm.indices[2][0], block + lm.indices[2][1]) });
				}
			}
			for (const e of entries) {
				const ns = e.alias && e.alias !== "_" && e.alias !== "." ? e.alias : e.spec.split("/").pop();
				d.imports.push({ spec: e.spec, default: null, namespace: ns, names: [], reExport: false, dynamic: false, line: lineOf(m2.index), goAlias: e.alias });
			}
		}
	} else if (lang === "rust") {
		parseRustDecls(d, masked, lineOf);
	}
	// What the call scans read: the masked text minus import statements and, in
	// TypeScript, interface bodies and type aliases.
	d.callText = blankRanges(masked, lang === "typescript" ? importRanges.concat(typeDeclRanges(masked)) : importRanges);
	return d;
}

// ============================================================================
// Build (phases 2-8)
// ============================================================================

// Every target string of a package.json `exports` value (string, conditions
// object or fallback array), in declaration order.
function exportTargets(v, out = []) {
	if (typeof v === "string") out.push(v);
	else if (v && typeof v === "object") for (const k of Object.values(v)) exportTargets(k, out);
	return out;
}

// Targets of a package's root export ("." entry), in declaration order. Only
// the conditions a Node/TypeScript consumer of the package can take are read:
// others (`browser`, `bun`, `development`, …) may point at a different entry.
const ROOT_EXPORT_CONDITIONS = new Set(["source", "types", "import", "module", "node", "require", "default"]);
function rootExportTargets(v, out = []) {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) rootExportTargets(x, out);
	else if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) if (ROOT_EXPORT_CONDITIONS.has(k)) rootExportTargets(x, out);
	}
	return out;
}

// A package's `exports` as a subpath map ("." and "./sub" keys); null when
// the field is absent. A string or a bare conditions object exports the
// root alone.
function subpathExports(exports) {
	if (exports === undefined || exports === null) return null;
	if (typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."))) return exports;
	return { ".": exports };
}

// The source path a build output was compiled from (`./dist/x.js` or
// `./dist/x.d.ts` → `./src/x`): `dist/` is never walked, so an export that
// points only at build output is found through its source.
function distToSrc(target) {
	return target.replace(/^(\.\/)?dist\//, "$1src/").replace(/\.d\.[mc]?ts$/, "");
}

function buildGraph(root) {
	const files = walk(root);
	const nodes = [];
	const nodeById = new Map();
	const edges = [];
	const perFile = new Map(); // rel -> { lang, decls, stripped, localDefs: Map(name -> nid), importedNames: Map(local -> {spec, resolvedRel|null, imported}) }

	// graphify ids.py canonicalization can collide (src/foo-bar.ts and
	// src/foo_bar.ts share an id). Parity requires keeping the id scheme, so
	// collisions merge deterministically (first wins) — but they are counted
	// and surfaced as a build warning instead of being silent.
	const idCollisions = [];
	const methodLimitHits = []; // classes that declare more than MAX_METHODS_PER_CLASS methods
	const textStats = new Map(); // rel -> { node, tf, count }
	const classMembers = new Map(); // class node id -> Map(method name -> node id)
	const baseOf = new Map(); // class node id -> node ids of the classes it extends
	const addNode = (n) => {
		const existing = nodeById.get(n.id);
		if (existing) {
			if (existing.source_file && n.source_file && existing.source_file !== n.source_file) {
				idCollisions.push({ id: n.id, kept: existing.source_file, dropped: n.source_file });
			}
			return existing;
		}
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
		for (const c of decls.classes) {
			if (c.methodsOverLimit) methodLimitHits.push({ file: rel, name: c.name, declared: c.methods.length + c.methodsOverLimit });
		}
		const stripped = decls.callText;
		const fileNid = fileNodeId(rel);
		const fileNode = addNode({ id: fileNid, label: path.basename(rel), file_type: "code", source_file: rel, source_location: "L1" });
		if (decls.docstring) fileNode.rationale = decls.docstring;
		// words of the file's text (comments and strings included), for `kg query`
		if (fileNode.source_file === rel && !textStats.has(rel)) {
			const tf = new Map();
			let count = 0;
			for (const m of content.matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g)) {
				if (m[0].length < 3) continue;
				const t = m[0].toLowerCase();
				tf.set(t, (tf.get(t) || 0) + 1);
				count++;
			}
			textStats.set(rel, { node: fileNode, tf, count });
		}
		const localDefs = new Map();
		const symIds = fileSymbolIds(rel, [...decls.classes, ...decls.functions, ...decls.types].map((x) => x.name), lang);

		for (const c of decls.classes) {
			const nid = symIds.get(c.name);
			addNode({ id: nid, label: c.name, file_type: "code", source_file: rel, source_location: "L" + c.line, type: c.kind && c.kind !== "struct" ? c.kind : "class" });
			addEdge(fileNid, nid, "contains", { file: rel, line: c.line });
			localDefs.set(c.name, nid);
			c.methodIds = methodNodeIds(rel, c, lang);
			if (c.methods.length) classMembers.set(nid, c.methodIds);
			for (const meth of c.methods) {
				const mid = c.methodIds.get(meth.name);
				addNode({ id: mid, label: meth.name + "()", file_type: "code", source_file: rel, source_location: "L" + meth.line, _callable: true });
				addEdge(nid, mid, "method", { file: rel, line: meth.line });
			}
		}
		for (const f of decls.functions) {
			if (localDefs.has(f.name)) continue;
			const nid = symIds.get(f.name);
			addNode({ id: nid, label: f.name + "()", file_type: "code", source_file: rel, source_location: "L" + f.line, _callable: true });
			addEdge(fileNid, nid, "defines", { file: rel, line: f.line });
			localDefs.set(f.name, nid);
		}
		for (const t of decls.types) {
			if (localDefs.has(t.name)) continue;
			const nid = symIds.get(t.name);
			addNode({ id: nid, label: t.name, file_type: "code", source_file: rel, source_location: "L" + t.line, type: t.kind });
			addEdge(fileNid, nid, "defines", { file: rel, line: t.line });
			localDefs.set(t.name, nid);
		}
		// The file's default binding: `export default function original()` is
		// imported under ANY local name (`import renamed from …`), so default
		// imports must resolve through this, never through the importer's name.
		let defaultNid = null;
		for (const c of decls.classes) if (c.isDefault && localDefs.has(c.name)) defaultNid = localDefs.get(c.name);
		for (const f of decls.functions) if (f.isDefault && localDefs.has(f.name)) defaultNid = localDefs.get(f.name);
		if (!defaultNid && decls.defaultName && localDefs.has(decls.defaultName)) defaultNid = localDefs.get(decls.defaultName);
		// Declarations below top level (inside function bodies and callbacks):
		// one node each under the declaration that holds them, repeats numbered.
		if (decls.nested && decls.nested.length) {
			const holders = [];
			for (const c of decls.classes) {
				holders.push({ nid: localDefs.get(c.name), line: c.line, end: c.end });
				for (const meth of c.methods) holders.push({ nid: c.methodIds.get(meth.name), line: meth.line, end: meth.end });
			}
			for (const f of decls.functions) holders.push({ nid: localDefs.get(f.name), line: f.line, end: f.end });
			holders.sort((a, b) => a.line - b.line);
			const used = new Map();
			for (const nd of decls.nested) {
				let parent = fileNid;
				for (const h of holders) {
					if (h.line > nd.line) break;
					if (h.nid && h.end != null && nd.line <= h.end) parent = h.nid;
				}
				const base = makeId(parent, nd.name);
				const seen = (used.get(base) || 0) + 1;
				used.set(base, seen);
				const nid = seen === 1 && !nodeById.has(base) ? base : makeId(base, String(seen));
				if (nodeById.has(nid)) continue;
				if (nd.kind === "function") addNode({ id: nid, label: nd.name + "()", file_type: "code", source_file: rel, source_location: "L" + nd.line, _callable: true });
				else addNode({ id: nid, label: nd.name, file_type: "code", source_file: rel, source_location: "L" + nd.line, type: nd.kind });
				addEdge(parent, nid, "contains", { file: rel, line: nd.line });
			}
		}
		perFile.set(rel, { lang, decls, stripped, localDefs, defaultNid, importedNames: new Map(), fileNid, lineOf: lineIndex(content) });
	}

	// -- Go: package scopes. A package is every file of one directory with one
	// package clause; functions, types and values are visible across its files,
	// and a method joins its receiver type from whichever file declares it.
	const goScopes = new Map();
	const goScopeOf = (dir, name) => {
		const k = dir + "\n" + name;
		let s = goScopes.get(k);
		if (!s) goScopes.set(k, s = { dir, name, files: [], funcs: new Map(), types: new Map(), values: new Map(), vars: new Map(), methods: new Map() });
		return s;
	};
	const goMethodsByName = new Map(); // repo-wide: method name -> entries
	for (const [rel, pf] of perFile) {
		if (pf.lang !== "go") continue;
		const d = pf.decls;
		const scope = goScopeOf(path.posix.dirname(rel), d.goPackage);
		pf.goScope = scope;
		scope.files.push(rel);
		for (const f of d.functions) if (!scope.funcs.has(f.name)) scope.funcs.set(f.name, { nid: pf.localDefs.get(f.name), fn: f, rel });
		for (const c of d.classes) if (!scope.types.has(c.name)) scope.types.set(c.name, { nid: pf.localDefs.get(c.name), cls: c, rel, scope });
		for (const t of d.types) if (!scope.values.has(t.name)) scope.values.set(t.name, { nid: pf.localDefs.get(t.name), rel });
		for (const [name, v] of d.goVars) if (!scope.vars.has(name)) scope.vars.set(name, { type: v.type, init: v.init, rel });
	}
	for (const [rel, pf] of perFile) {
		if (pf.lang !== "go") continue;
		const byType = new Map();
		for (const m of pf.decls.goMethods) {
			if (!byType.has(m.recvType)) byType.set(m.recvType, []);
			byType.get(m.recvType).push(m);
		}
		for (const [typeName, ms] of byType) {
			const ids = methodNodeIds(rel, { name: typeName, methods: ms }, "go");
			const owner = pf.goScope.types.get(typeName);
			let table = pf.goScope.methods.get(typeName);
			if (!table) pf.goScope.methods.set(typeName, table = new Map());
			for (const m of ms) {
				m.nid = ids.get(m.name);
				addNode({ id: m.nid, label: m.name + "()", file_type: "code", source_file: rel, source_location: "L" + m.line, _callable: true });
				if (owner) addEdge(owner.nid, m.nid, "method", { file: rel, line: m.line });
				else addEdge(pf.fileNid, m.nid, "defines", { file: rel, line: m.line });
				const entry = { nid: m.nid, fn: m, rel };
				if (!table.has(m.name)) table.set(m.name, entry);
				if (!goMethodsByName.has(m.name)) goMethodsByName.set(m.name, []);
				goMethodsByName.get(m.name).push(entry);
			}
		}
	}
	// Module paths (go.mod) map an import path to a repo directory; the package a
	// directory exports is its non-test one.
	const goModules = [];
	const goDirScope = new Map();
	if (goScopes.size) {
		const dirs = new Set();
		for (const s of goScopes.values()) {
			const parts = s.dir === "." ? [] : s.dir.split("/");
			for (let i = 0; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
			if (s.name.endsWith("_test")) continue;
			const cur = goDirScope.get(s.dir);
			if (!cur || s.files.length > cur.files.length) goDirScope.set(s.dir, s);
		}
		for (const dir of [...dirs].sort()) {
			try {
				const mod = fs.readFileSync(path.join(root, dir, "go.mod"), "utf-8").match(/^module\s+(\S+)/m);
				if (mod) goModules.push({ dir, path: mod[1] });
			} catch { /* no go.mod here */ }
		}
		goModules.sort((a, b) => b.path.length - a.path.length || (a.dir < b.dir ? -1 : 1));
	}
	const resolveGoImport = (spec) => {
		for (const m of goModules) {
			if (spec !== m.path && !spec.startsWith(m.path + "/")) continue;
			return goDirScope.get(path.posix.join(m.dir || ".", spec.slice(m.path.length + 1))) || null;
		}
		return null;
	};
	for (const pf of perFile.values()) {
		if (pf.lang !== "go") continue;
		pf.goImports = new Map(); // local name -> package scope, or null for a package outside the repo
		pf.goDot = [];
		for (const imp of pf.decls.imports) {
			imp.goScope = resolveGoImport(imp.spec);
			if (imp.goAlias === "_") continue;
			if (imp.goAlias === ".") { if (imp.goScope) pf.goDot.push(imp.goScope); continue; }
			const segs = imp.spec.split("/");
			let base = segs[segs.length - 1];
			if (/^v\d+$/.test(base) && segs.length > 1) base = segs[segs.length - 2];
			imp.goLocal = imp.goAlias || (imp.goScope ? imp.goScope.name : base.replace(/\.v\d+$/, "").replace(/^go-/, ""));
			pf.goImports.set(imp.goLocal, imp.goScope);
		}
	}
	// An in-repo import depends on the files that declare what the importer
	// names through it (`pkg.Symbol`), not on the whole package; a package used
	// for nothing nameable (blank import) falls back to its entry file.
	const goImportEdges = (rel, pf, imp) => {
		const scope = imp.goScope;
		if (!scope) return false;
		const targets = new Set();
		if (imp.goLocal) {
			const re = new RegExp("(?<![\\w.])" + imp.goLocal.replace(/[^\w]/g, "\\$&") + "\\s*\\.\\s*([A-Za-z_]\\w*)", "g");
			const seen = new Set();
			let m;
			while ((m = re.exec(pf.decls.masked)) !== null) {
				if (seen.has(m[1])) continue;
				seen.add(m[1]);
				const e = scope.funcs.get(m[1]) || scope.types.get(m[1]) || scope.values.get(m[1]);
				if (!e || !e.nid) continue;
				targets.add(e.rel);
				addEdge(pf.fileNid, e.nid, "imports", { file: rel, line: imp.line, context: "import" });
			}
		}
		if (!targets.size) {
			const own = scope.files.filter((f) => !f.endsWith("_test.go")).sort();
			const named = own.find((f) => path.posix.basename(f) === scope.name + ".go") || own.find((f) => path.posix.basename(f) === "doc.go");
			const entry = named || own[0] || scope.files[0];
			if (entry) targets.add(entry);
		}
		for (const t of [...targets].sort()) addEdge(pf.fileNid, perFile.get(t).fileNid, "imports_from", { file: rel, line: imp.line, context: "import" });
		return true;
	};
	// Type expression (as written in `ctxRel`) → the repo type it names, or null.
	const goTypeRef = (typeStr, ctxRel) => {
		if (!typeStr) return null;
		const name = typeStr.startsWith("[]") ? typeStr.slice(2) : typeStr;
		const pf = perFile.get(ctxRel);
		const dot = name.indexOf(".");
		if (dot < 0) return pf.goScope.types.get(name) || null;
		const scope = pf.goImports.get(name.slice(0, dot));
		return (scope && scope.types.get(name.slice(dot + 1))) || null;
	};
	// Methods and fields are looked up on the type, then on what it embeds
	// (Go's promotion), a few levels deep.
	const goFindMethod = (t, name, depth = 0) => {
		if (!t || depth > 4) return null;
		const table = t.scope.methods.get(t.cls.name);
		const hit = table && table.get(name);
		if (hit) return hit;
		for (const e of t.cls.embeds) {
			const r = goFindMethod(goTypeRef(e, t.rel), name, depth + 1);
			if (r) return r;
		}
		if (t.cls.underlying && t.cls.kind === "type") return null;
		return null;
	};
	const goFieldType = (t, field, depth = 0) => {
		if (!t || depth > 4) return null;
		const f = t.cls.fields.get(field);
		if (f) return { type: f, rel: t.rel };
		for (const e of t.cls.embeds) {
			if (e.split(".").pop() === field) return { type: e, rel: t.rel };
			const r = goFieldType(goTypeRef(e, t.rel), field, depth + 1);
			if (r) return r;
		}
		return null;
	};
	const goVarTypes = new Map();
	const goVarType = (v) => {
		if (v.type) return { type: v.type, rel: v.rel };
		if (goVarTypes.has(v)) return goVarTypes.get(v);
		goVarTypes.set(v, null); // cycle guard
		const t = goInitType(v.init, v.rel, new Map());
		goVarTypes.set(v, t);
		return t;
	};
	const GO_EXTERNAL = { kind: "external" };
	const goFuncNamed = (pf, name) => {
		const f = pf.goScope.funcs.get(name);
		if (f) return f;
		for (const ds of pf.goDot) { const g = ds.funcs.get(name); if (g) return g; }
		return null;
	};
	// What `name` selects on the value, package or type reached so far. A member
	// the repo does not declare (a type from outside, an interface method, a
	// func-typed field) is "external": nothing binds to it, and nothing is
	// guessed for it.
	const goMember = (cur, name) => {
		if (cur.kind === "pkg") {
			const f = cur.scope.funcs.get(name);
			if (f) return { kind: "fn", entry: f };
			const v = cur.scope.vars.get(name);
			if (v) { const t = goVarType(v); return t ? { kind: "value", type: t.type, rel: t.rel } : GO_EXTERNAL; }
			const t = cur.scope.types.get(name);
			return t ? { kind: "typename", t } : GO_EXTERNAL;
		}
		if (cur.kind === "value" || cur.kind === "typename") {
			if (cur.kind === "value" && !cur.t && cur.type.startsWith("[]")) return GO_EXTERNAL;
			const t = cur.t || goTypeRef(cur.type, cur.rel);
			if (!t) return GO_EXTERNAL;
			const m = goFindMethod(t, name);
			if (m) return { kind: "fn", entry: m };
			if (cur.kind === "typename") return GO_EXTERNAL;
			const f = goFieldType(t, name);
			return f ? { kind: "value", type: f.type, rel: f.rel } : GO_EXTERNAL;
		}
		return GO_EXTERNAL;
	};
	const goIdentRe = /[A-Za-z_]\w*/y;
	// Evaluates the selector chain that starts with the identifier at `start`
	// (`x.field.Method(args)[i].Other()`): every call it makes to a repo
	// function or method is reported through `onCall`, and the result is what
	// the chain yields (a typed value, where the types are known) with its end
	// offset.
	const goEval = (text, start, env, pf, rel, onCall) => {
		goIdentRe.lastIndex = start;
		const hm = goIdentRe.exec(text);
		if (!hm) return null;
		const head = hm[0];
		let i = start + head.length;
		let cur;
		if (env.has(head)) { const v = env.get(head); cur = v.type ? { kind: "value", type: v.type, rel: v.rel } : GO_EXTERNAL; }
		else if (pf.goImports.has(head)) { const s = pf.goImports.get(head); cur = s ? { kind: "pkg", scope: s } : GO_EXTERNAL; }
		else if (pf.goScope.vars.has(head)) { const t = goVarType(pf.goScope.vars.get(head)); cur = t ? { kind: "value", type: t.type, rel: t.rel } : GO_EXTERNAL; }
		else if (!GO_CALL_SKIP.has(head) && goFuncNamed(pf, head)) cur = { kind: "fn", entry: goFuncNamed(pf, head) };
		else if (pf.goScope.types.has(head)) cur = { kind: "typename", t: pf.goScope.types.get(head) };
		else cur = GO_EXTERNAL;
		for (;;) {
			let j = i;
			while (text[j] === " " || text[j] === "\t") j++;
			const ch = text[j];
			if (ch === ".") {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k])) k++;
				if (text[k] === "(") { // type assertion
					const e = matchClose(text, k);
					if (e < 0) break;
					const tn = goTypeName(text.slice(k + 1, e));
					cur = tn && tn !== "type" ? { kind: "value", type: tn, rel } : GO_EXTERNAL;
					i = e + 1;
					continue;
				}
				goIdentRe.lastIndex = k;
				const fm = goIdentRe.exec(text);
				if (!fm) break;
				cur = goMember(cur, fm[0]);
				i = k + fm[0].length;
				continue;
			}
			if (ch === "(") {
				const e = matchClose(text, j);
				if (e < 0) break;
				if (cur.kind === "fn") {
					onCall(cur.entry, j);
					cur = cur.entry.fn.result ? { kind: "value", type: cur.entry.fn.result, rel: cur.entry.rel } : GO_EXTERNAL;
				} else if (cur.kind === "typename") cur = { kind: "value", t: cur.t, type: cur.t.cls.name, rel: cur.t.rel }; // conversion
				else cur = GO_EXTERNAL;
				i = e + 1;
				continue;
			}
			if (ch === "[") {
				const e = matchClose(text, j);
				if (e < 0) break;
				if (cur.kind === "value" && !cur.t && cur.type.startsWith("[]")) cur = { kind: "value", type: cur.type.slice(2), rel: cur.rel };
				else if (cur.kind !== "fn" && cur.kind !== "typename") cur = GO_EXTERNAL; // generic arguments keep the function
				i = e + 1;
				continue;
			}
			break;
		}
		return { cur, end: i };
	};
	const goNoCall = () => {};
	// The type an initializer yields: a composite literal, `new(T)`, or a
	// selector chain (conversion, call result, field) that is the whole expression.
	const goInitType = (init, rel, env) => {
		const text = String(init || "").trim().replace(/^[&*]\s*/, "");
		let m;
		if ((m = text.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/))) return goTypeRef(m[1], rel) ? { type: m[1], rel } : null;
		if ((m = text.match(/^new\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\)/))) return goTypeRef(m[1], rel) ? { type: m[1], rel } : null;
		if (!/^[A-Za-z_]/.test(text)) return null;
		const r = goEval(text, 0, env, perFile.get(rel), rel, goNoCall);
		if (!r || r.cur.kind !== "value" || !/^\s*(?:$|[,;{)])/.test(text.slice(r.end))) return null;
		return r.cur.t ? { type: r.cur.t.cls.name, rel: r.cur.t.rel } : { type: r.cur.type, rel: r.cur.rel };
	};
	// Variable types inside one function: receiver, parameters (closures'
	// included) and the local declarations whose type is written or follows
	// from the initializer. Any other local is recorded with no type, so it
	// shadows a package-level name without a guess.
	const goEnvOf = (fn, pf, rel, text) => {
		const env = new Map();
		if (fn.recvName) env.set(fn.recvName, { type: fn.recvType, rel });
		for (const p of fn.params) env.set(p.name, { type: p.type, rel });
		if (fn.bodyStart < 0) return env;
		const body = text.slice(fn.bodyStart, fn.bodyEnd);
		for (const m of body.matchAll(/\bfunc\s*\(([^)]*)\)/g)) {
			for (const p of goParams(m[1])) if (!env.has(p.name)) env.set(p.name, { type: p.type, rel });
		}
		const bind = (name, t) => { if (name !== "_" && !env.has(name)) env.set(name, t || { type: null, rel }); };
		for (const ln of body.split("\n")) {
			let m;
			if ((m = ln.match(/\bvar\s+([A-Za-z_]\w*)\s+([^=\n]+?)\s*(?:=|$)/))) bind(m[1], { type: goTypeName(m[2]), rel });
			else if ((m = ln.match(/\bfor\s+(\w+)\s*(?:,\s*([A-Za-z_]\w*)\s*)?:=\s*range\s+(\S.*)$/))) {
				bind(m[1], null);
				if (m[2]) {
					const tt = /^[A-Za-z_]/.test(m[3]) ? goEval(m[3], 0, env, pf, rel, goNoCall) : null;
					const v = tt && tt.cur.kind === "value" && !tt.cur.t && tt.cur.type.startsWith("[]") ? { type: tt.cur.type.slice(2), rel: tt.cur.rel } : null;
					bind(m[2], v);
				}
			} else if ((m = ln.match(/\b([A-Za-z_]\w*)\s*((?:,\s*[A-Za-z_]\w*\s*)*):=\s*(\S.*)$/))) {
				bind(m[1], goInitType(m[3], rel, env));
				for (const other of m[2].split(",")) if (other.trim()) bind(other.trim(), null);
			}
		}
		return env;
	};
	const goHeadRe = /(?<![\w.)\]}])[A-Za-z_]\w*/g;
	const goArgRe = /[(,]\s*([A-Za-z_]\w*)\s*(?=[,)])/g;
	const goCalls = (rel, pf) => {
		const text = pf.stripped;
		const seen = new Set();
		const emit = (caller, callee, offset, relation) => {
			if (!callee || !callee.nid || callee.nid === caller) return;
			const key = caller + "|" + callee.nid;
			if (seen.has(key + "|calls") || seen.has(key + "|" + relation)) return;
			seen.add(key + "|" + relation);
			const inferred = relation === "indirect_call";
			addEdge(caller, callee.nid, relation, { file: rel, line: pf.lineOf(offset), confidence: inferred ? "INFERRED" : "EXTRACTED", score: inferred ? INFERRED_CALL_SCORE : undefined, context: "call" });
		};
		const scan = (from, to, caller, env, source) => {
			let m;
			goHeadRe.lastIndex = from;
			while ((m = goHeadRe.exec(source)) !== null && m.index < to) {
				goEval(source, m.index, env, pf, rel, (callee, at) => emit(caller, callee, at, "calls"));
			}
			const segment = source.slice(from, to);
			goArgRe.lastIndex = 0;
			while ((m = goArgRe.exec(segment)) !== null) {
				if (env.has(m[1]) || GO_CALL_SKIP.has(m[1])) continue;
				const f = goFuncNamed(pf, m[1]);
				if (f) emit(caller, f, from + m.index, "indirect_call");
			}
		};
		const taken = [];
		for (const fn of [...pf.decls.functions, ...pf.decls.goMethods]) {
			const eol = text.indexOf("\n", fn.declStart);
			taken.push([fn.declStart, fn.bodyEnd > 0 ? fn.bodyEnd + 1 : eol < 0 ? text.length : eol]);
			if (fn.bodyStart < 0) continue;
			const caller = fn.nid || pf.localDefs.get(fn.name);
			if (caller) scan(fn.bodyStart + 1, fn.bodyEnd, caller, goEnvOf(fn, pf, rel, text), text);
		}
		for (const c of pf.decls.classes) if (c.bodyStart >= 0) taken.push([c.bodyStart, c.bodyEnd + 1]);
		const outside = blankRanges(text, taken);
		scan(0, outside.length, pf.fileNid, new Map(), outside);
	};
	// Embedded types (struct in struct, interface in interface).
	for (const scope of goScopes.values()) {
		for (const t of scope.types.values()) {
			for (const e of t.cls.embeds) {
				const target = goTypeRef(e, t.rel);
				if (target && target.nid !== t.nid) addEdge(t.nid, target.nid, "embeds", { file: t.rel, line: t.cls.line });
			}
		}
	}

	// -- Rust: the module tree (`mod x;` → file, inline `mod x { … }`), each
	// module's items and `use` bindings, crates of the workspace, and impl
	// methods joined to the type they are for.
	const rsKey = (rel, inl) => rel + "\n" + inl;
	const rsScopes = new Map(); // key -> { rel, inl, items, mods: name -> key, modDecls, uses, globs, parent: key | null }
	const rsCrates = new Map(); // crate name -> its lib root file
	const rsChildOf = new Map(); // file -> key of the module that declares it
	const rsMethods = new Map(); // owner node id -> Map(method name -> [node ids])
	const RS_EXT = { ext: true };
	for (const [rel, pf] of perFile) {
		if (pf.lang !== "rust") continue;
		for (const sc of pf.decls.rsScopes.values()) {
			const mods = new Map();
			for (const [name, m] of sc.mods) mods.set(name, rsKey(rel, m.inline));
			for (const item of sc.items.values()) { item.rel = rel; item.nid = pf.localDefs.get(item.name) || null; }
			rsScopes.set(rsKey(rel, sc.inl), { rel, inl: sc.inl, items: sc.items, mods, modDecls: sc.modDecls, uses: sc.uses, globs: sc.globs, parent: sc.parent === null ? null : rsKey(rel, sc.parent) });
		}
	}
	if (rsScopes.size) {
		const dirs = new Set();
		for (const sc of rsScopes.values()) {
			const parts = sc.rel.split("/");
			for (let i = 0; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
		}
		for (const dir of [...dirs].sort()) {
			let toml;
			try { toml = fs.readFileSync(path.join(root, dir, "Cargo.toml"), "utf-8"); } catch { continue; }
			let section = "", name = null, libPath = null;
			for (const raw of toml.split("\n")) {
				const ln = raw.trim();
				if (ln.startsWith("[")) { section = ln; continue; }
				const kv = ln.match(/^(name|path)\s*=\s*"([^"]*)"/);
				if (!kv) continue;
				if (section === "[package]" && kv[1] === "name" && name === null) name = kv[2];
				else if (section === "[lib]" && kv[1] === "name") name = kv[2];
				else if (section === "[lib]" && kv[1] === "path") libPath = kv[2];
			}
			const lib = path.posix.normalize(path.posix.join(dir || ".", libPath || "src/lib.rs"));
			if (name && perFile.has(lib)) rsCrates.set(name.replace(/-/g, "_"), lib);
		}
		// `mod x;` in a.rs names a/x.rs or a/x/mod.rs; in mod.rs, lib.rs, main.rs
		// and any other crate root it names a sibling.
		const keys = [...rsScopes.keys()].sort();
		for (const key of keys) {
			const sc = rsScopes.get(key);
			if (!sc.modDecls.length) continue;
			const dir = path.posix.dirname(sc.rel);
			const base = path.posix.basename(sc.rel);
			const own = path.posix.join(dir, base.replace(/\.rs$/, ""));
			const bases = base === "mod.rs" || base === "lib.rs" || base === "main.rs" ? [dir] : [own, dir];
			const inl = sc.inl ? sc.inl.split("::") : [];
			const pf = perFile.get(sc.rel);
			for (const decl of sc.modDecls) {
				let hit = null;
				for (const b of bases) {
					const here = path.posix.join(b, ...inl);
					for (const c of [path.posix.join(here, decl.name + ".rs"), path.posix.join(here, decl.name, "mod.rs")]) {
						const cand = path.posix.normalize(c);
						if (perFile.has(cand) && cand !== sc.rel) { hit = cand; break; }
					}
					if (hit) break;
				}
				if (!hit) continue;
				sc.mods.set(decl.name, rsKey(hit, ""));
				if (!rsChildOf.has(hit)) rsChildOf.set(hit, key);
				addEdge(pf.fileNid, perFile.get(hit).fileNid, "imports_from", { file: sc.rel, line: decl.line, context: "module" });
			}
		}
	}
	const rsCrateRoot = (rel) => {
		const seen = new Set();
		while (rsChildOf.has(rel) && !seen.has(rel)) { seen.add(rel); rel = rsScopes.get(rsChildOf.get(rel)).rel; }
		return rel;
	};
	const rsParent = (key) => {
		const sc = rsScopes.get(key);
		if (!sc) return null;
		return sc.parent !== null ? sc.parent : rsChildOf.get(sc.rel) || null;
	};
	// A name in a module: { mod: key } | { item } | RS_EXT | null. `use`
	// bindings and glob imports are followed.
	const rsLookup = (key, name, depth = 0) => {
		const sc = rsScopes.get(key);
		if (!sc || depth > 8) return null;
		if (sc.mods.has(name)) return { mod: sc.mods.get(name) };
		if (sc.items.has(name)) return { item: sc.items.get(name) };
		if (sc.uses.has(name)) return rsUse(key, sc.uses.get(name), null, depth + 1);
		for (const g of sc.globs) {
			const r = rsResolve(key, g, depth + 1, true);
			if (!r || !r.mod) continue;
			const sub = rsScopes.get(r.mod);
			if (sub && (sub.mods.has(name) || sub.items.has(name) || sub.uses.has(name))) return rsLookup(r.mod, name, depth + 1);
		}
		return null;
	};
	// A path from a module: additionally { member: [item, name] } for
	// `Type::name`. Null when unknown, RS_EXT for a path outside the repo.
	const rsResolve = (key, segs, depth = 0, viaUse = false) => {
		if (!segs.length || depth > 8) return null;
		const first = segs[0];
		let cur, i = 1;
		if (first === "crate") cur = { mod: rsKey(rsCrateRoot(rsScopes.get(key).rel), "") };
		else if (first === "self") cur = { mod: key };
		else if (first === "super") {
			let k = key;
			i = 0;
			while (i < segs.length && segs[i] === "super") { k = rsParent(k); if (k === null) return null; i++; }
			cur = { mod: k };
		} else if (first === "std" || first === "core" || first === "alloc") return RS_EXT;
		else {
			const sc = rsScopes.get(key);
			cur = null;
			if (sc) {
				if (sc.mods.has(first)) cur = { mod: sc.mods.get(first) };
				else if (sc.items.has(first)) cur = { item: sc.items.get(first) };
				else if (sc.uses.has(first)) cur = rsUse(key, sc.uses.get(first), viaUse ? segs : null, depth + 1);
			}
			if (!cur && rsCrates.has(first)) cur = { mod: rsKey(rsCrates.get(first), "") };
			if (!cur && !viaUse) cur = rsLookup(key, first, depth + 1);
			if (!cur) return null;
		}
		for (; i < segs.length; i++) {
			if (!cur || !cur.mod) {
				if (cur && cur.item && i === segs.length - 1) return { member: [cur.item, segs[i]] };
				return cur && cur.ext ? RS_EXT : null;
			}
			cur = rsLookup(cur.mod, segs[i], depth + 1);
		}
		return cur;
	};
	// One `use` name can bind a type, a value and a macro (three namespaces):
	// the binding that names a module or an item of this repo wins.
	function rsUse(key, candidates, self, depth) {
		let fallback = null;
		for (const segs of candidates) {
			if (self && segs.join("::") === self.join("::")) continue;
			const r = rsResolve(key, segs, depth, true);
			if (r && (r.mod || r.item)) return r;
			if (r && !fallback) fallback = r;
		}
		return fallback;
	}
	const RS_OWNER_KINDS = new Set(["struct", "enum", "trait", "type"]);
	for (const [rel, pf] of perFile) {
		if (pf.lang !== "rust") continue;
		const d = pf.decls;
		for (const impl of d.rsImpls) {
			const key = rsKey(rel, impl.inl);
			const r = impl.typeSegs.length === 1 ? rsLookup(key, impl.typeName) : rsResolve(key, impl.typeSegs);
			let ownerNid = r && r.item && RS_OWNER_KINDS.has(r.item.kind) ? r.item.nid : null;
			if (!ownerNid) {
				// an impl for a type this repo does not declare: the block itself stands for it
				ownerNid = makeId(fileStem(rel), "impl", impl.typeName);
				addNode({ id: ownerNid, label: impl.typeName, file_type: "code", source_file: rel, source_location: "L" + impl.line, type: "impl" });
				addEdge(pf.fileNid, ownerNid, "contains", { file: rel, line: impl.line });
			}
			impl.ownerNid = ownerNid;
			let table = rsMethods.get(ownerNid);
			if (!table) rsMethods.set(ownerNid, table = new Map());
			for (const m of impl.methods) {
				m.nid = makeId(fileStem(rel), impl.typeName, m.name);
				m.ownerNid = ownerNid;
				addNode({ id: m.nid, label: m.name + "()", file_type: "code", source_file: rel, source_location: "L" + m.line, _callable: true });
				addEdge(ownerNid, m.nid, "method", { file: rel, line: m.line });
				if (!table.has(m.name)) table.set(m.name, []);
				if (!table.get(m.name).includes(m.nid)) table.get(m.name).push(m.nid);
			}
			if (impl.traitSegs && !impl.isTrait) {
				const tr = rsResolve(key, impl.traitSegs);
				if (tr && tr.item && tr.item.kind === "trait" && tr.item.nid && tr.item.nid !== ownerNid) addEdge(ownerNid, tr.item.nid, "implements", { file: rel, line: impl.line });
			}
		}
		for (const f of d.functions) f.nid = pf.localDefs.get(f.name);
		for (const nf of d.rsNested) {
			const parent = nf.parent.nid;
			if (!parent) continue;
			const nid = makeId(parent, nf.name);
			if (nodeById.has(nid)) continue;
			if (nf.kind === "fn") addNode({ id: nid, label: nf.name + "()", file_type: "code", source_file: rel, source_location: "L" + nf.line, _callable: true });
			else addNode({ id: nid, label: nf.name, file_type: "code", source_file: rel, source_location: "L" + nf.line, type: nf.kind === "enum" ? "enum" : "class" });
			addEdge(parent, nid, "contains", { file: rel, line: nf.line });
		}
	}
	// `use` paths: the file that declares the module or item, and the item itself.
	const rustImports = (rel, pf) => {
		const seen = new Set();
		const once = (target, relation, line) => {
			const k = target + "|" + relation;
			if (seen.has(k) || target === pf.fileNid) return;
			seen.add(k);
			addEdge(pf.fileNid, target, relation, { file: rel, line, context: "import" });
		};
		for (const imp of pf.decls.imports) {
			const r = rsResolve(rsKey(rel, imp.rsInl), imp.rsSegs, 0, true);
			if (r && r.mod) {
				const target = rsScopes.get(r.mod);
				if (target && target.rel !== rel) once(perFile.get(target.rel).fileNid, "imports_from", imp.line);
			} else if (r && r.item) {
				if (r.item.rel === rel) continue;
				once(perFile.get(r.item.rel).fileNid, "imports_from", imp.line);
				if (r.item.nid) once(r.item.nid, "imports", imp.line);
			} else if (r && r.member) {
				if (r.member[0].rel !== rel) once(perFile.get(r.member[0].rel).fileNid, "imports_from", imp.line);
			} else {
				const head = imp.rsSegs[0];
				if (!head || head === "crate" || head === "self" || head === "super" || rsCrates.has(head)) continue;
				let nid = makeId(head);
				const taken = nodeById.get(nid);
				if (taken && taken.source_file) nid = makeId("external", head);
				if (!nid) continue;
				addNode({ id: nid, label: head, file_type: "code", source_file: "", source_location: "", type: "module" });
				once(nid, "imports_from", imp.line);
			}
		}
	};
	const RUST_CALL_SKIP = new Set([
		"if", "while", "match", "for", "loop", "return", "fn", "let", "in", "as", "move", "async", "await", "unsafe", "where", "impl", "dyn",
		"ref", "mut", "self", "super", "crate", "Some", "Ok", "Err", "None", "Box", "Vec", "String", "drop", "else", "break", "continue", "pub", "use", "mod",
	]);
	const rsPathCallRe = /(?<![\w.:!])((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*(?:::\s*<[^<>()]*>\s*)?\(/g;
	const rsSelfCallRe = /\bself\s*\.\s*([A-Za-z_]\w*)\s*(?:::\s*<[^<>()]*>\s*)?\(/g;
	// `Name(…)` that destructures (after `let`, before `=>` or a single `=`,
	// in closure parameters) instead of constructing.
	const rsIsPattern = (segment, at, open) => {
		if (/(?:\blet\s+(?:mut\s+)?|\|\s*)$/.test(segment.slice(Math.max(0, at - 24), at))) return true;
		let k = matchClose(segment, open);
		if (k < 0) return false;
		for (k++; k < segment.length; k++) {
			const ch = segment[k];
			if (ch === ")" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
			if (ch === "=") return segment[k + 1] !== "=";
			if (ch === "|") return segment[k + 1] !== "|";
			return ch === "i" && /^if\b/.test(segment.slice(k, k + 3)) ? true : ch === ":" && segment[k + 1] !== ":";
		}
		return false;
	};
	const rsUniqueMethod = (ownerNid, name) => {
		const list = ownerNid && rsMethods.get(ownerNid) && rsMethods.get(ownerNid).get(name);
		return list && list.length === 1 ? list[0] : null;
	};
	// Calls whose target the source names outright: a function in scope, a
	// path (`module::f`, `Type::f`), `Self::f` and `self.f()` on a method the
	// type declares once. A receiver that needs type inference is left alone.
	const rustCalls = (rel, pf) => {
		const text = pf.stripped;
		const seen = new Set();
		const emit = (caller, target, offset, relation) => {
			if (!target || target === caller) return;
			const k = caller + "|" + target + "|" + relation;
			if (seen.has(k)) return;
			seen.add(k);
			addEdge(caller, target, relation, { file: rel, line: pf.lineOf(offset), context: "call" });
		};
		const scan = (segment, base, caller, key, ownerNid, locals) => {
			let m;
			rsPathCallRe.lastIndex = 0;
			while ((m = rsPathCallRe.exec(segment)) !== null) {
				const segs = m[1].split("::").map((s) => s.trim());
				const name = segs[segs.length - 1];
				if (segs.length === 1) {
					if (RUST_CALL_SKIP.has(name) || locals.has(name)) continue;
					const r = rsLookup(key, name);
					if (!r || !r.item || !r.item.nid) continue;
					if (r.item.kind === "fn") emit(caller, r.item.nid, base + m.index, "calls");
					else if (r.item.kind === "struct" && !rsIsPattern(segment, m.index, m.index + m[0].length - 1)) emit(caller, r.item.nid, base + m.index, "instantiates");
				} else if (segs[0] === "Self") {
					if (segs.length === 2) emit(caller, rsUniqueMethod(ownerNid, name), base + m.index, "calls");
				} else {
					const r = rsResolve(key, segs);
					if (!r) continue;
					if (r.item && r.item.nid) {
						if (r.item.kind === "fn") emit(caller, r.item.nid, base + m.index, "calls");
						else if (r.item.kind === "struct" && !rsIsPattern(segment, m.index, m.index + m[0].length - 1)) emit(caller, r.item.nid, base + m.index, "instantiates");
					} else if (r.member && r.member[0].nid) emit(caller, rsUniqueMethod(r.member[0].nid, r.member[1]), base + m.index, "calls");
				}
			}
			if (!ownerNid) return;
			rsSelfCallRe.lastIndex = 0;
			while ((m = rsSelfCallRe.exec(segment)) !== null) emit(caller, rsUniqueMethod(ownerNid, m[1]), base + m.index, "calls");
		};
		const taken = [];
		for (const fn of pf.decls.rsFns) {
			const eol = text.indexOf("\n", fn.declStart);
			taken.push([fn.declStart, fn.bodyEnd > 0 ? fn.bodyEnd + 1 : eol < 0 ? text.length : eol]);
			if (fn.bodyStart < 0 || !fn.nid) continue;
			const locals = new Set();
			for (const m of text.slice(fn.declStart, fn.bodyStart).matchAll(/([A-Za-z_]\w*)\s*:/g)) locals.add(m[1]);
			const body = text.slice(fn.bodyStart + 1, fn.bodyEnd);
			for (const m of body.matchAll(/\blet\s+([^=;]*)/g)) for (const id of m[1].split(":")[0].matchAll(/[a-z_]\w*/g)) locals.add(id[0]);
			for (const m of body.matchAll(/\|([^|\n]*)\|/g)) for (const id of m[1].matchAll(/([a-z_]\w*)\s*(?=[,:|]|$)/g)) locals.add(id[1]);
			for (const m of body.matchAll(/\bfor\s+([^{]*?)\s+in\b/g)) for (const id of m[1].matchAll(/[a-z_]\w*/g)) locals.add(id[0]);
			scan(body, fn.bodyStart + 1, fn.nid, rsKey(rel, fn.inl), fn.ownerNid || null, locals);
		}
		scan(blankRanges(text, taken.concat(pf.decls.rsSkip)), 0, pf.fileNid, rsKey(rel, ""), null, new Set());
	};

	// -- workspace package resolution (js/ts monorepos): each package's root
	// entry, plus its directory and `exports` map for subpath imports
	const rels = [...perFile.keys()];
	const relSet = new Set(rels);
	const workspaceEntry = new Map();
	const workspacePkg = new Map(); // package name -> { dir, exports: subpath map | null }

	// The file a module path names: as written, with a `.js`-family extension
	// swapped for a source one, or a directory's index.
	const probeModule = (base) => {
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
	};
	const probeTarget = (dir, target) => {
		const hit = probeModule(path.posix.normalize(path.posix.join(dir, target)));
		if (hit) return hit;
		const source = distToSrc(target);
		return source !== target ? probeModule(path.posix.normalize(path.posix.join(dir, source))) : null;
	};

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
				const exportMap = subpathExports(pj.exports);
				if (!workspacePkg.has(pj.name)) workspacePkg.set(pj.name, { dir, exports: exportMap });
				if (workspaceEntry.has(pj.name)) continue;
				// The root import comes from `exports["."]` alone — another subpath's
				// target (`./extension`) is not the package's entry — then the legacy
				// fields, then a conventional index. Build output (`dist/`) is mapped
				// back to the source it was compiled from (probeTarget).
				const rootTargets = [];
				if (exportMap && Object.hasOwn(exportMap, ".")) rootExportTargets(exportMap["."], rootTargets);
				for (const f of [pj.module, pj.main, pj.types, pj.typings]) if (typeof f === "string") rootTargets.push(f);
				rootTargets.push("src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js");
				for (const t of rootTargets) {
					const hit = probeTarget(dir, t.replace(/^\.\//, ""));
					if (hit) { workspaceEntry.set(pj.name, hit); break; }
				}
			} catch { /* empty */ }
		}
	}

	// A workspace subpath import (`@scope/pkg/testing`) resolves through the
	// package's `exports`: the exact key, else the `*` pattern with the
	// longest prefix (Node's rule), its targets tried in condition order. Never
	// the package root — the root does not export the subpath's names, so its
	// symbol imports and calls would be lost. A subpath the map does not
	// export is unresolved (Node refuses it); without an `exports` field the
	// subpath is a path inside the package.
	const resolveWorkspaceSubpath = (pkg, sub) => {
		if (!pkg.exports) return probeTarget(pkg.dir, sub);
		let key = Object.hasOwn(pkg.exports, sub) ? sub : null;
		let star = null;
		if (key === null) {
			let prefixLen = -1;
			for (const k of Object.keys(pkg.exports)) {
				const at = k.indexOf("*");
				if (at < 0 || at < prefixLen || (at === prefixLen && k.length <= key.length)) continue;
				const prefix = k.slice(0, at);
				const suffix = k.slice(at + 1);
				if (sub.length < k.length || !sub.startsWith(prefix) || !sub.endsWith(suffix)) continue;
				key = k;
				prefixLen = at;
				star = sub.slice(prefix.length, sub.length - suffix.length);
			}
			if (key === null) return null;
		}
		for (const target of exportTargets(pkg.exports[key])) {
			const hit = probeTarget(pkg.dir, star === null ? target : target.split("*").join(star));
			if (hit) return hit;
		}
		return null;
	};

	// Python module path → file: `pkg/__init__.py` (a package wins over a
	// same-named module, as in the import system) or `pkg/mod.py`.
	const probePyModule = (base) => {
		for (const c of [path.posix.join(base, "__init__.py"), base + ".py"]) if (relSet.has(c)) return c;
		return null;
	};
	// Dots count package levels from the importing file's own package: `.` is
	// its directory, `..` the parent. Absolute dotted paths start at the repo root.
	// Import roots: the repo root and every directory that holds a top-level
	// package (a `src/` layout, an example project). The importing file's own
	// root is tried first.
	const pyOwnRoot = (rel) => {
		const dir = path.posix.dirname(rel);
		let d = dir;
		while (d !== "." && relSet.has(d + "/__init__.py")) d = path.posix.dirname(d);
		return d === "." ? "" : d;
	};
	const pyRoots = [...new Set([""].concat(rels.filter((r) => r.endsWith(".py")).map(pyOwnRoot)))].sort();
	const probePyAbsolute = (fromRel, mod) => {
		// the file's own root, then each directory above it (a namespace package
		// has no __init__.py to mark where it starts), then the other roots
		const own = pyOwnRoot(fromRel);
		const order = [own];
		for (let d = own ? path.posix.dirname(own) : "."; d !== "."; d = path.posix.dirname(d)) order.push(d);
		order.push(...pyRoots);
		for (const r of new Set(order)) {
			const hit = probePyModule(r ? r + "/" + mod : mod);
			if (hit) return hit;
		}
		return null;
	};
	const resolvePySpec = (fromRel, spec) => {
		const dots = spec.match(/^\.*/)[0].length;
		const rest = spec.slice(dots);
		if (!/^[\w.]*$/.test(rest)) return null;
		const mod = rest.replace(/\./g, "/");
		if (!dots) return mod ? probePyAbsolute(fromRel, mod) : null;
		let dir = path.posix.dirname(fromRel);
		for (let k = 1; k < dots; k++) dir = path.posix.dirname(dir);
		if (mod) return probePyModule(path.posix.join(dir, mod));
		const init = path.posix.join(dir, "__init__.py"); // `from . import x`: the package itself
		return relSet.has(init) ? init : null;
	};

	const specMemo = new Map();
	const resolveSpecUncached = (fromRel, spec) => {
		if (perFile.get(fromRel).lang === "python") return resolvePySpec(fromRel, spec);
		if (spec.startsWith(".")) return probeModule(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)));
		if (workspaceEntry.has(spec)) return workspaceEntry.get(spec);
		const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
		if (slash > 0 && workspacePkg.has(spec.slice(0, slash))) return resolveWorkspaceSubpath(workspacePkg.get(spec.slice(0, slash)), "." + spec.slice(slash));
		return null;
	};
	const resolveSpec = (fromRel, spec) => {
		const key = fromRel + "\n" + spec;
		if (!specMemo.has(key)) specMemo.set(key, resolveSpecUncached(fromRel, spec));
		return specMemo.get(key);
	};

	// A module's exported names → defining symbol node, following re-export
	// bindings: named (`export { helper } from`, aliases, `default as X`) and
	// star (`export * from`, which never carries `default`). `export * as ns`
	// exposes only `ns`, no inner name. A barrel has no localDef for
	// pass-through names, so consumers importing through it would otherwise
	// lose their symbol-import and call edges. Built once per module (a
	// 1500-entry barrel costs one pass, not one per importer), with a cycle
	// guard: a map computed while a cycle cut part of it away is incomplete
	// for every module on that cycle except the one the cut points at, so only
	// the latter is kept.
	const reExportsOf = new Map();
	const reExportList = (rel) => {
		let list = reExportsOf.get(rel);
		if (!list) {
			list = [];
			for (const imp of perFile.get(rel).decls.imports) {
				if (!imp.reExport) continue;
				const target = resolveSpec(rel, imp.spec);
				if (target) list.push({ target, star: imp.namespace === "*", names: imp.names });
			}
			reExportsOf.set(rel, list);
		}
		return list;
	};
	const NO_EXPORTS = new Map();
	const exportMaps = new Map();
	const exportsInProgress = new Map(); // rel -> depth on the resolution stack
	let cutDepth = Infinity; // shallowest in-progress module a cycle cut pointed at
	const exportsOf = (rel) => {
		const done = exportMaps.get(rel);
		if (done) return done;
		const pf = perFile.get(rel);
		if (!pf) return NO_EXPORTS;
		const depth = exportsInProgress.get(rel);
		if (depth !== undefined) { cutDepth = Math.min(cutDepth, depth); return NO_EXPORTS; }
		const myDepth = exportsInProgress.size;
		exportsInProgress.set(rel, myDepth);
		const outerCut = cutDepth;
		cutDepth = Infinity;
		const map = new Map(pf.localDefs);
		if (pf.defaultNid) map.set("default", pf.defaultNid);
		// `export { a as b }`: a local declaration, or a name this module imported
		for (const le of pf.decls.localExports || []) {
			if (map.has(le.exported) && le.exported === le.local) continue;
			let nid = pf.localDefs.get(le.local) || null;
			if (!nid) {
				for (const imp of pf.decls.imports) {
					if (imp.reExport || imp.dynamic) continue;
					const target = resolveSpec(rel, imp.spec);
					if (!target) continue;
					if (imp.default === le.local) nid = perFile.get(target).defaultNid || exportsOf(target).get("default") || null;
					const named = imp.names.find((x) => x.local === le.local);
					if (named) nid = exportsOf(target).get(named.imported) || null;
					if (nid) break;
				}
			}
			if (nid) map.set(le.exported, nid);
		}
		for (const re of reExportList(rel)) {
			const target = exportsOf(re.target);
			if (re.star) {
				for (const [name, nid] of target) if (name !== "default" && !map.has(name)) map.set(name, nid);
			} else {
				for (const n of re.names) {
					const nid = !map.has(n.local) && target.get(n.imported);
					if (nid) map.set(n.local, nid);
				}
			}
		}
		exportsInProgress.delete(rel);
		if (cutDepth >= myDepth) {
			exportMaps.set(rel, map);
			cutDepth = outerCut;
		} else cutDepth = Math.min(outerCut, cutDepth);
		return map;
	};
	// A Python module exports every name it imports, and Python packages
	// import each other in cycles as a matter of course, so a name is followed
	// on its own (memoized per module and name) instead of through whole
	// export maps: local declaration, else the import that binds it, else a
	// star import.
	const pyExported = new Map();
	const resolvePyExported = (rel, name, depth = 0) => {
		const key = rel + "\n" + name;
		if (pyExported.has(key)) return pyExported.get(key);
		const pf = perFile.get(rel);
		if (!pf || depth > 12) return null;
		pyExported.set(key, null); // cycle guard
		let nid = pf.localDefs.get(name) || null;
		if (!nid) {
			for (const imp of pf.decls.imports) {
				const bound = imp.names.find((x) => x.local === name);
				if (!bound) continue;
				const target = resolveSpec(rel, imp.spec);
				if (target) nid = resolvePyExported(target, bound.imported, depth + 1);
				if (nid) break;
			}
		}
		if (!nid) {
			for (const imp of pf.decls.imports) {
				if (!imp.names.some((x) => x.imported === "*")) continue;
				const target = resolveSpec(rel, imp.spec);
				if (target) nid = resolvePyExported(target, name, depth + 1);
				if (nid) break;
			}
		}
		pyExported.set(key, nid);
		return nid;
	};
	const resolveExported = (rel, name) => {
		const pf = perFile.get(rel);
		if (pf && pf.lang === "python") return resolvePyExported(rel, name);
		return exportsOf(rel).get(name) || null;
	};
	// The symbol a module's default import binds to: its own default
	// declaration, else what it re-exports as `default`.
	const defaultOf = (rel) => {
		const pf = perFile.get(rel);
		return pf ? pf.defaultNid || resolveExported(rel, "default") : null;
	};

	// The def (function or method) whose body holds 1-based `line`, innermost.
	const pyDefRegion = (pf, line) => {
		let best = null;
		const consider = (f) => {
			if (f.line < line && f.end != null && line <= f.end && (!best || f.line > best.start)) best = { start: f.line, end: f.end };
		};
		for (const f of pf.decls.functions) consider(f);
		for (const c of pf.decls.classes) for (const m of c.methods) consider(m);
		return best;
	};
	// What `name` was imported as, seen from `line`: a def's own imports first.
	const importedAt = (pf, name, line) => {
		if (line && pf.scopedImports) {
			let hit = null, hitStart = -1;
			for (const sc of pf.scopedImports) {
				if (line >= sc.start && line <= sc.end && sc.start >= hitStart && sc.map.has(name)) { hit = sc.map.get(name); hitStart = sc.start; }
			}
			if (hit) return hit;
		}
		return pf.importedNames.get(name);
	};
	// -- phase 3: import edges
	// Directory names and module stems the repo itself provides: a top-level
	// package the repo defines (a `src/` layout the root-relative resolver
	// misses) is not proof of an external import.
	const repoNames = new Set();
	for (const rel of rels) for (const part of rel.split("/")) repoNames.add(part.replace(/\.[^.]+$/, ""));
	for (const rel of rels) {
		const pf = perFile.get(rel);
		if (pf.lang === "rust") { rustImports(rel, pf); continue; }
		for (const imp of pf.decls.imports) {
			if (pf.lang === "go" && goImportEdges(rel, pf, imp)) continue;
			let bind = pf.importedNames;
			if (pf.lang === "python") {
				const region = pyDefRegion(pf, imp.line);
				if (region) {
					bind = new Map();
					(pf.scopedImports ||= []).push({ start: region.start, end: region.end, map: bind });
				}
			}
			const resolved = resolveSpec(rel, imp.spec);
			let targetFileNid;
			if (resolved) {
				targetFileNid = perFile.get(resolved).fileNid;
			} else {
				// external module node (concept-style: no source_file, like graphify module nodes)
				targetFileNid = makeId(imp.spec);
				if (!targetFileNid) continue;
				// `models` (or `.models`) must not merge with the repo's own models.py.
				const taken = nodeById.get(targetFileNid);
				if (taken && taken.source_file) targetFileNid = makeId("external", imp.spec);
				addNode({ id: targetFileNid, label: imp.spec, file_type: "code", source_file: "", source_location: "", type: "module" });
				// Names imported from a package outside the repo stay with that
				// import: they never fall back to a same-named repo symbol.
				if (!imp.spec.startsWith(".") && !imp.dynamic && !repoNames.has(imp.spec.split(/[./]/)[0])) {
					for (const n of imp.names) bind.set(n.local, { rel: null, name: n.imported, nid: null, external: true });
					if (imp.default) bind.set(imp.default, { rel: null, name: "default", nid: null, external: true });
					if (imp.namespace && imp.namespace !== "*" && !imp.reExport) bind.set(imp.namespace, { rel: null, name: "*", nid: null, external: true });
				}
			}
			const relation = imp.dynamic ? "dynamic_import" : imp.reExport ? "re_exports" : "imports_from";
			// Python: `from pkg import mod` imports the submodule, `from m import *`
			// brings every name of m into scope.
			let names = imp.names;
			if (pf.lang === "python" && resolved && names.length) {
				const rest = [];
				for (const n of names) {
					if (n.imported === "*") { (pf.starImports ||= []).push(resolved); continue; }
					const sub = resolved.endsWith("/__init__.py") || resolved === "__init__.py" ? probePyModule(path.posix.join(path.posix.dirname(resolved), n.imported)) : null;
					if (sub && !perFile.get(resolved).localDefs.has(n.imported)) {
						addEdge(pf.fileNid, perFile.get(sub).fileNid, relation, { file: rel, line: imp.line, context: "import" });
						bind.set(n.local, { rel: sub, name: "*", nid: null });
					} else rest.push(n);
				}
				if (!rest.length && names.some((n) => n.imported !== "*")) continue;
				names = rest;
			}
			addEdge(pf.fileNid, targetFileNid, relation, { file: rel, line: imp.line, context: "import", deferred: imp.dynamic || undefined });
			// symbol-level imports edges (only when target resolves in-repo)
			if (resolved && !imp.dynamic) {
				const tpf = perFile.get(resolved);
				for (const n of names) {
					const tnid = tpf.localDefs.get(n.imported) || resolveExported(resolved, n.imported);
					if (tnid) {
						if (!imp.reExport) addEdge(pf.fileNid, tnid, "imports", { file: rel, line: imp.line, context: "import" });
						bind.set(n.local, { rel: resolved, name: n.imported, nid: tnid });
					} else {
						bind.set(n.local, { rel: resolved, name: n.imported, nid: null });
					}
				}
				if (imp.default) bind.set(imp.default, { rel: resolved, name: "default", nid: defaultOf(resolved) });
				// `export * as ns from` binds `ns` for importers of this module, not here.
				if (imp.namespace && imp.namespace !== "*" && !imp.reExport) bind.set(imp.namespace, { rel: resolved, name: "*", nid: null, cjs: imp.cjs || undefined });
			}
		}
	}

	// -- phase 4: inherits / implements / extends
	const resolveName = (pf, name, line) => {
		// local → import evidence → a star import → null. A name nothing in the
		// file accounts for is not guessed from the rest of the repo.
		const scoped = line && pf.scopedImports ? importedAt(pf, name, line) : null;
		if (pf.localDefs.has(name) && (!scoped || scoped === pf.importedNames.get(name))) return { nid: pf.localDefs.get(name), confidence: "EXTRACTED" };
		const imp = scoped || pf.importedNames.get(name);
		if (imp && imp.nid) return { nid: imp.nid, confidence: "EXTRACTED" };
		if (imp && imp.external) return null;
		if (imp && imp.rel) {
			const tpf = perFile.get(imp.rel);
			// A default import binds to the TARGET's default declaration,
			// whatever local name the importer chose.
			const t = imp.name === "default"
				? defaultOf(imp.rel)
				: (tpf && (tpf.localDefs.get(imp.name) || resolveExported(imp.rel, imp.name)));
			if (t) return { nid: t, confidence: "EXTRACTED" };
			return null;
		}
		for (const star of pf.starImports || []) {
			const t = resolveExported(star, name);
			if (t) return { nid: t, confidence: "EXTRACTED" };
		}
		return null;
	};
	for (const rel of rels) {
		const pf = perFile.get(rel);
		for (const c of pf.decls.classes) {
			const cnid = pf.localDefs.get(c.name);
			if (!cnid) continue;
			for (const base of c.bases || []) {
				let r = null;
				if (base.module) {
					const ns = pf.importedNames.get(base.module);
					const t = ns && ns.name === "*" && ns.rel ? (perFile.get(ns.rel).localDefs.get(base.name) || resolveExported(ns.rel, base.name)) : null;
					if (t) r = { nid: t, confidence: "EXTRACTED" };
				} else if (!BUILTIN_NOISE_LABELS.has(base.name)) r = resolveName(pf, base.name);
				if (r && r.nid !== cnid && nodeById.get(r.nid) && nodeById.get(r.nid).type === "class") {
					addEdge(cnid, r.nid, "inherits", { file: rel, line: c.line, confidence: r.confidence });
					if (!baseOf.has(cnid)) baseOf.set(cnid, []);
					baseOf.get(cnid).push(r.nid);
				}
			}
			if (c.extends && !BUILTIN_NOISE_LABELS.has(c.extends)) {
				const r = resolveName(pf, c.extends);
				if (r) {
					addEdge(cnid, r.nid, "inherits", { file: rel, line: c.line, confidence: r.confidence, score: r.confidence === "INFERRED" ? INFERRED_CALL_SCORE : undefined });
					if (!baseOf.has(cnid)) baseOf.set(cnid, []);
					baseOf.get(cnid).push(r.nid);
				}
			}
			for (const iface of c.implements || []) {
				if (BUILTIN_NOISE_LABELS.has(iface)) continue;
				const r = resolveName(pf, iface);
				if (r) addEdge(cnid, r.nid, "implements", { file: rel, line: c.line, confidence: r.confidence, score: r.confidence === "INFERRED" ? INFERRED_CALL_SCORE : undefined });
			}
		}
		for (const t of pf.decls.types) {
			if (!pf.localDefs.has(t.name)) continue;
			for (const base of t.extendsAll || (t.extends ? [t.extends] : [])) {
				const r = resolveName(pf, base);
				if (r && r.nid !== pf.localDefs.get(t.name)) addEdge(pf.localDefs.get(t.name), r.nid, "extends", { file: rel, line: t.line, confidence: r.confidence });
			}
		}
	}

	// A member of a class: its own, or the nearest base class's (`from` skips
	// the class itself).
	const memberOf = (classNid, name, from, depth = 0) => {
		if (!classNid || depth > 5) return null;
		if (depth >= from) {
			const own = classMembers.get(classNid);
			if (own && own.has(name)) return own.get(name);
		}
		for (const base of baseOf.get(classNid) || []) {
			const hit = memberOf(base, name, 0, depth + 1);
			if (hit) return hit;
		}
		return null;
	};
	// Method names one class of the repo declares and no other, per language
	// family: what a call on a receiver of unknown type most plausibly reaches.
	// Names the language's own objects answer to are never guessed.
	const methodsByName = new Map();
	for (const [classNid, members] of classMembers) {
		const node = nodeById.get(classNid);
		const lang = node && node.source_file ? perFile.get(node.source_file).lang : null;
		if (!lang) continue;
		const family = LANG_FAMILY[lang];
		if (!methodsByName.has(family)) methodsByName.set(family, new Map());
		const table = methodsByName.get(family);
		for (const [name, mid] of members) {
			if (!table.has(name)) table.set(name, new Set());
			table.get(name).add(mid);
		}
	}
	const uniqueMethod = (lang, name) => {
		if (name.length < 4 || COMMON_METHOD_NAMES.has(name)) return null;
		const table = methodsByName.get(LANG_FAMILY[lang]);
		const set = table && table.get(name);
		return set && set.size === 1 ? [...set][0] : null;
	};

	// -- phase 5: calls / instantiates / indirect_call
	for (const rel of rels) {
		const pf = perFile.get(rel);
		if (pf.lang === "go") { goCalls(rel, pf); continue; }
		if (pf.lang === "rust") { rustCalls(rel, pf); continue; }
		const lines = pf.stripped.split("\n");
		// symbol regions: decl line → tracked body end (brace depth), falling
		// back to open-ended (next-anchor semantics) where no end was tracked.
		// A top-level call AFTER a function's closing brace belongs to the
		// file, not to that function.
		const anchors = [];
		for (const c of pf.decls.classes) {
			const classNid = pf.localDefs.get(c.name);
			for (const meth of c.methods) anchors.push({ nid: c.methodIds.get(meth.name), line: meth.start || meth.line, decl: meth.line, headerEnd: meth.bodyStart > 0 ? pf.lineOf(meth.bodyStart) : meth.line, body: meth.bodyStart, end: meth.end != null ? meth.end : null, cls: c, classNid });
			anchors.push({ nid: classNid, line: c.start || c.line, decl: c.line, end: c.end != null ? c.end : null, isClass: true, cls: c, classNid });
		}
		for (const f of pf.decls.functions) anchors.push({ nid: pf.localDefs.get(f.name), line: f.start || f.line, decl: f.line, headerEnd: f.bodyStart > 0 ? pf.lineOf(f.bodyStart) : f.line, body: f.bodyStart, end: f.end != null ? f.end : null });
		anchors.sort((a, b) => a.line - b.line);
		const regionAt = (lineNo) => {
			let cur = null;
			for (const a of anchors) {
				if (a.line > lineNo) break;
				if (a.end == null || lineNo <= a.end) cur = a;
			}
			return cur;
		};
		const regionOf = (lineNo) => {
			const a = regionAt(lineNo);
			return a ? a.nid : pf.fileNid;
		};
		// Names a function binds itself (parameters, local declarations) and the
		// class types written or constructed for them. A local name shadows a
		// file-level or imported one; a typed one says which class `x.method()`
		// is called on.
		const py = pf.lang === "python";
		const regionInfo = new Map();
		const infoOf = (a) => {
			let info = regionInfo.get(a);
			if (info) return info;
			info = { locals: new Set(), types: new Map() };
			regionInfo.set(a, info);
			if (a.end == null || a.isClass) return info;
			const note = (name, type) => {
				if (!name) return;
				info.locals.add(name);
				if (type && !info.types.has(name)) info.types.set(name, type);
			};
			// parameters: the first parenthesised list of the header
			let headerEnd = a.decl;
			{
				let text = "", open = -1, close = -1;
				for (let l = a.decl; l <= a.end && l < a.decl + 60; l++) {
					text += (lines[l - 1] || "") + "\n";
					if (open < 0) open = text.indexOf("(");
					if (open >= 0) close = matchClose(text, open);
					headerEnd = l;
					if (close >= 0 || (open < 0 && l >= (a.headerEnd || a.decl))) break;
				}
				if (open >= 0 && close > open && !py) {
					for (const [name, type] of paramBindings(text.slice(open + 1, close))) note(name, type);
				} else if (open >= 0 && close > open) {
					for (const piece of splitTopLevel(text.slice(open + 1, close))) {
						const pm = piece.match(/^\s*(?:\*{1,2}|\.\.\.)?(?:(?:public|private|protected|readonly|override)\s+)*([A-Za-z_$][\w$]*)\??\s*(?::\s*["']?([A-Za-z_$][\w$.]*))?/);
						if (pm) note(pm[1], pm[2]);
						else for (const id of piece.split("=")[0].split(":")[0].matchAll(/[A-Za-z_$][\w$]*/g)) note(id[0]); // a destructured parameter
					}
				}
				headerEnd = Math.min(Math.max(headerEnd, a.headerEnd || a.decl), a.end);
			}
			for (let l = py ? headerEnd + 1 : a.decl; l <= a.end; l++) {
				const ln = lines[l - 1] || "";
				let m;
				if (py) {
					if ((m = ln.match(/^\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w.]*))?[^=\n]*=(?!=)\s*(?:([A-Za-z_][\w.]*)\s*\()?/))) note(m[1], m[2] || m[3]);
					else if ((m = ln.match(/^\s+(?:async\s+)?for\s+([^:]*?)\s+in\b/))) for (const id of m[1].matchAll(/[A-Za-z_]\w*/g)) note(id[0]);
					for (const w of ln.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) note(w[1]);
				} else {
					const declRe = /\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$.]*)[^=;]*)?(?:=\s*(?:await\s+)?(?:new\s+([A-Za-z_$][\w$.]*))?)?|[[{]([^=]*?)[\]}]\s*=)/g;
					while ((m = declRe.exec(ln)) !== null) {
						if (m[1]) note(m[1], m[2] || m[3]);
						else for (const id of (m[4] || "").matchAll(/(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)/g)) note(id[1]);
					}
					for (const w of ln.matchAll(/\(([^()]*)\)\s*(?::[^=;{]+)?=>/g)) for (const [name, type] of paramBindings(w[1])) note(name, type);
					// `x => …` binds x; the return type of `(a): Type => …` binds nothing
					for (const w of ln.matchAll(/(?<![\w$.])(?<!\)\s*:\s*)([A-Za-z_$][\w$]*)\s*=>/g)) note(w[1]);
					if ((m = ln.match(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/))) note(m[1]);
					for (const w of ln.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) for (const [name] of paramBindings(w[1])) note(name);
				}
			}
			return info;
		};
		// Outside every indexed declaration (a callback, a function assigned to a
		// property): `name` declared with var/let/const in a block that encloses
		// `lineNo`, found by walking outward through less-indented lines.
		const indentOf = (t) => t.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
		const shadowedAbove = (name, lineNo) => {
			let indent = indentOf(lines[lineNo - 1] || "");
			if (indent === 0) return false;
			const re = new RegExp("\\b(?:var|let|const)\\s+(?:[^;=]*,\\s*)?" + name.replace(/[$]/g, "\\$&") + "\\b|^\\s*,\\s*" + name.replace(/[$]/g, "\\$&") + "\\s*=");
			for (let l = lineNo - 1; l >= 1 && l > lineNo - 600; l--) {
				const t = lines[l - 1];
				if (!t || !t.trim()) continue;
				const ind = indentOf(t);
				if (ind > indent) continue;
				if (ind === 0) return false;
				if (re.test(t)) return true;
				indent = ind;
			}
			return false;
		};
		// Field types of the classes in this file: written (`agent: Agent`,
		// constructor parameter properties) or constructed (`self.pool = Pool()`).
		const fieldTypes = (c) => {
			if (c.fieldTypes) return c.fieldTypes;
			c.fieldTypes = new Map(c.fields || []);
			if (c.end == null) return c.fieldTypes;
			for (let l = c.line; l <= c.end; l++) {
				const ln = lines[l - 1] || "";
				if (py) {
					for (const m of ln.matchAll(/\bself\.([A-Za-z_]\w*)\s*(?::\s*["']?([A-Za-z_][\w.]*))?[^=\n]*=(?!=)\s*(?:([A-Za-z_][\w.]*)\s*\()?/g)) {
						if ((m[2] || m[3]) && !c.fieldTypes.has(m[1])) c.fieldTypes.set(m[1], m[2] || m[3]);
					}
				} else {
					for (const m of ln.matchAll(/\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$.]*)/g)) if (!c.fieldTypes.has(m[1])) c.fieldTypes.set(m[1], m[2]);
					for (const m of ln.matchAll(/\bthis\.(#?[A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)/g)) if (!c.fieldTypes.has(m[1])) c.fieldTypes.set(m[1], m[2]);
				}
			}
			return c.fieldTypes;
		};
		// The class a type name written in this file refers to (node id), or null.
		const classNamed = (typeName, line) => {
			if (!typeName) return null;
			const parts = typeName.split(".");
			let r = null;
			if (parts.length === 1) r = resolveName(pf, parts[0], line);
			else {
				const ns = importedAt(pf, parts.slice(0, -1).join("."), line);
				const t = ns && ns.name === "*" && ns.rel ? (perFile.get(ns.rel).localDefs.get(parts[parts.length - 1]) || resolveExported(ns.rel, parts[parts.length - 1])) : null;
				if (t) r = { nid: t };
			}
			const node = r && nodeById.get(r.nid);
			return node && node.type === "class" ? r.nid : null;
		};
		// `name` at `lineNo` is a parameter or local of the enclosing function
		// (or, outside every declaration, of an enclosing block), not the
		// file-level or imported name.
		const shadowedAt = (name, lineNo) => {
			const region = regionAt(lineNo);
			if (region && !region.isClass && pf.localDefs.get(name) !== region.nid && infoOf(region).locals.has(name) && !(pf.scopedImports && importedAt(pf, name, lineNo) !== pf.importedNames.get(name))) return true;
			return !region && !py && shadowedAbove(name, lineNo);
		};
		// TypeScript: the type annotations of a declaration's parameters and its
		// return type, as [from, to) columns per line. A method signature written
		// there (`cfg: { log(): void }`) is not a call; a default value is not
		// part of the span.
		const typeSpans = new Map(); // 0-based line → [[from, to)]
		if (pf.lang === "typescript") {
			const text = pf.stripped;
			const lineStart = [0];
			for (const ln of lines) lineStart.push(lineStart[lineStart.length - 1] + ln.length + 1);
			const mark = (from, to) => {
				for (let l = pf.lineOf(from) - 1; l < lines.length && lineStart[l] < to; l++) {
					const a = Math.max(from, lineStart[l]) - lineStart[l], b = Math.min(to, lineStart[l + 1]) - lineStart[l];
					if (a >= b) continue;
					if (!typeSpans.has(l)) typeSpans.set(l, []);
					typeSpans.get(l).push([a, b]);
				}
			};
			for (const a of anchors) {
				if (a.isClass) continue;
				// the header ends at the body's brace; a brace-less arrow has none
				// and is bounded by its last line
				const bound = a.body > 0 ? a.body : a.end != null ? lineStart[Math.min(a.end, lines.length)] : -1;
				const open = text.indexOf("(", lineStart[a.decl - 1]);
				if (open < 0 || open >= bound) continue;
				const close = matchClose(text, open);
				if (close < 0 || close >= bound) continue;
				let depth = 0, angle = 0, from = -1, inDefault = false;
				for (let k = open + 1; k <= close; k++) {
					const ch = text[k];
					if (k === close || (depth === 0 && angle === 0 && (ch === "," || (ch === "=" && text[k + 1] !== ">")))) {
						if (from >= 0) mark(from, k);
						from = -1;
						angle = 0;
						inDefault = ch === "=";
					} else if (ch === "(" || ch === "[" || ch === "{") depth++;
					else if (ch === ")" || ch === "]" || ch === "}") depth--;
					else if (from >= 0 && ch === "<") angle++;
					else if (from >= 0 && ch === ">" && text[k - 1] !== "=") angle = Math.max(0, angle - 1);
					else if (ch === ":" && depth === 0 && from < 0 && !inDefault) from = k + 1;
				}
				let k = close + 1;
				while (k < bound && /\s/.test(text[k])) k++;
				if (text[k] !== ":") continue;
				let to = a.body > 0 ? a.body : -1;
				for (let q = k + 1, d = 0; to < 0 && q < bound; q++) {
					const ch = text[q];
					if (ch === "(" || ch === "[" || ch === "{") d++;
					else if (ch === ")" || ch === "]" || ch === "}") d--;
					else if (d === 0 && ch === "=" && text[q + 1] === ">") to = q;
				}
				if (to > k) mark(k + 1, to);
			}
		}
		// A declaration's own name on its header line (`load(): object {`,
		// `def load(self):`) is not a call to whatever `load` the file imports.
		const declNames = new Map(); // 1-based line → names declared there
		const noteDecl = (name, line) => {
			if (!declNames.has(line)) declNames.set(line, new Set());
			declNames.get(line).add(name);
		};
		for (const c of pf.decls.classes) {
			noteDecl(c.name, c.line);
			for (const meth of c.methods) noteDecl(meth.name, meth.line);
		}
		for (const f of pf.decls.functions) noteDecl(f.name, f.line);
		const seenCalls = new Set();
		// Lookbehind (not a consuming prefix): a consumed delimiter would hide
		// the NEXT match in nested calls like `outer(inner())`.
		const callRe = /(?<![\w.$#])([A-Za-z_$][\w$]*)\s*\(/g;
		const newRe = /\bnew\s+([A-Za-z_$][\w$.]*)\s*[(<]/g;
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i];
			let m;
			callRe.lastIndex = 0;
			const headerNames = declNames.get(i + 1);
			const headerSeen = headerNames ? new Set() : null;
			while ((m = callRe.exec(ln)) !== null) {
				const name = m[1];
				if (CALL_KEYWORDS.has(name)) continue;
				if (headerNames && headerNames.has(name) && !headerSeen.has(name)) { headerSeen.add(name); continue; }
				const spans = typeSpans.get(i);
				if (spans && spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
				const region = regionAt(i + 1);
				const caller = region ? region.nid : pf.fileNid;
				// a parameter or local of the enclosing function, not the file-level name
				if (region && !region.isClass && pf.localDefs.get(name) !== region.nid && infoOf(region).locals.has(name) && !(pf.scopedImports && importedAt(pf, name, i + 1) !== pf.importedNames.get(name))) continue;
				if (!region && !py && shadowedAbove(name, i + 1)) continue;
				let r = resolveName(pf, name, i + 1);
				if (!r && !pf.localDefs.has(name)) {
					const bound = importedAt(pf, name, i + 1);
					if (bound && bound.cjs && bound.rel) {
						// the function the module assigns to module.exports, else the module itself
						const moduleNid = defaultOf(bound.rel) || perFile.get(bound.rel).fileNid;
						const key = caller + "|" + moduleNid + "|calls";
						if (moduleNid !== caller && !seenCalls.has(key)) {
							seenCalls.add(key);
							addEdge(caller, moduleNid, "calls", { file: rel, line: i + 1, context: "call" });
						}
					}
				}
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
			// this.x()/self.x() → the ENCLOSING class's method, never an earlier
			// unrelated class that happens to share the method name.
			let sm;
			const selfRe = /\b(?:this|self)\.(#?[A-Za-z_$][\w$]*)\s*\(/g;
			while ((sm = selfRe.exec(ln)) !== null) {
				const caller = regionOf(i + 1);
				let owner = null;
				for (const c of pf.decls.classes) {
					if (c.line > i + 1) continue;
					if (c.end != null && i + 1 > c.end) continue;
					if (c.methods.some((x) => x.name === sm[1])) owner = c;
				}
				let mid = owner ? owner.methodIds.get(sm[1]) : null;
				if (!mid) {
					const region = regionAt(i + 1);
					if (region && region.classNid) mid = memberOf(region.classNid, sm[1], 1);
				}
				if (mid) {
					const key = caller + "|" + mid + "|calls";
					if (!seenCalls.has(key) && mid !== caller) { seenCalls.add(key); addEdge(caller, mid, "calls", { file: rel, line: i + 1, context: "call" }); }
				}
			}
			// ns.member() through a known imported namespace — `import * as util
			// from './util.js'; util.helper()` must record a call edge; the bare
			// callRe deliberately excludes dotted names. The receiver must START
			// a reference (`other.util.helper()` is a property chain, not the
			// import) and must not be shadowed by a module-level declaration.
			// Lookbehind, not a consuming prefix: `util.outer(util.inner())`
			// must match the inner call too.
			const nsCallRe = /(?<![\w.$#])((?:[A-Za-z_$][\w$]*\.)+)([A-Za-z_$][\w$]*)\s*\(/g;
			let nc;
			while ((nc = nsCallRe.exec(ln)) !== null) {
				const recv = nc[1].slice(0, -1);
				if (recv === "this" || recv === "self") continue;
				if (pf.localDefs.has(recv.split(".")[0]) && !pf.localDefs.has(recv)) continue;
				let tnid = null, relation = "calls";
				const imp = importedAt(pf, recv, i + 1);
				if (imp && imp.name === "*" && imp.rel && !pf.localDefs.has(recv)) {
					const tpfNs = perFile.get(imp.rel);
					tnid = (tpfNs && tpfNs.localDefs.get(nc[2])) || resolveExported(imp.rel, nc[2]);
				} else {
					const region = regionAt(i + 1);
					const segs = recv.split(".");
					let typeName = null, known = false;
					if ((segs[0] === "this" || segs[0] === "self") && segs.length === 2 && region && region.cls) {
						typeName = fieldTypes(region.cls).get(segs[1]) || null;
					} else if (segs.length === 1) {
						// `Name.member()` on a class of the repo: a static or class method
						const owner = region && !region.isClass && infoOf(region).locals.has(recv) ? null : resolveName(pf, recv, i + 1);
						if (owner) {
							known = true;
							tnid = nodeById.get(owner.nid) && nodeById.get(owner.nid).type === "class" ? memberOf(owner.nid, nc[2], 0) : null;
						} else {
							const bound = importedAt(pf, recv, i + 1);
							if (bound && !(region && !region.isClass && infoOf(region).locals.has(recv))) known = true; // an import: its members are not this repo's methods
							else if (region && !region.isClass) typeName = infoOf(region).types.get(recv) || null;
						}
					}
					if (!tnid && !known) {
						const cls = classNamed(typeName, i + 1);
						if (cls) tnid = memberOf(cls, nc[2], 0);
						else if (!typeName || !importedAt(pf, typeName.split(".")[0], i + 1) || !importedAt(pf, typeName.split(".")[0], i + 1).external) {
							tnid = uniqueMethod(pf.lang, nc[2]);
							if (tnid) relation = "inferred";
						}
					}
				}
				if (!tnid) continue;
				const target = nodeById.get(tnid);
				if (!target) continue;
				if (!target._callable) {
					if (target.type !== "class" || pf.lang !== "python") continue;
					relation = "instantiates";
				}
				const caller = regionOf(i + 1);
				if (tnid === caller) continue;
				const inferred = relation === "inferred";
				if (inferred) relation = "calls";
				const key = caller + "|" + tnid + "|" + relation;
				if (seenCalls.has(key)) continue;
				seenCalls.add(key);
				addEdge(caller, tnid, relation, { file: rel, line: i + 1, context: "call", confidence: inferred ? "INFERRED" : undefined, score: inferred ? INFERRED_CALL_SCORE : undefined });
			}
			newRe.lastIndex = 0;
			while ((m = newRe.exec(ln)) !== null) {
				const name = m[1].split(".")[0];
				if (shadowedAt(name, i + 1)) continue;
				const r = resolveName(pf, name, i + 1);
				if (!r) continue;
				const caller = regionOf(i + 1);
				const key = caller + "|" + r.nid + "|instantiates";
				if (seenCalls.has(key) || r.nid === caller) continue;
				seenCalls.add(key);
				addEdge(caller, r.nid, "instantiates", { file: rel, line: i + 1, confidence: r.confidence, context: "call" });
			}
			// indirect_call: known callable passed as a bare argument — f(cb) / f(x, cb).
			// The delimiter after the name is a lookahead: consuming it would hide
			// the next argument's leading comma (`f(a, b, c)` would lose `b`).
			const argRe = /[(,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/g;
			while ((m = argRe.exec(ln)) !== null) {
				const name = m[1];
				if (CALL_KEYWORDS.has(name)) continue;
				if (shadowedAt(name, i + 1)) continue;
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

	// -- file keywords: each file's most distinctive words
	{
		const df = new Map();
		for (const st of textStats.values()) for (const t of st.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
		const N = textStats.size || 1;
		const idfOf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
		for (const st of textStats.values()) {
			if (!st.count) continue;
			st.node.terms = fileKeywords(st.tf, idfOf);
			st.node.tokens = st.count;
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

	return { nodes, edges: dedupedEdges, communities, idCollisions, methodLimitHits };
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

// Strongly connected components (iterative Tarjan): node id → component id,
// and component sizes. A cycle lives entirely inside one component, so the
// bounded path search below never leaves it — and never starts at all in an
// acyclic graph, where it would otherwise walk every path up to maxLen.
function stronglyConnected(adj) {
	const index = new Map(), low = new Map(), comp = new Map(), size = [];
	const onStack = new Set(), stack = [];
	let counter = 0;
	const visit = (root) => {
		const work = [[root, 0]];
		index.set(root, counter); low.set(root, counter); counter++;
		stack.push(root); onStack.add(root);
		while (work.length) {
			const frame = work[work.length - 1];
			const [v] = frame;
			const nbrs = adj.get(v) || [];
			if (frame[1] < nbrs.length) {
				const w = nbrs[frame[1]++];
				if (!index.has(w)) {
					index.set(w, counter); low.set(w, counter); counter++;
					stack.push(w); onStack.add(w);
					work.push([w, 0]);
				} else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
				continue;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1][0];
				low.set(parent, Math.min(low.get(parent), low.get(v)));
			}
			if (low.get(v) === index.get(v)) {
				const id = size.length;
				let n = 0, w;
				do { w = stack.pop(); onStack.delete(w); comp.set(w, id); n++; } while (w !== v);
				size.push(n);
			}
		}
	};
	for (const v of adj.keys()) if (!index.has(v)) visit(v);
	return { comp, size };
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
	const { comp, size } = stronglyConnected(adj);
	const cycles = [];
	const seen = new Set();
	const nodes = [...adj.keys()].sort();
	for (const start of nodes) {
		const home = comp.get(start);
		if (size[home] < 2) continue;
		const stack = [[start, [start]]];
		while (stack.length && cycles.length < 20) {
			const [cur, pathArr] = stack.pop();
			for (const nb of (adj.get(cur) || [])) {
				if (comp.get(nb) !== home) continue;
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
	if (prev !== next) writeFileAtomic(jsonPath, next);
	return jsonPath;
}

function loadGraph(root) {
	const jsonPath = path.join(outDir(root), GRAPH_BASENAME);
	let raw;
	try { raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")); } catch { return null; }
	const edges = raw.edges || raw.links || [];
	const nodes = raw.nodes || [];
	// writeGraph strips each community's `members` from graph.json (they are
	// derivable); rebuild them from node.community so `kg report` and
	// `kg export wiki` work from a loaded graph. Nodes are sorted by id in
	// the file, so the rebuilt lists are deterministic.
	const communities = (raw.graph && raw.graph.communities) || [];
	const byIdx = new Map(communities.map((c) => [c.id, c]));
	for (const c of communities) if (!Array.isArray(c.members)) c.members = [];
	for (const n of nodes) {
		const c = byIdx.get(n.community);
		if (c) c.members.push(n.id);
	}
	return { nodes, edges, communities, path: jsonPath };
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
	// EDGE lines always print the STORED direction (source -> target), never
	// the traversal direction: a search for a callee must not render
	// `callee --calls--> caller`.
	const printed = new Set();
	const pushEdge = (e) => {
		if (!e || !e.relation) return;
		const k = e.source + " " + e.target + " " + e.relation;
		if (printed.has(k)) return;
		printed.add(k);
		const ctx = e.context ? ` context=${e.context}` : "";
		lines.push(`EDGE ${(byId.get(e.source) || {}).label || e.source} --${e.relation} [${e.confidence || ""}${ctx}]--> ${(byId.get(e.target) || {}).label || e.target}`);
	};
	// Edges between seeds first: both endpoints are pre-visited, so the
	// traversal itself never records them — yet the link between the queried
	// symbols is usually the answer.
	if (seedSet.size > 1) {
		for (const e of edges) {
			if (e.source !== e.target && seedSet.has(e.source) && seedSet.has(e.target)) pushEdge(e);
		}
	}
	for (const [u, v] of edgesSeen) {
		if (!visited.has(u) || !visited.has(v)) continue;
		pushEdge(eIdx.get(u + " " + v));
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

// ---------------------------------------------------------------------------
// File-first ranking for `kg query`
// ---------------------------------------------------------------------------

// Words of an identifier or a sentence: camelCase, PascalCase, ACRONYMWord,
// snake_case and punctuation all split; lowercased.
function wordsOf(text) {
	const out = [];
	for (const m of String(text).matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g)) out.push(m[0].toLowerCase());
	return out;
}

const KEYWORDS_PER_FILE = 100;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// Signal weights: file text (BM25 over the stored keywords), the best symbol
// label, the path. A label that IS the query outranks everything else.
const RANK_LABEL_WEIGHT = 4;
const RANK_PATH_WEIGHT = 2;
const RANK_SUBSTRING = 0.35;
const RANK_DEMOTE = 0.3;
const RANK_FILES = 10;
const DEMOTED_PATH_RE = /(\.test\.|\.spec\.|\.e2e\.|(^|\/)tests?\/|__tests__|(^|\/)testdata\/|(^|\/)fixtures?\/|(^|\/)examples?\/|(^|\/)benches\/|(^|\/)benchmarks?\/|_test\.go$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|(^|\/)vendor\/|\.min\.[cm]?js$|(^|\/)docs?\/|\.d\.[cm]?ts$)/;
const DEMOTE_EXEMPT_WORDS = new Set(["test", "tests", "testing", "spec", "fixture", "fixtures", "example", "examples", "benchmark", "benchmarks", "vendor", "docs"]);

// The keywords `kg build` stores on a file node: its most distinctive words
// (term frequency × rarity across the repo), as "word:count" pairs.
function fileKeywords(tf, idfOf) {
	return [...tf]
		.map(([t, c]) => [t, c, c * idfOf(t)])
		.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.slice(0, KEYWORDS_PER_FILE)
		.map(([t, c]) => t + ":" + c)
		.join(" ");
}

// Files ranked for a question, best first: [{ rel, score, nodes }], where
// `nodes` are the file's symbols that match (best first) or its file node.
// Three signals per file — its text, its best-matching symbol label, its path
// — and one override: a symbol whose name is the whole query. Tests, docs,
// vendored and generated code rank below source unless the question names
// them.
function rankFiles(graph, question) {
	const allWords = wordsOf(question);
	const terms = [...new Set(allWords.filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t)))];
	const qs = terms.length ? terms : [...new Set(allWords)];
	if (!qs.length) return [];
	const joined = allWords.join("");
	const rawQuery = /^\S+$/.test(question.trim()) ? question.trim().replace(/\(\)$/, "") : null;
	const keepDemoted = qs.some((q) => DEMOTE_EXEMPT_WORDS.has(q));

	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const files = new Map(); // rel -> { node, labels, pathWords, tf, len }
	const fileOf = (rel) => {
		let f = files.get(rel);
		if (!f) files.set(rel, f = { node: null, labels: [], pathWords: new Set(wordsOf(rel)), tf: null, len: 0 });
		return f;
	};
	const topLevel = new Set();
	for (const e of graph.edges) {
		if (e.relation !== "contains" && e.relation !== "defines") continue;
		const a = byId.get(e.source);
		if (a && a.source_file && a.source_location === "L1" && a.label === path.posix.basename(a.source_file)) topLevel.add(e.target);
	}
	for (const n of graph.nodes) {
		if (!n.source_file) continue;
		const f = fileOf(n.source_file);
		if (n.source_location === "L1" && n.label === path.posix.basename(n.source_file) && !f.node) {
			f.node = n;
			if (typeof n.terms === "string" && n.terms) {
				f.tf = new Map();
				for (const pair of n.terms.split(" ")) {
					const at = pair.lastIndexOf(":");
					if (at > 0) f.tf.set(pair.slice(0, at), +pair.slice(at + 1) || 1);
				}
				f.len = +n.tokens || 0;
			}
			continue;
		}
		const raw = String(n.label || "").replace(/\(\)$/, "").replace(/^\./, "");
		const w = wordsOf(raw);
		if (w.length) f.labels.push({ id: n.id, w: new Set(w), joined: w.join(""), n: w.length, raw, top: topLevel.has(n.id) && n.type !== "impl" });
	}
	// rarity of a word: over the stored keywords, else over labels and paths
	const df = new Map();
	let withText = 0, totalLen = 0;
	for (const f of files.values()) {
		const seen = new Set(f.pathWords);
		if (f.tf) { withText++; totalLen += f.len; for (const t of f.tf.keys()) seen.add(t); }
		for (const L of f.labels) for (const t of L.w) seen.add(t);
		for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
	}
	const N = files.size || 1;
	const avgLen = withText ? totalLen / withText : 1;
	const idf = (t) => { const d = df.get(t) || 0; return Math.log(1 + (N - d + 0.5) / (d + 0.5)); };

	const ranked = [];
	for (const [rel, f] of files) {
		let lex = 0;
		if (f.tf) {
			for (const q of qs) {
				const tf = f.tf.get(q);
				if (tf) lex += idf(q) * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (f.len || avgLen) / avgLen));
			}
		}
		let best = 0, exact = 0;
		const hits = [];
		for (const L of f.labels) {
			let matched = 0, weight = 0;
			for (const q of qs) {
				if (L.w.has(q)) { matched++; weight += idf(q); }
				else if (q.length >= 4 && L.joined.includes(q)) { matched += RANK_SUBSTRING; weight += RANK_SUBSTRING * idf(q); }
			}
			const isExact = L.joined === joined;
			if (!matched && !isExact) continue;
			const coverage = matched / qs.length;
			const value = weight * coverage * (0.5 + 0.5 * (matched / Math.max(L.n, matched)));
			let ex = 0;
			if (isExact) ex = (L.top ? 1 : 0.5) + (rawQuery && L.raw === rawQuery ? 0.5 : 0);
			if (value > best) best = value;
			if (ex > exact) exact = ex;
			hits.push([ex, value, L.id]);
		}
		let pathScore = 0;
		for (const q of qs) if (f.pathWords.has(q)) pathScore += idf(q);
		const base = lex + RANK_LABEL_WEIGHT * best + RANK_PATH_WEIGHT * pathScore;
		let score = exact ? 1000 * exact - rel.length * 0.01 + base * 0.001 : base;
		if (score <= 0) continue;
		if (!keepDemoted && DEMOTED_PATH_RE.test(rel)) score *= RANK_DEMOTE;
		hits.sort((a, b) => b[0] - a[0] || b[1] - a[1] || (a[2] < b[2] ? -1 : 1));
		const nodes = hits.slice(0, 2).map((h) => h[2]);
		if (!nodes.length && f.node) nodes.push(f.node.id);
		if (nodes.length) ranked.push({ rel, score, nodes });
	}
	ranked.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1));
	return ranked;
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

// A bad command line: reported with the usage text and a non-zero exit.
class KgUsageError extends Error {}

// A value flag must be followed by its value (never by another flag); a
// missing one used to leave `true` behind for the command to choke on.
function parseFlags(args, valueFlags = []) {
	const flags = {}, positional = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const name = a.slice(2);
			if (valueFlags.includes(name)) {
				if (i + 1 >= args.length || args[i + 1].startsWith("--")) throw new KgUsageError(`--${name} requires a value`);
				flags[name] = flags[name] ? [].concat(flags[name], args[++i]) : args[++i];
			} else flags[name] = true;
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
		if (graph.idCollisions && graph.idCollisions.length) {
			console.log(`warning: ${graph.idCollisions.length} id collision(s) — graphify ids.py canonicalization merges these (first wins):`);
			for (const c of graph.idCollisions.slice(0, 5)) console.log(`  ${c.id}: kept ${c.kept}, merged ${c.dropped}`);
			if (graph.idCollisions.length > 5) console.log(`  … and ${graph.idCollisions.length - 5} more`);
		}
		if (graph.methodLimitHits && graph.methodLimitHits.length) {
			console.log(`warning: ${graph.methodLimitHits.length} class(es) declare more than ${MAX_METHODS_PER_CLASS} methods — the rest are not indexed:`);
			for (const c of graph.methodLimitHits.slice(0, 5)) console.log(`  ${c.file}: ${c.name} (${c.declared} methods)`);
			if (graph.methodLimitHits.length > 5) console.log(`  … and ${graph.methodLimitHits.length - 5} more`);
		}
		console.log(`→ ${jsonPath}\n→ ${reportPath}`);
	}
};

kgCommands.query = function (root, args) {
	const { flags, positional } = parseFlags(args, ["depth", "budget", "context"]);
	const question = positional.join(" ");
	if (!question) { console.log('usage: kg query "<question>" [--dfs] [--depth N] [--budget N] [--context C]'); return; }
	const graph = requireGraph(root);
	if (!graph) return;
	// The files that answer the question lead the output, best first, each
	// through its matching symbols; the traversal then starts from the best
	// three and adds what they connect to.
	const ranked = rankFiles(graph, question).slice(0, RANK_FILES);
	const seeds = [];
	for (const f of ranked) for (const nid of f.nodes) if (!seeds.includes(nid)) seeds.push(nid);
	if (!seeds.length) { console.log("No matching nodes found."); return; }
	const startNodes = [];
	for (const f of ranked.slice(0, 3)) for (const nid of f.nodes) if (!startNodes.includes(nid)) startNodes.push(nid);
	const mode = flags.dfs ? "dfs" : "bfs";
	const depth = Math.min(6, parseInt(flags.depth, 10) || 2);
	const budget = parseInt(flags.budget, 10) || 2000;
	const contextFilter = flags.context ? [].concat(flags.context) : null;
	const t = traverse(graph, startNodes, depth, mode, contextFilter);
	for (const nid of seeds) t.visited.add(nid);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const headerParts = [`Traversal: ${mode.toUpperCase()} depth=${depth}`, `Start: [${startNodes.map((s) => (byId.get(s) || {}).label || s).join(", ")}]`];
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
	if (prev !== next) writeFileAtomic(p, next);
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
	// A repeated `--output` keeps the last one.
	const output = Array.isArray(flags.output) ? flags.output[flags.output.length - 1] : flags.output;
	if (format === "tree") console.log("→ " + exportTree(root, graph, output));
	else if (format === "wiki") console.log("→ " + exportWiki(root, graph));
	else if (format === "graphml") console.log("→ " + exportGraphml(root, graph, output));
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
	writeFileAtomic(p, html);
	return p;
}

// Wiki page file for a node, from its unique id: labels repeat (two `save()`
// methods would write, and link to, the same page). The `node-` prefix keeps
// pages clear of index.md and community-N.md; very long ids keep a readable
// prefix plus a hash.
function wikiPageName(id) {
	const slug = String(id).replace(/_/g, "-");
	if (slug.length <= 120) return `node-${slug}.md`;
	return `node-${slug.slice(0, 100)}-${crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 10)}.md`;
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
	for (const g of gods) idx.push(`- [${g.label}](${wikiPageName(g.id)}) — degree ${g.degree}`);
	writeFileAtomic(path.join(dir, "index.md"), idx.join("\n") + "\n");

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
		writeFileAtomic(path.join(dir, `community-${c.id}.md`), L.join("\n") + "\n");
	}
	for (const g of gods) {
		const L = [`# ${g.label}`, "", `Degree ${g.degree} · ${g.source_file || ""}`, "", "## Relationships", ""];
		const conns = (adj.out.get(g.id) || []).map((e) => ["→", e.target, e]).concat((adj.inn.get(g.id) || []).map((e) => ["←", e.source, e]));
		conns.sort((a, b) => (adj.deg.get(b[1]) || 0) - (adj.deg.get(a[1]) || 0));
		for (const [arrow, nb, e] of conns.slice(0, 30)) L.push(`- ${arrow} \`${(byId.get(nb) || {}).label || nb}\` [${e.relation}] [${e.confidence}]`);
		L.push("", "## Audit Trail", "", `Extraction: deterministic (draht-tools kg). Source: ${g.source_file || "-"}.`);
		writeFileAtomic(path.join(dir, wikiPageName(g.id)), L.join("\n") + "\n");
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
	writeFileAtomic(p, L.join("\n"));
	return p;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KG_HELP = `draht-kg — graphify-parity symbol-level knowledge graph (deterministic, no LLM)

Usage: draht-tools kg <command> [args]

  build [--quiet]                 Index the repo → .planning/codebase/graph.json + KG_REPORT.md
  query "<question>" [--dfs] [--depth N] [--budget N] [--context C]
                                  Best files for the question first, then a BFS/DFS subgraph from them (NODE/EDGE output)
  explain "<node>"                Node dump: id, source, community, degree, connections
  path "<a>" "<b>"                Shortest path with directed arrows and confidence
  affected "<node>" [--depth N] [--relation R]
                                  Reverse blast-radius over calls/imports/inherits/…
  stats                           Node/edge/relation/confidence counts
  report                          Regenerate KG_REPORT.md
  export tree|wiki|graphml        GRAPH_TREE.html / kg-wiki/ / graph.graphml

Languages: TypeScript, JavaScript, Python, Go, Rust. Nodes are symbols (files,
classes, functions(), methods(), types, constants); edges carry graphify's
relation set with EXTRACTED/INFERRED/AMBIGUOUS confidence. graph.json is
node-link format, directed — loadable by graphify's own tooling.`;

function kgMain(argv) {
	const [cmd, ...args] = argv;
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(KG_HELP); return 0; }
	if (!kgCommands[cmd]) { console.error(`unknown kg command: ${cmd}\n`); console.log(KG_HELP); return 1; }
	const root = findRepoRoot(process.cwd());
	try {
		kgCommands[cmd](root, args);
	} catch (err) {
		if (!(err instanceof KgUsageError)) throw err;
		console.error(`kg ${cmd}: ${err.message}\n`);
		console.log(KG_HELP);
		return 1;
	}
	return 0;
}

module.exports = { kgMain, buildGraph, writeGraph, loadGraph, queryTerms, scoreNodes, rankFiles, wordsOf, normalizeId, makeId, parseDecls, maskSource, sortByPosixPath, importCycles, KG_HELP };

if (require.main === module) {
	process.exit(kgMain(process.argv.slice(2)));
}
