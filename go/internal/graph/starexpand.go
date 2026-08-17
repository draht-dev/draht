package graph

import (
	"path"
	"sort"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// StarReExport is one resolved bare `export * from "./x"` occurrence in a
// barrel, in parsedImports order (the CJS engine's starReExports map values).
type StarReExport struct {
	Target string // resolved module id the barrel star-re-exports
	Line   int    // 1-based line of the `export * from` statement
}

// StarReExports collects, per barrel module id, its resolved bare star
// re-exports (Namespace "*"; `export * as NS` records Namespace NS and is
// handled by extractExports instead). Ports the starReExports recording in
// the CJS edges loop: only RESOLVED targets are recorded, in import order.
func StarReExports(mi []ModuleImports, resolver *Resolver) map[string][]StarReExport {
	out := make(map[string][]StarReExport)
	for _, m := range mi {
		fromDir := path.Dir(m.Path)
		for _, ri := range ResolveImports(m.Imports, fromDir, resolver) {
			if !ri.Resolved || ri.Import.Kind != parse.KindReExport || ri.Import.Namespace != "*" {
				continue
			}
			line := ri.Import.Line
			if line == 0 {
				line = 1
			}
			out[m.Path] = append(out[m.Path], StarReExport{Target: ri.Target, Line: line})
		}
	}
	return out
}

// ExpandStarReExports ports the CJS star re-export expansion pass
// (draht-tools.cjs, after the edges loop): `export * from './x'` declares no
// names, so without this a star barrel's public API is invisible to
// graph-context/graph-query/MAP.html search. Copy the resolved target's
// exported names in as kind "re-export" (with Via = the real defining
// module). Fixpoint over sorted barrel ids (≤5 passes) settles
// barrel→barrel chains deterministically; the 60-per-module cap bounds
// MAP.json growth. Expanded names are then mirrored into symbols.
//
// MUST run after edges are built (targets need resolution) and before
// Assemble (symbolIndex and every other consumer reads modules' exports/
// symbols). Mutates modules in place.
func ExpandStarReExports(modules []model.Module, stars map[string][]StarReExport) {
	if len(stars) == 0 {
		return
	}
	byID := make(map[string]*model.Module, len(modules))
	for i := range modules {
		byID[modules[i].ID] = &modules[i]
	}
	barrels := make([]string, 0, len(stars))
	for id := range stars {
		barrels = append(barrels, id)
	}
	sort.Strings(barrels)

	const expansionCap = 60
	for pass := 0; pass < 5; pass++ {
		changed := false
		for _, bid := range barrels {
			b := byID[bid]
			if b == nil {
				continue
			}
			have := make(map[string]bool, len(b.Exports))
			for _, e := range b.Exports {
				have[e.Name] = true
			}
			for _, st := range stars[bid] {
				t := byID[st.Target]
				if t == nil {
					continue
				}
				for _, e := range t.Exports {
					if len(b.Exports) >= expansionCap {
						break
					}
					if have[e.Name] {
						continue
					}
					have[e.Name] = true
					via := e.Via
					if via == "" {
						via = t.ID
					}
					b.Exports = append(b.Exports, model.Export{Name: e.Name, Kind: "re-export", Line: st.Line, Doc: e.Doc, Via: via})
					changed = true
				}
			}
		}
		if !changed {
			break
		}
	}
	for _, bid := range barrels {
		b := byID[bid]
		if b == nil {
			continue
		}
		seen := make(map[string]bool, len(b.Symbols))
		for _, s := range b.Symbols {
			seen[s.Name] = true
		}
		for _, e := range b.Exports {
			if len(b.Symbols) >= expansionCap {
				break
			}
			if seen[e.Name] {
				continue
			}
			seen[e.Name] = true
			b.Symbols = append(b.Symbols, model.Symbol{Name: e.Name, Kind: "re-export", Line: e.Line, Exported: true})
		}
	}
}
