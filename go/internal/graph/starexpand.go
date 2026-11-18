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

// ImportedLocals collects, per module id, the local names its plain imports
// bind (default and named; never a namespace), each with the module and name
// it stands for. `import { foo } from "./x"; export { foo }` exports x's
// binding, so origin resolution follows these like a named re-export. A name
// imported twice keeps the last import, as in CollectUsedLocals.
func ImportedLocals(mi []ModuleImports, resolver *Resolver) map[string]map[string]NamedReExport {
	out := make(map[string]map[string]NamedReExport)
	for _, m := range mi {
		for _, l := range CollectUsedLocals(ResolveImports(m.Imports, path.Dir(m.Path), resolver)) {
			if l.ImportedName == "*" {
				continue
			}
			links := out[m.Path]
			if links == nil {
				links = make(map[string]NamedReExport)
				out[m.Path] = links
			}
			links[l.Local] = NamedReExport{Target: l.Target, Imported: l.ImportedName}
		}
	}
	return out
}

// exportBinding is the BINDING an export stands for: the defining module plus
// the original name there (a local alias `export { a as b }` stands for `a`;
// `export { b as a } from './x'` stands for x's `b`). Same-binding routes are
// one export, so two star targets reaching the same binding never clash.
type exportBinding struct {
	mod, name string
}

type exportStatusKind int

const (
	statusNone      exportStatusKind = iota // the module does not export the name
	statusBinding                           // it exports exactly one binding
	statusAmbiguous                         // distinct bindings via different star targets: not exported
)

// exportStatus is the final answer for one (module, name) pair.
type exportStatus struct {
	kind    exportStatusKind
	binding exportBinding // valid only for statusBinding
}

// baseExport is a module's OWN declared export, snapshotted before any star
// copy exists so resolution is a pure function of the module graph.
type baseExport struct {
	kind    string
	viaName string
	doc     *string
}

type moduleBase struct {
	names  []string // declaration order
	byName map[string]baseExport
}

type exportEdge struct {
	mod  *model.Module
	name string
}

// exportNode is the dependency description of one (module, name) pair: a
// terminal binding, or edges to the pairs it resolves through. named marks a
// named re-export (single edge; a target that never exports the name is itself
// the origin).
type exportNode struct {
	terminal *exportBinding
	named    bool
	edges    []exportEdge
}

// exportResolver resolves re-exports with ECMAScript module semantics,
// computed per module from the modules' OWN declared exports so the answer
// never depends on file names or iteration order:
//   - an own export (local, alias, `export * as NS`) is its own binding, unless
//     it exports a name the module imported (`import { x } from './y'; export { x }`
//     is y's binding); a named
//     re-export (`export { x } from './y'`) takes the binding resolved at its
//     target, and a target that never exports the name (CommonJS: no extracted
//     exports) is itself the origin;
//   - otherwise `export *` resolves the name at every star target (never
//     `default`): one distinct binding → exported; several → ambiguous, NOT
//     exported (ES ResolveExport);
//   - ambiguity propagates (ES ResolveExport step "if resolution is ambiguous,
//     return ambiguous"): a barrel starring a target where the name is ambiguous
//     does not export it either, however its other targets resolve; a target
//     where the name is merely absent contributes nothing;
//   - modules that only reach a name through each other (a cycle) resolve it to
//     the same thing, from what enters the cycle from outside, never from a
//     stale half-computed state.
//
// Resolution runs Tarjan over lazily discovered (module, name) nodes: every
// strongly connected component is closed once and its status is final, so work
// stays polynomial even on dense barrel cycles. Lockstep with the CJS
// resolveExport in draht-tools.cjs — change both together.
type exportResolver struct {
	byID  map[string]*model.Module
	base  map[string]*moduleBase
	stars map[string][]StarReExport
	named map[string]map[string]NamedReExport
	// imported: module id -> local name -> the import it binds.
	imported map[string]map[string]NamedReExport

	resolved map[string]exportStatus
	index    map[string]int
	low      map[string]int
	nodes    map[string]*exportNode
	stack    []string
	counter  int
}

