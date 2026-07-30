// Package symindex builds the two repo-wide indices that fall out of a
// completed module/edge graph but feed straight into MAP.json's top level:
//
//   - symbolIndex: every exported symbol across the repo, ranked so that
//     truncation (at SymbolIndexCap) keeps the most-depended-on modules'
//     symbols first (draht-tools.cjs:2884-2905).
//   - rationaleIndex: inline NOTE/WHY/HACK/TODO/... marker comments,
//     extracted per-file and rolled up with a global severity-first sort
//     (draht-tools.cjs:1758-1811, 2934-2936).
//
// Every exported function is pure: slices/maps in, records out. No file I/O,
// no globals, no goroutines. Callers own sourcing raw file content and
// wiring the per-module in-degree map (see BuildSymbolIndex and
// ExtractRationale docs for exactly what must be threaded in).
package symindex
