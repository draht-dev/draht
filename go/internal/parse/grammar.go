package parse

import (
	"strings"

	"github.com/draht-dev/draht/go/internal/langset"
)

// grammarFor maps a (Lang, path) pair to a gotreesitter grammar name (i.e. a
// name accepted by grammars.DetectLanguageByName). path is used only to
// disambiguate the one Lang that spans two grammars: "typescript" covers both
// the "typescript" and "tsx" grammars, split on the file extension. Every
// other Lang maps to a single grammar regardless of path, via
// langset.GrammarFor — the single source of truth for the language->grammar
// mapping, shared with the grammar_subset build-tag generator
// (cmd/grammar-tags) so this package and the tag list can never disagree
// about what a given language name means.
//
// Returns "" for languages parse does not (yet) know how to map to a grammar
// name; callers treat that as "unsupported".
func grammarFor(lang Lang, path string) string {
	if lang == "typescript" && strings.HasSuffix(strings.ToLower(path), ".tsx") {
		return "tsx"
	}
	return langset.GrammarFor(string(lang))
}
