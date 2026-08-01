package parse

import (
	"context"

	"github.com/draht-dev/draht/go/internal/langset"
)

// Lang is the draht language id emitted into MAP.json (scan.LangFor's output
// domain): typescript javascript python go rust java kotlin swift ruby php
// csharp c cpp shell. NOT a tree-sitter grammar name — the treesitter impl maps
// (Lang, path-extension) -> grammar internally (e.g. typescript+".tsx" -> "tsx",
// shell -> "bash", csharp -> "c_sharp").
type Lang string

// Name is one named import binding. Imported is the name in the source module,
// Local is the binding in the importing module. For `{ a as b }`: {Imported:"a", Local:"b"}.
type Name struct {
	Imported string `json:"i"`
	Local    string `json:"l,omitempty"` // omitted when == Imported
}

// Kind classifies the statement that produced this record.
type Kind string

const (
	KindImport   Kind = "import"    // import X from "m" / import "m" / use / from..import
	KindReExport Kind = "re-export" // export {…} from "m" / export * [as N] from "m"
	KindDynamic  Kind = "dynamic"   // import("m")
	KindRequire  Kind = "require"   // require("m")
)

// Import is one module-specifier occurrence. Exactly one specifier per record.
type Import struct {
	Kind      Kind   `json:"k"`
	Specifier string `json:"s"`           // raw, uninterpreted (may contain ${…})
	Default   string `json:"d,omitempty"` // default-import local name
	Namespace string `json:"n,omitempty"` // `* as X` local name; "*" for bare `export * from`
	Names     []Name `json:"m,omitempty"`
	Line      int    `json:"ln"` // 1-based, line of the anchoring statement
	Offset    int    `json:"o"`  // byte offset of the anchoring statement; ordering key
}

// Result is one file's import extraction.
type Result struct {
	// Imports is emission-ordered. Order is IMPLEMENTATION-DEFINED but must be
	// deterministic for identical input:
	//   - TreeSitter emits ascending Offset (source order).
	//   - Regex emits CJS 4-pass order (all `import…from`, then require/dynamic,
	//     then `export{…}from`, then `export * from`) — required for edges[] parity.
	// graph MUST NOT re-sort this slice.
	Imports []Import `json:"i,omitempty"`
	// Degraded is true when the tree contained ERROR/MISSING nodes or the query
	// match budget was exhausted. Non-fatal; Imports is still usable.
	Degraded bool `json:"deg,omitempty"`
}

// Parser extracts module specifiers from source bytes.
//
// CONTRACT (all implementations):
//   - Extract MUST be safe for concurrent use by multiple goroutines.
//   - Extract MUST NOT panic. Internal panics are recovered and returned as error.
//   - Extract MUST be deterministic: identical (lang, path, src) => identical Result.
//   - Extract MUST NOT touch the filesystem, the network, or any global mutable state.
//   - A non-nil error means "no data"; callers treat it as zero imports + a warning.
type Parser interface {
	// Supports reports whether Extract can produce imports for lang. When false,
	// callers skip the call entirely (and cache an empty Facts.Imports).
	Supports(lang Lang) bool

	// Extract parses src. path is repo-relative POSIX and is used ONLY for
	// grammar disambiguation (.tsx) and diagnostics.
	Extract(ctx context.Context, lang Lang, path string, src []byte) (Result, error)

	// Version identifies implementation + query revision for cache invalidation.
	// ANY change to extraction behaviour MUST change this string.
	// Format: "<impl>/<rev>[+<libver>]", e.g. "ts/3+gotreesitter@v0.47.1", "re/1".
	Version() string

	// Close releases grammar/pool resources. Safe to call once, after all
	// in-flight Extract calls have returned.
	Close() error
}

// CLILangs returns the languages the shipped CLI enables for AST extraction,
// converted from langset.CLILanguages — the single source of truth that also
// generates the binary's grammar_subset build tags (cmd/grammar-tags).
//
// Every caller that constructs a tree-sitter parser for the *product* (as
// opposed to a test fixture) must go through this, never a hand-written
// slice. Two reasons, both silent when violated: the enabled grammar set is
// part of the extraction cache key (see treeSitterParser.Version), so callers
// sharing a cache must agree on it; and a hand-written list silently omits any
// language later added to langset.
func CLILangs() []Lang {
	out := make([]Lang, len(langset.CLILanguages))
	for i, l := range langset.CLILanguages {
		out[i] = Lang(l)
	}
	return out
}