func newExportResolver(modules []model.Module, stars map[string][]StarReExport, named, imported map[string]map[string]NamedReExport) *exportResolver {
	r := &exportResolver{
		byID:     make(map[string]*model.Module, len(modules)),
		base:     make(map[string]*moduleBase, len(modules)),
		stars:    stars,
		named:    named,
		imported: imported,
		resolved: make(map[string]exportStatus),
		index:    make(map[string]int),
		low:      make(map[string]int),
		nodes:    make(map[string]*exportNode),
	}
	for i := range modules {
		m := &modules[i]
		r.byID[m.ID] = m
		b := &moduleBase{names: make([]string, 0, len(m.Exports)), byName: make(map[string]baseExport, len(m.Exports))}
		for _, e := range m.Exports {
			if _, dup := b.byName[e.Name]; dup {
				continue
			}
			b.names = append(b.names, e.Name)
			b.byName[e.Name] = baseExport{kind: e.Kind, viaName: e.ViaName, doc: e.Doc}
		}
		r.base[m.ID] = b
	}
	return r
}

func exportKey(modID, name string) string { return modID + "\x00" + name }

func (r *exportResolver) describe(m *model.Module, name string) *exportNode {
	if own, ok := r.base[m.ID].byName[name]; ok {
		var target *model.Module
		var link NamedReExport
		if own.kind == "re-export" {
			if l, linked := r.named[m.ID][name]; linked {
				link = l
				target = r.byID[l.Target]
			}
		}
		if target == nil {
			binding := name
			if own.viaName != "" {
				binding = own.viaName
			}
			if own.kind == "named" {
				if imp, ok := r.imported[m.ID][binding]; ok {
					if source := r.byID[imp.Target]; source != nil && source != m {
						return &exportNode{named: true, edges: []exportEdge{{mod: source, name: imp.Imported}}}
					}
				}
			}
			return &exportNode{terminal: &exportBinding{mod: m.ID, name: binding}}
		}
		return &exportNode{named: true, edges: []exportEdge{{mod: target, name: link.Imported}}}
	}
	node := &exportNode{}
	if name != "default" { // a bare `export *` never forwards default (ES spec)
		for _, st := range r.stars[m.ID] {
			if t := r.byID[st.Target]; t != nil {
				node.edges = append(node.edges, exportEdge{mod: t, name: name})
			}
		}
	}
	return node
}

func (r *exportResolver) resolve(m *model.Module, name string) exportStatus {
	key := exportKey(m.ID, name)
	if _, done := r.resolved[key]; !done {
		r.strongConnect(m, name, key)
	}
	return r.resolved[key]
}

func (r *exportResolver) strongConnect(m *model.Module, name, key string) {
	node := r.describe(m, name)
	r.nodes[key] = node
	r.index[key] = r.counter
	r.low[key] = r.counter
	r.counter++
	r.stack = append(r.stack, key)
	for _, e := range node.edges {
		childKey := exportKey(e.mod.ID, e.name)
		if _, done := r.resolved[childKey]; done {
			continue
		}
		if _, seen := r.index[childKey]; !seen {
			r.strongConnect(e.mod, e.name, childKey)
			r.low[key] = min(r.low[key], r.low[childKey])
		} else {
			r.low[key] = min(r.low[key], r.index[childKey])
		}
	}
	if r.low[key] != r.index[key] {
		return
	}
	members := map[string]bool{}
	var order []string
	for {
		k := r.stack[len(r.stack)-1]
		r.stack = r.stack[:len(r.stack)-1]
		members[k] = true
		order = append(order, k)
		if k == key {
			break
		}
	}
	var found []exportBinding
	ambiguous := false
	add := func(b exportBinding) {
		for _, f := range found {
			if f == b {
				return
			}
		}
		found = append(found, b)
	}
	for _, k := range order {
		member := r.nodes[k]
		if member.terminal != nil {
			add(*member.terminal)
		}
		for _, e := range member.edges {
			childKey := exportKey(e.mod.ID, e.name)
			if members[childKey] {
				continue
			}
			switch child := r.resolved[childKey]; {
			case child.kind == statusAmbiguous:
				ambiguous = true
			case child.kind == statusBinding:
				add(child.binding)
			case member.named:
				add(exportBinding{mod: e.mod.ID, name: e.name})
			}
		}
	}
	status := exportStatus{}
	switch {
	case ambiguous || len(found) > 1:
		status = exportStatus{kind: statusAmbiguous}
	case len(found) == 1:
		status = exportStatus{kind: statusBinding, binding: found[0]}
	}
	for _, k := range order {
		r.resolved[k] = status
		delete(r.nodes, k)
	}
}

