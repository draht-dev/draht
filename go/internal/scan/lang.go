package scan

import (
	"sort"
	"strings"
)

// Lang is a draht language identifier. It is the scan-package's own type
// (not shared with parse.Lang) to keep the dependency graph acyclic: scan
// imports nothing but stdlib, and parse imports nothing but gotreesitter.
type Lang string

// The 14 code languages plus "other" for everything else. This is the same
// value domain as parse.Lang; callers cast (scan.Lang -> parse.Lang) at the
// extract boundary.
const (
	LangTypeScript Lang = "typescript"
	LangJavaScript Lang = "javascript"
	LangPython     Lang = "python"
	LangGo         Lang = "go"
	LangRust       Lang = "rust"
	LangJava       Lang = "java"
	LangKotlin     Lang = "kotlin"
	LangSwift      Lang = "swift"
	LangRuby       Lang = "ruby"
	LangPHP        Lang = "php"
	LangCSharp     Lang = "csharp"
	LangC          Lang = "c"
	LangCPP        Lang = "cpp"
	LangShell      Lang = "shell"
	LangOther      Lang = "other"
)

// CodeLangs are the 14 languages that produce module-graph nodes (everything
// except LangOther).
var CodeLangs = []Lang{
	LangTypeScript, LangJavaScript, LangPython, LangGo, LangRust,
	LangJava, LangKotlin, LangSwift, LangRuby, LangPHP,
	LangCSharp, LangC, LangCPP, LangShell,
}

// LangByExt maps a lowercase file extension (as returned by JSExtname,
// including the leading dot) to a Lang. Verbatim port of VIS_LANG_BY_EXT
// (draht-tools.cjs:1245-1254): 39 entries. Non-code languages (markdown,
// json, yaml, toml, html, css, scss, sql) are included deliberately — they
// are counted in stats.languages / assets.byLanguage but never become
// modules (see IsCodeLang / the noise policy enforced by Result.CodeFiles).
var LangByExt = map[string]Lang{
	".ts": LangTypeScript, ".tsx": LangTypeScript, ".mts": LangTypeScript, ".cts": LangTypeScript,
	".js": LangJavaScript, ".jsx": LangJavaScript, ".mjs": LangJavaScript, ".cjs": LangJavaScript,
	".py": LangPython, ".go": LangGo, ".rs": LangRust, ".java": LangJava, ".kt": LangKotlin,
	".swift": LangSwift, ".rb": LangRuby, ".php": LangPHP, ".cs": LangCSharp,
	".c": LangC, ".h": LangC, ".cpp": LangCPP, ".hpp": LangCPP, ".cc": LangCPP,
	".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
	".toml": "toml", ".html": "html", ".css": "css", ".scss": "scss",
	".sh": LangShell, ".bash": LangShell, ".zsh": LangShell, ".sql": "sql",
}

// WatchManifests lists manifest basenames the pipeline treats as workspace
// package roots (VIS_WATCH_MANIFESTS, draht-tools.cjs:5159).
var WatchManifests = []string{
	"package.json", "pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json",
}

// JSExtname mimics Node's path.extname (NOT filepath.Ext): it returns "" when
// the file has no extension, or the only dot in the basename is its leading
// character (e.g. ".gitignore" -> ""). Ported verbatim from Node's
// lib/path.js posix extname algorithm so byte-for-byte edge cases (trailing
// dot, dotfiles, multi-dot extensions) match exactly.
func JSExtname(path string) string {
	startDot := -1
	startPart := 0
	end := -1
	matchedSlash := true
	preDotState := 0

	for i := len(path) - 1; i >= 0; i-- {
		c := path[i]
		if c == '/' {
			if !matchedSlash {
				startPart = i + 1
				break
			}
			continue
		}
		if end == -1 {
			matchedSlash = false
			end = i + 1
		}
		if c == '.' {
			if startDot == -1 {
				startDot = i
			} else if preDotState != 1 {
				preDotState = 1
			}
		} else if startDot != -1 {
			preDotState = -1
		}
	}

	if startDot == -1 || end == -1 || preDotState == 0 ||
		(preDotState == 1 && startDot == end-1 && startDot == startPart+1) {
		return ""
	}
	return path[startDot:end]
}

// LangFor classifies path by extension via LangByExt (case-insensitive,
// using JSExtname semantics), falling back to LangOther. Verbatim port of
// visLangFor (draht-tools.cjs:1256-1259).
func LangFor(path string) Lang {
	ext := strings.ToLower(JSExtname(path))
	if lang, ok := LangByExt[ext]; ok {
		return lang
	}
	return LangOther
}

// IsCodeLang reports whether l is one of CodeLangs.
func IsCodeLang(l Lang) bool {
	for _, c := range CodeLangs {
		if c == l {
			return true
		}
	}
	return false
}

// CodeExts returns every extension in LangByExt whose Lang IsCodeLang,
// sorted ascending for determinism (VIS_WATCH_EXTS, draht-tools.cjs:5155).
func CodeExts() []string {
	exts := make([]string, 0, len(LangByExt))
	for ext, lang := range LangByExt {
		if IsCodeLang(lang) {
			exts = append(exts, ext)
		}
	}
	sort.Strings(exts)
	return exts
}
