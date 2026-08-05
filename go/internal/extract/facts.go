package extract

import (
	"bytes"
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/parse"
)

// FactsSchema is bumped whenever the on-disk shape of Facts changes.
// Bumped 1 -> 2 for Phase 2's CallSites field (design's WP2 callEdges
// rewiring — invalidates every cached entry exactly once). Bumped 2 -> 3 for
// Symbol.Sig (the per-symbol declaration text), same one-time invalidation.
const FactsSchema = 3

// Version identifies the regex extractors (exports/symbols/sinks/routes).
// Bump on ANY behaviour change. Feeds cache.ComposeVersion. Bumped "x1" ->
// "x2" alongside FactsSchema for the same reason, "x2" -> "x3" for
// Symbol.Sig, and "x3" -> "x4" when signatures stopped retaining variable
// initializers and named exports began resolving local declarations.
const Version = "x4"

// Facts is everything derivable from ONE file in isolation. It is exactly
// what the cache stores. It deliberately contains NOTHING global: no
// package attribution, no layer, no entryPoint, no resolved edges — all of
// those depend on other files and MUST be recomputed every run.
type Facts struct {
	Loc       int            `json:"loc"`
	Imports   []parse.Import `json:"imp,omitempty"`
	Exports   []Export       `json:"exp,omitempty"` // UNTRUNCATED (cap 200 from CJS applies at extraction time)
	Symbols   []Symbol       `json:"sym,omitempty"` // capped at 60 by buildSymbols
	Sinks     []string       `json:"snk,omitempty"` // deduped, SinkPatterns order
	SinkSites []SinkSite     `json:"sst,omitempty"` // UNTRUNCATED (max 2 per kind from CJS)
	Routes    []Route        `json:"rt,omitempty"`  // UNTRUNCATED (cap 40 from CJS)
	// CallSites is the per-import-local call-site scan (TS/JS only — see
	// File), computed against RAW (unstripped) content for every distinct
	// local name introduced by a non-re-export import, regardless of
	// whether that import later turns out to resolve (design WP2: a
	// harmless superset, since assemble-time joins this against the
	// actually-resolved UsedLocal set by name).
	CallSites []CallSite `json:"cs,omitempty"`
	Degraded  bool       `json:"deg,omitempty"`
}

// Export is one exported declaration. Doc is "" when the CJS emits JSON
// null (no leading doc comment found).
type Export struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Line int    `json:"line"`
	Doc  string `json:"doc"`
}

// Symbol is one symbol-level node (exported or not). Sig is the declaration
// text as written (see signatureAt), capped at SignatureCap runes and "" when
// nothing could be rendered. It is extracted UNCONDITIONALLY so a cache entry
// is valid whether or not the run emitting it had --symbol-signatures on;
// gating happens at emit time in graph.convertSymbols, not here.
type Symbol struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
	Sig      string `json:"sig,omitempty"`
}

// SinkSite is one concrete call site for a detected sink kind.
type SinkSite struct {
	Kind       string `json:"kind"`
	Line       int    `json:"line"`
	Snippet    string `json:"snippet"`
	InFunction string `json:"inFunction"`
}

// Route is one detected HTTP route declaration.
type Route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// MarshalFacts / UnmarshalFacts are the cache codec. Deterministic:
// struct-based encoding/json, no maps, no HTML escaping (Encoder +
// SetEscapeHTML(false)), single line, no trailing newline.
func MarshalFacts(f *Facts) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(f); err != nil {
		return nil, err
	}
	// json.Encoder.Encode always appends a trailing "\n"; the codec
	// contract is "single line, no trailing newline" (the NDJSON store
	// supplies its own line separators).
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// UnmarshalFacts is the inverse of MarshalFacts.
func UnmarshalFacts(b []byte) (*Facts, error) {
	var f Facts
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return &f, nil
}
