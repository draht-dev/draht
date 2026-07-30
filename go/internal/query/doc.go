// Package query is the read-only MAP.json query engine behind the
// `graph-context`, `graph-impact`, `graph-callers`, `graph-callees`,
// `graph-path`, `graph-query`, `graph-hotspots` and `graph-clusters` CLI
// commands. It is a verbatim, push-for-push port of the corresponding
// `commands["graph-*"]` functions in draht-tools.cjs (lines 5306-5570).
//
// Every renderer in this package is a pure function: (*model.Map, argv
// []string, io.Writer) -> exit code. There is no filesystem access, no
// os.Exit, and no package-level mutable state, so every command can be
// golden-tested without a process boundary. LoadMap and FindRepoRoot are the
// only functions that touch disk, and they are kept separate from the
// renderers so the renderers stay trivially testable.
//
// Byte-exact stdout parity with the CJS engine is the acceptance bar for
// this package (see testdata/golden — captured from the live CJS engine
// against a frozen MAP.json snapshot). Ordering in every rendered list is
// insertion order (JS Map/Set/object semantics), never a Go-idiomatic sort:
// see adjacency.go and impact.go for the ordered structures that make this
// possible without relying on Go's randomized map iteration.
package query
