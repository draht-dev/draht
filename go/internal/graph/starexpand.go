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

// exportOriginKey identifies the BINDING an export entry stands for: the
// defining module plus the original name there (ViaName when an aliased
// re-export renamed it). fallback is the entry's own module id, used when
// Via is unset (a locally defined export).
func exportOriginKey(e model.Export, fallback string) string {
	via := e.Via
	if via == "" {
		via = fallback
	}
	name := e.ViaName
	if name == "" {
		name = e.Name
	}
	return via + "\x00" + name
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

// NamedReExport is one resolved `export { Local } from "./x"` link: the
// target module and the name it is imported under there (`foo` for
// `export { foo as bar }`).
type NamedReExport struct {
	Target   string
	Imported string
}

// NamedReExports collects, per module id, its resolved named re-exports
// keyed by exported (local) name; the first occurrence wins. Ports the CJS
// namedReExports recording in the edges loop. Origin resolution follows
// these links to a name's defining module.
func NamedReExports(mi []ModuleImports, resolver *Resolver) map[string]map[string]NamedReExport {
	out := make(map[string]map[string]NamedReExport)
	for _, m := range mi {
		fromDir := path.Dir(m.Path)
		for _, ri := range ResolveImports(m.Imports, fromDir, resolver) {
			if !ri.Resolved || ri.Import.Kind != parse.KindReExport || ri.Import.Namespace != "" {
				continue
			}
			links := out[m.Path]
			if links == nil {
				links = make(map[string]NamedReExport)
				out[m.Path] = links
			}
			for _, n := range ri.Import.Names {
				local := n.Local
				if local == "" {
					local = n.Imported
				}
				if _, ok := links[local]; !ok {
					links[local] = NamedReExport{Target: ri.Target, Imported: n.Imported}
				}
			}
		}
	}
	return out
}

// reExportOrigins resolves the ORIGIN of a module's export: the module that
// ultimately DEFINES the binding plus the binding's name there. Without it,
// a barrel starring both the definer and a named re-exporter of the same
// binding would see two origins and wrongly drop the name as ambiguous —
// the ES spec treats same-binding routes as one export. Lockstep with the
// CJS reExportOrigin.
type reExportOrigins struct {
	byID  map[string]*model.Module
	named map[string]map[string]NamedReExport
}

// of returns the origin of m's export name. A local definition is its own
// origin (a local alias `export { a as b }` stands for the binding `a`); a
// star copy, or an entry resolved after expansion, carries Via/ViaName; a
// named re-export is followed to its target. ok=false = pending: the target
// does not export the name, perhaps not YET (its own star expansion may add
// it). Once settled, a target that never exports it (CommonJS: no extracted
// exports) is taken as the origin.
func (r *reExportOrigins) of(m *model.Module, name string, settled bool, hops int) (via, binding string, ok bool) {
	var e *model.Export
	for i := range m.Exports {
		if m.Exports[i].Name == name {
			e = &m.Exports[i]
			break
		}
	}
	if e == nil {
		return "", "", false
	}
	binding = name
	if e.ViaName != "" {
		binding = e.ViaName
	}
	if e.Via != "" {
		return e.Via, binding, true
	}
	link, linked := r.named[m.ID][name]
	var t *model.Module
	if linked && e.Kind == "re-export" && hops < 16 {
		t = r.byID[link.Target]
	}
	if t == nil {
		return m.ID, binding, true
	}
	if via, binding, ok := r.of(t, link.Imported, settled, hops+1); ok {
		return via, binding, true
	}
	if settled {
		return t.ID, link.Imported, true
	}
	return "", "", false
}

// AssignNamedReExportVias records each named re-export entry's origin as
// Via. The origin BINDING matters too: `export { b as a } from './x'`
// exposes x's `b` under the name `a` (ViaName "b") — a star sibling
// exposing x's own `a` is a different binding, hence ambiguous. MUST run
// after ExpandStarReExports (lockstep with the CJS pass after star
// expansion) so an entry whose target gains the name through its own
// `export *` names the defining module, not that intermediate barrel.
// Mutates modules in place.
func AssignNamedReExportVias(modules []model.Module, named map[string]map[string]NamedReExport) {
	byID := make(map[string]*model.Module, len(modules))
	for i := range modules {
		byID[modules[i].ID] = &modules[i]
	}
	origins := &reExportOrigins{byID: byID, named: named}
	for i := range modules {
		m := &modules[i]
		for j := range m.Exports {
			e := &m.Exports[j]
			if e.Kind != "re-export" || e.Via != "" {
				continue
			}
			via, binding, ok := origins.of(m, e.Name, true, 0)
			if !ok || via == m.ID {
				continue
			}
			e.Via = via
			if binding != e.Name {
				e.ViaName = binding
			}
		}
	}
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
func ExpandStarReExports(modules []model.Module, stars map[string][]StarReExport, named map[string]map[string]NamedReExport) {
	if len(stars) == 0 {
		return
	}
	byID := make(map[string]*model.Module, len(modules))
	for i := range modules {
		byID[modules[i].ID] = &modules[i]
	}
	origins := &reExportOrigins{byID: byID, named: named}
	barrels := make([]string, 0, len(stars))
	for id := range stars {
		barrels = append(barrels, id)
	}
	sort.Strings(barrels)

	// Iterate to the true fixpoint. Termination is guaranteed without a pass
	// cap: every pass either appends at least one export (total additions are
	// bounded by expansionCap × #barrels), marks a name ambiguous (bounded by
	// distinct names), or sets changed=false and stops — a fixed ceiling
	// would leave >N-deep barrel chains incomplete.
	//
	// Per-barrel bookkeeping: names added by THIS pass's star expansion
	// (name → origin key) and names dropped as ambiguous. Two star targets
	// providing the same name from DIFFERENT origins make it ambiguous (ES
	// spec): removed and never re-added. The same origin reached through
	// different chains is one binding and stays. Explicit exports are never
	// in starAdded, so they are never removed. A name whose origin is pending
	// (see reExportOrigins.of) waits for a later pass; if names are still
	// pending once the fixpoint settles, one more round resolves them as
	// settled.
	const expansionCap = 60
	starAdded := make(map[string]map[string]string, len(barrels))
	starAmbiguous := make(map[string]map[string]bool, len(barrels))
	for _, bid := range barrels {
		starAdded[bid] = make(map[string]string)
		starAmbiguous[bid] = make(map[string]bool)
	}
	settled := false
	for {
		changed := false
		pending := false
		for _, bid := range barrels {
			b := byID[bid]
			if b == nil {
				continue
			}
			have := make(map[string]bool, len(b.Exports))
			for _, e := range b.Exports {
				have[e.Name] = true
			}
			added := starAdded[bid]
			amb := starAmbiguous[bid]
			// Retract stale copies first: a downstream barrel can copy a name
			// in the pass BEFORE its upstream barrel drops that name as
			// ambiguous. If no current target still provides (name, via), the
			// copy is withdrawn; if a target provides the name from another
			// origin, the ambiguity branch below handles it.
			addedNames := make([]string, 0, len(added))
			for name := range added {
				addedNames = append(addedNames, name)
			}
			sort.Strings(addedNames)
			for _, name := range addedNames {
				originKey := added[name]
				stillProvided := false
				sameNameElsewhere := false
				for _, st := range stars[bid] {
					t := byID[st.Target]
					if t == nil {
						continue
					}
					for _, e := range t.Exports {
						if e.Name != name {
							continue
						}
						if e.Name != "default" {
							sameNameElsewhere = true
						}
						if via, binding, ok := origins.of(t, name, settled, 0); ok && via+"\x00"+binding == originKey {
							stillProvided = true
							break
						}
					}
					if stillProvided {
						break
					}
				}
				if stillProvided || sameNameElsewhere {
					continue // present, or left for the ambiguity branch
				}
				for i, x := range b.Exports {
					if x.Name == name && x.Via != "" && exportOriginKey(x, bid) == originKey {
						b.Exports = append(b.Exports[:i], b.Exports[i+1:]...)
						break
					}
				}
				delete(have, name)
				delete(added, name)
				changed = true
			}
			for _, st := range stars[bid] {
				t := byID[st.Target]
				if t == nil {
					continue
				}
				for _, e := range t.Exports {
					if e.Name == "default" {
						continue // a bare `export *` never forwards default (ES spec)
					}
					if amb[e.Name] {
						continue
					}
					via, binding, ok := origins.of(t, e.Name, settled, 0)
					if !ok {
						pending = true
						continue
					}
					originKey := via + "\x00" + binding
					if have[e.Name] {
						if prev, ok := added[e.Name]; ok && prev != originKey {
							for i, x := range b.Exports {
								if x.Name == e.Name && x.Via != "" && exportOriginKey(x, bid) == prev {
									b.Exports = append(b.Exports[:i], b.Exports[i+1:]...)
									break
								}
							}
							delete(have, e.Name)
							delete(added, e.Name)
							amb[e.Name] = true
							changed = true
						}
						continue
					}
					if len(b.Exports) >= expansionCap {
						break
					}
					have[e.Name] = true
					added[e.Name] = originKey
					cp := model.Export{Name: e.Name, Kind: "re-export", Line: st.Line, Doc: e.Doc, Via: via}
					if binding != e.Name {
						cp.ViaName = binding
					}
					b.Exports = append(b.Exports, cp)
					changed = true
				}
			}
		}
		if changed {
			continue
		}
		if pending && !settled {
			settled = true
			continue
		}
		break
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
