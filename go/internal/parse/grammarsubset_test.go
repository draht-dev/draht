package parse

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/langset"
)

// cliLangs mirrors cmd/draht-tools' buildParser (design D2), via the same
// langset.CLILanguages source of truth the build-tag generator uses.
func cliLangs() []Lang {
	out := make([]Lang, len(langset.CLILanguages))
	for i, l := range langset.CLILanguages {
		out[i] = Lang(l)
	}
	return out
}

// TestShippedGrammarSubsetSupportsEveryCLILanguage runs meaningfully in BOTH
// CI passes. In the untagged pass (all 206 grammars compiled) it proves
// every name langset asks for still EXISTS upstream — a gotreesitter rename
// would fail here. In the tagged pass (`go test -tags "$(go run
// ./cmd/grammar-tags)" ./...`) it proves the generated tags actually
// COMPILED those grammars in — an unknown/typo'd Go build tag is silently
// legal (gotreesitter's registry lookup just returns nil and
// parse.NewTreeSitter skips the grammar with `continue`), so this is the
// only thing that catches it.
func TestShippedGrammarSubsetSupportsEveryCLILanguage(t *testing.T) {
	langs := cliLangs()
	p, err := NewTreeSitter(langs)
	if err != nil {
		t.Fatalf("NewTreeSitter(%v): %v", langs, err)
	}
	defer func() { _ = p.Close() }()

	for _, l := range langs {
		if !p.Supports(l) {
			t.Errorf("grammar for %q is not compiled into this build — build tags are out of "+
				"sync with langset.CLILanguages; regenerate with `go run ./cmd/grammar-tags`", l)
		}
	}

	// Lang has no distinct "tsx" value (scan classifies both .ts and .tsx as
	// "typescript"; grammarFor picks the grammar by file extension at
	// Extract time) so Supports("typescript") alone doesn't prove the tsx
	// grammar specifically loaded. Reach into the concrete type to check it
	// directly, the same way TestTreeSitter_TypeScriptAndTSX's sibling tests
	// exercise .tsx extraction elsewhere in this package.
	tp, ok := p.(*treeSitterParser)
	if !ok {
		t.Fatalf("NewTreeSitter returned %T, want *treeSitterParser", p)
	}
	kit, ok := tp.kits["tsx"]
	if !ok || kit.Query == nil {
		t.Error("tsx grammar missing (grammar_subset_tsx) — TypeScript's .tsx files would silently stop parsing")
	}
}

// TestBuildTagsCoverEveryGrammarName proves langset.BuildTags never omits a
// grammar_subset_<name> tag for a grammar langset.GrammarNamesFor says the
// CLI language set actually needs. This is a pure function invariant (no
// gotreesitter involved) so it runs identically, and meaningfully, in every
// CI pass — unlike the tagged/untagged pair above.
func TestBuildTagsCoverEveryGrammarName(t *testing.T) {
	tags := make(map[string]bool)
	for _, tg := range langset.BuildTags(langset.CLILanguages) {
		tags[tg] = true
	}
	for _, g := range langset.GrammarNamesFor(langset.CLILanguages) {
		if !tags["grammar_subset_"+g] {
			t.Errorf("grammar %q has no build tag", g)
		}
	}
}
