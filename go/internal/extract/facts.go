package extract

import (
	"bytes"
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/parse"
)

// FactsSchema is bumped whenever the on-disk shape of Facts changes.
const FactsSchema = 1

// Version identifies the regex extractors (exports/symbols/sinks/routes).
// Bump on ANY behaviour change. Feeds cache.ComposeVersion.
const Version = "x1"

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
	Degraded  bool           `json:"deg,omitempty"`
}

// Export is one exported declaration. Doc is "" when the CJS emits JSON
// null (no leading doc comment found).
type Export struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Line int    `json:"line"`
	Doc  string `json:"doc"`
}

// Symbol is one symbol-level node (exported or not).
type Symbol struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
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
