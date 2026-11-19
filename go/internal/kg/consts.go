// Package kg is the symbol-level knowledge graph (`kg` commands): a port of
// packages/draht-tools/bin/draht-kg.cjs that produces the same graph.json and
// the same command output. Nodes are symbols (files, classes, functions,
// methods, types); edges carry graphify's relation set with the EXTRACTED /
// INFERRED / AMBIGUOUS confidence rubric. Everything is deterministic: no
// LLM, no network, no timestamps in output.
//
// The port keeps the original's structure and names so the two engines can
// be read side by side; `make kg-parity` compares their output.
package kg

import "path/filepath"

var outDirname = filepath.Join(".planning", "codebase")

const graphBasename = "graph.json"

var kgIgnores = strSet(
	"node_modules", ".git", "dist", "build", "out", "target", ".next",
	".turbo", ".cache", "coverage", ".nyc_output", ".planning",
	".venv", "venv", "__pycache__", ".pytest_cache", ".idea", ".vscode",
	".DS_Store", ".sst", ".astro", ".svelte-kit", "vendor", "tmp", ".tmp",
)

var kgLangByExt = map[string]string{
	".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".go": "go", ".rs": "rust",
}

func tsLike(lang string) bool { return lang == "typescript" || lang == "javascript" }

var langFamily = map[string]string{"typescript": "js", "javascript": "js", "python": "py", "go": "go", "rust": "rs"}

// graphify export.py:159 — filled when an edge carries no explicit score.
var confidenceScoreDefaults = map[string]float64{"EXTRACTED": 1.0, "INFERRED": 0.5, "AMBIGUOUS": 0.2}

// graphify extract.py — inferred cross-file call binding carries an explicit 0.8.
const inferredCallScore = 0.8

// graphify affected.py DEFAULT_AFFECTED_RELATIONS
var defaultAffectedRelations = []string{
	"calls", "indirect_call", "references", "imports", "imports_from", "re_exports",
	"inherits", "extends", "implements", "uses", "mixes_in", "embeds",
}

// graphify serve.py _QUERY_STOPWORDS (verbatim)
var queryStopwords = strSet(
	"how", "what", "why", "when", "where", "which", "who", "whom", "whose",
	"does", "did", "is", "are", "was", "were", "be", "been", "being",
	"can", "could", "should", "would", "will", "shall", "may", "might", "must",
	"has", "have", "had", "the", "and", "but", "not", "for", "from", "with",
	"without", "into", "onto", "off", "that", "this", "these", "those", "there",
	"here", "its", "their", "them", "they", "about", "any", "all", "some",
	"work", "works", "working",
)

const (
	exactMatchBonus     = 1000.0
	prefixMatchBonus    = 100.0
	substringMatchBonus = 1.0
	sourceMatchBonus    = 0.5
)

// Methods the languages' own objects have (arrays, strings, maps, promises,
// streams, emitters, dicts, files): a call to one of these on a receiver of
// unknown type says nothing about a repo class that happens to declare the
// same name.
var commonMethodNames = strSet(
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
)

// Control-flow keywords that look like calls in `name(` scans.
var callKeywords = strSet(
	"if", "else", "for", "while", "switch", "catch", "try", "do", "return", "throw",
	"new", "await", "async", "typeof", "instanceof", "void", "delete", "yield", "case",
	"function", "class", "const", "let", "var", "constructor", "super", "this", "self",
	"def", "elif", "except", "with", "assert", "lambda", "raise", "match", "loop", "fn",
	"impl", "pub", "use", "mod", "func", "go", "defer", "select", "chan", "interface",
	"struct", "enum", "trait", "type", "in", "of", "as", "satisfies", "declare", "export",
)

// graphify analyze.py noise labels for god-node filtering (subset).
var builtinNoiseLabels = strSet(
	"str", "int", "float", "bool", "list", "dict", "set", "tuple", "Path", "Mock",
	"string", "number", "boolean", "object", "any", "unknown", "void", "null", "undefined",
	"Error", "Option", "Result", "Vec", "String", "error",
)

const maxSymbolsPerFile = 5000

// Methods one class keeps. A class that declares more is named in the
// `kg build` output instead of losing the rest silently.
const maxMethodsPerClass = 1000

// addMethod adds a method to its class; false (and counted) past the limit.
func addMethod(cls *Class, meth *Func) bool {
	if len(cls.Methods) >= maxMethodsPerClass {
		cls.MethodsOverLimit++
		return false
	}
	cls.Methods = append(cls.Methods, meth)
	return true
}

var (
	reGenericArgs = mustRE(`<[^<>]*>`, "")
	reLeadIdent   = mustRE(`^[A-Za-z_$][\w$]*`, "")
)

// implementsList: `implements A, B<T>, ns.C` (text up to the body brace) →
// ["A", "B", "ns"]: generic arguments removed, then each item's leading
// identifier.
func implementsList(text string) []string {
	s := text
	for reGenericArgs.TestS(s) {
		s = reGenericArgs.ReplaceLit(s, "")
	}
	var out []string
	for _, x := range splitStr(s, ",") {
		if m := reLeadIdent.FindS(jsTrim(x)); m != nil && m.S(0) != "" {
			out = append(out, m.S(0))
		}
	}
	return out
}
