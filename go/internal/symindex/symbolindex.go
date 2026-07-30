package symindex

import (
	"sort"

	"github.com/draht-dev/draht/go/internal/model"
)

// SymbolIndexCap is the hard cap on symbolIndex length
// (draht-tools.cjs:2891 — SYMBOL_INDEX_CAP is 5000, not the 1500 that older
// design notes reference).
const SymbolIndexCap = 5000

// BuildSymbolIndex is the verbatim port of the symbolIndex construction at
// draht-tools.cjs:2884-2905.
//
// Ranking is the truncation contract: modules that export at least one
// symbol are sorted by import in-degree DESCENDING (inDeg[m.ID], which MUST
// be the same in-degree map used for hotspots — test-originated edges are
// counted here, unlike the hotspot-only inDegNT variant), tie-broken by
// m.Path ASCENDING. Entries are then flattened module-by-module,
// export-by-export (m.Exports is already capped at 30/module upstream), and
// the cap is checked BEFORE every push — both before starting a module's
// exports and before each individual export — so symbolIndexTruncated is
// only set true when the cap is hit AND there was more work left to do.
//
// inDeg must be the modules-order import in-degree map (graph.Degrees.In in
// the WP-D spec, i.e. edges where kind=="import", test-sourced edges
// INCLUDED). A nil or partial map treats missing modules as in-degree 0,
// matching the CJS `inDeg.get(id) || 0` fallback.
func BuildSymbolIndex(modules []model.Module, inDeg map[string]int) ([]model.SymbolIndexEntry, bool) {
	ranked := make([]model.Module, 0, len(modules))
	for _, m := range modules {
		if len(m.Exports) > 0 {
			ranked = append(ranked, m)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		di, dj := inDeg[ranked[i].ID], inDeg[ranked[j].ID]
		if di != dj {
			return di > dj
		}
		return ranked[i].Path < ranked[j].Path
	})

	entries := make([]model.SymbolIndexEntry, 0)
	truncated := false

outer:
	for _, m := range ranked {
		if len(entries) >= SymbolIndexCap {
			truncated = true
			break
		}
		for _, e := range m.Exports {
			if len(entries) >= SymbolIndexCap {
				truncated = true
				break outer
			}
			entries = append(entries, model.SymbolIndexEntry{
				Name:     e.Name,
				Kind:     e.Kind,
				Line:     e.Line,
				File:     m.Path,
				Package:  m.Package,
				Exported: true,
			})
		}
	}
	return entries, truncated
}
