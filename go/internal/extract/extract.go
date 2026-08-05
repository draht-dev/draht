package extract

import (
	"bytes"
	"context"
	"fmt"

	"github.com/draht-dev/draht/go/internal/parse"
)

// File computes all Facts for one file. content is the raw bytes exactly as
// read (no BOM stripping, no newline normalization). p may be nil (=> no
// imports). Pure: no filesystem access, no globals.
//
// NOTE (design §R10): sinks/routes read STRIPPED content while
// sinkSites/exports read RAW content (draht-tools.cjs:2145-2152) — this
// asymmetry is intentional, do not "fix" it. content is always passed to p
// RAW: the regex Parser implementation strips internally (matching
// visParseImports' own stripped-content contract), while the tree-sitter
// implementation parses raw source directly (an AST does not need
// stripping) — see parse.Parser's implementations for the split.
//
// A parser error degrades Facts.Imports to empty (never fatal to the
// non-import facts: exports/symbols/sinks/routes are still valid and are
// returned regardless), but File now RETURNS that error alongside the
// degraded Facts, rather than swallowing it. This matters for two reasons a
// prior version got wrong: (1) the caller (graph/pipeline.go's extractOne)
// must be able to surface a --verbose warning — with the error silently
// discarded, that warning branch was dead code; (2) the caller must be able
// to skip snap.Put on error, so a transient parser failure (a recovered
// panic, a nil tree) is never cached as "this file permanently has zero
// imports" under a content hash that hasn't actually changed.
func File(ctx context.Context, p parse.Parser, lang parse.Lang, rel string, content []byte, symbolSignatures ...bool) (*Facts, error) {
	facts := &Facts{
		Loc: len(bytes.Split(content, []byte("\n"))),
	}

	langStr := string(lang)
	stripped := parse.StripComments(content, lang)

	facts.Exports = extractExports(langStr, content)
	withSignatures := len(symbolSignatures) > 0 && symbolSignatures[0]
	facts.Symbols = buildSymbols(langStr, content, facts.Exports, withSignatures)
	facts.Sinks = DetectSinks(stripped)
	facts.SinkSites = FindSinkSites(content)
	facts.Routes = DetectRoutes(stripped)

	if p != nil && p.Supports(lang) {
		res, err := p.Extract(ctx, lang, rel, content)
		if err != nil {
			return facts, fmt.Errorf("extract: parse imports: %w", err)
		}
		facts.Imports = res.Imports
		facts.Degraded = res.Degraded
	}

	// callEdges are TS/JS-only (draht-tools.cjs:2288 `m.language ===
	// "typescript" || "javascript"`). Scanning RAW content, exactly as
	// cjs:2311 reads `file.content` — do not strip first (design §R10).
	if (langStr == "typescript" || langStr == "javascript") && len(facts.Imports) > 0 {
		locals := CallLocals(facts.Imports)
		if len(locals) > 0 {
			facts.CallSites = ScanCallSites(content, locals)
		}
	}

	return facts, nil
}