// exportedNames is ES GetExportedNames: own names, then every star target's
// (recursively, once per module), never `default` through a star.
func (r *exportResolver) exportedNames(m *model.Module, visited map[string]bool) []string {
	if visited[m.ID] {
		return nil
	}
	visited[m.ID] = true
	b := r.base[m.ID]
	names := append([]string(nil), b.names...)
	seen := make(map[string]bool, len(names))
	for _, n := range names {
		seen[n] = true
	}
	for _, st := range r.stars[m.ID] {
		t := r.byID[st.Target]
		if t == nil {
			continue
		}
		for _, n := range r.exportedNames(t, visited) {
			if n == "default" || seen[n] {
				continue
			}
			seen[n] = true
			names = append(names, n)
		}
	}
	return names
}

// docOf is the doc of the nearest entry providing binding for name: the
// module's own entry, else the first star target (in source order) that
// provides it. ok=false means no provider was found on this path.
func (r *exportResolver) docOf(m *model.Module, name string, binding exportBinding, seen map[string]bool) (*string, bool) {
	if own, ok := r.base[m.ID].byName[name]; ok {
		return own.doc, true
	}
	key := exportKey(m.ID, name)
	if seen[key] {
		return nil, false
	}
	seen[key] = true
	for _, st := range r.stars[m.ID] {
		t := r.byID[st.Target]
		if t == nil {
			continue
		}
		s := r.resolve(t, name)
		if s.kind != statusBinding || s.binding != binding {
			continue
		}
		if doc, ok := r.docOf(t, name, binding, seen); ok {
			return doc, true
		}
	}
	return nil, false
}

// ResolveReExports ports the CJS re-export pass (draht-tools.cjs, after the
// edges loop). `export * from './x'` declares no names, so without star
// expansion a star barrel's public API is invisible to graph-context/
// graph-query/MAP.html search: each resolved name is copied in as kind
// "re-export" (Via = the real defining module, ViaName when an alias renamed
// the binding) in GetExportedNames order. The 60-per-module cap (own exports
// included) bounds MAP.json growth and is applied after resolution, so which
// names survive it is deterministic. Expanded names are then mirrored into
// symbols, and every named re-export entry records its origin as Via — the
// origin BINDING matters too: `export { b as a } from './x'` exposes x's `b`
// under the name `a` (ViaName "b"), a different binding than x's own `a`.
//
// MUST run after edges are built (targets need resolution) and before
// Assemble (symbolIndex and every other consumer reads modules' exports/
// symbols). Mutates modules in place.
func ResolveReExports(modules []model.Module, stars map[string][]StarReExport, named, imported map[string]map[string]NamedReExport) {
	r := newExportResolver(modules, stars, named, imported)

	const expansionCap = 60
	barrels := make([]string, 0, len(stars))
	for id := range stars {
		barrels = append(barrels, id)
	}
	sort.Strings(barrels)

	for _, bid := range barrels {
		b := r.byID[bid]
		if b == nil {
			continue
		}
		own := r.base[bid].byName
		for _, name := range r.exportedNames(b, map[string]bool{}) {
			if _, ok := own[name]; ok {
				continue // an explicit export shadows the star
			}
			if len(b.Exports) >= expansionCap {
				break
			}
			origin := r.resolve(b, name)
			if origin.kind != statusBinding {
				continue
			}
			// line/doc come from the first star statement whose target provides the binding.
			line := 1
			var doc *string
			for _, st := range stars[bid] {
				t := r.byID[st.Target]
				if t == nil {
					continue
				}
				s := r.resolve(t, name)
				if s.kind != statusBinding || s.binding != origin.binding {
					continue
				}
				line = st.Line
				if d, ok := r.docOf(t, name, origin.binding, map[string]bool{}); ok {
					doc = d
				}
				break
			}
			cp := model.Export{Name: name, Kind: "re-export", Line: line, Doc: doc, Via: origin.binding.mod}
			if origin.binding.name != name {
				cp.ViaName = origin.binding.name
			}
			b.Exports = append(b.Exports, cp)
		}
	}
	for _, bid := range barrels {
		b := r.byID[bid]
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

	for i := range modules {
		m := &modules[i]
		for j := range m.Exports {
			e := &m.Exports[j]
			if e.Kind != "re-export" || e.Via != "" {
				continue
			}
			origin := r.resolve(m, e.Name)
			if origin.kind != statusBinding || origin.binding.mod == m.ID {
				continue
			}
			e.Via = origin.binding.mod
			if origin.binding.name != e.Name {
				e.ViaName = origin.binding.name
			}
		}
	}
}
