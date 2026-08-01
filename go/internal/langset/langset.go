// Package langset is the single source of truth for which languages the
// shipped draht-graph binary parses, and for the grammar_subset build tags
// that compile exactly those grammars in.
//
// COUPLING HAZARD, read before editing CLILanguages: gotreesitter registers
// grammars from files gated on `//go:build grammar_subset && grammar_subset_<name>`.
// If a language is listed here but its tag is not in the build,
// grammars.DetectLanguageByName returns nil and parse.NewTreeSitter SKIPS it
// with `continue` — the binary still builds, still runs, and silently stops
// seeing that language's imports. Never hand-write a tag list anywhere:
// the Makefile, scripts/build-graph-binaries.sh and CI all take it from
// `go run ./cmd/grammar-tags`, which is BuildTags() below.
//
// This package deliberately imports nothing but the stdlib (no gotreesitter)
// so `go run ./cmd/grammar-tags` compiles in well under a second instead of
// compiling all 206 bundled grammars.
package langset

import "sort"

// CLILanguages is what cmd/draht-tools' buildParser enables (design D2).
var CLILanguages = []string{"typescript", "javascript", "python", "go", "rust", "java", "ruby", "shell"}

// GrammarFor maps a draht language id to a gotreesitter grammar name (i.e. a
// name accepted by grammars.DetectLanguageByName). This does NOT resolve the
// typescript/tsx split — that is a per-file, path-suffix decision that lives
// in parse.grammarFor, which delegates the language-only mapping here.
//
// Returns "" for languages this package does not know how to map to a
// grammar name; callers treat that as "unsupported".
func GrammarFor(lang string) string {
	switch lang {
	case "typescript":
		return "typescript"
	case "javascript":
		return "javascript"
	case "python":
		return "python"
	case "go":
		return "go"
	case "rust":
		return "rust"
	case "java":
		return "java"
	case "kotlin":
		return "kotlin"
	case "swift":
		return "swift"
	case "ruby":
		return "ruby"
	case "php":
		return "php"
	case "csharp":
		return "c_sharp"
	case "c":
		return "c"
	case "cpp":
		return "cpp"
	case "shell":
		return "bash"
	default:
		return ""
	}
}

// GrammarNamesFor returns the sorted, deduped gotreesitter grammar names
// needed for langs. The typescript->tsx expansion lives HERE ONLY; both
// parse.NewTreeSitter and BuildTags call this, so they cannot disagree
// about which grammars a given language list actually requires.
func GrammarNamesFor(langs []string) []string {
	set := make(map[string]struct{}, len(langs)+1)
	for _, l := range langs {
		if g := GrammarFor(l); g != "" {
			set[g] = struct{}{}
		}
		if l == "typescript" {
			set["tsx"] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for g := range set {
		out = append(out, g)
	}
	sort.Strings(out)
	return out
}

// BuildTags returns the sorted grammar_subset build tags for langs: the
// literal "grammar_subset" master switch, followed by one
// "grammar_subset_<grammar>" tag per name from GrammarNamesFor. Already
// sorted as returned: "grammar_subset" sorts before every
// "grammar_subset_*" tag, and GrammarNamesFor's output is itself sorted.
func BuildTags(langs []string) []string {
	names := GrammarNamesFor(langs)
	out := make([]string, 0, len(names)+1)
	out = append(out, "grammar_subset")
	for _, g := range names {
		out = append(out, "grammar_subset_"+g)
	}
	return out
}
