package graph

import (
	"path"

	"github.com/draht-dev/draht/go/internal/extract"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// ModuleImports pairs one TS/JS module's repo-relative path with its raw
// parsed import records, in the parser's own emission order (design D3:
// edges are built from TS/JS modules only; the caller is responsible for
// filtering to those languages before calling BuildEdges).
type ModuleImports struct {
	Path    string
	Imports []parse.Import
}

// ResolvedImport pairs one raw import record with its resolution outcome.
// When Resolved is false, Target holds the raw specifier (unresolved
// relative AND bare specifiers both surface this way — design Spike 4 §A4:
// the CJS engine reports both as "external", not as a distinct kind).
type ResolvedImport struct {
	Import   parse.Import
	Target   string
	Resolved bool
}

// ResolveImports resolves every import in imports against resolver, using
// fromDir as the importing module's directory. Order is preserved from the
// input slice (never re-sorted — see parse.Result's ordering contract).
func ResolveImports(imports []parse.Import, fromDir string, resolver *Resolver) []ResolvedImport {
	out := make([]ResolvedImport, len(imports))
	for i, imp := range imports {
		if target, ok := resolver.Resolve(imp.Specifier, fromDir); ok {
			out[i] = ResolvedImport{Import: imp, Target: target, Resolved: true}
		} else {
			out[i] = ResolvedImport{Import: imp, Target: imp.Specifier, Resolved: false}
		}
	}
	return out
}

// EdgesForModule builds model.Edge records for one module's already-resolved
// imports (draht-tools.cjs:2296-2299): one edge per import record,
// "re-export" kind for parse.KindReExport, unresolved => kind "external"
// with To set to the raw specifier and Resolved pointing at false. No dedup
// (design D6 — duplicate specifiers legitimately produce duplicate edges).
func EdgesForModule(fromID string, resolved []ResolvedImport) []model.Edge {
	edges := make([]model.Edge, 0, len(resolved))
	for _, ri := range resolved {
		if !ri.Resolved {
			edges = append(edges, model.Edge{
				From:       fromID,
				To:         ri.Target,
				Kind:       model.EdgeKindExternal,
				Confidence: model.ConfidenceExtracted,
				Resolved:   model.Bool(false),
			})
			continue
		}
		kind := model.EdgeKindImport
		if ri.Import.Kind == parse.KindReExport {
			kind = model.EdgeKindReExport
		}
		edges = append(edges, model.Edge{
			From:       fromID,
			To:         ri.Target,
			Kind:       kind,
			Confidence: model.ConfidenceExtracted,
		})
	}
	return edges
}

// BuildEdges constructs model.Edge records from TS/JS modules only (design
// D3). mi MUST already be in the module's final deterministic order
// (repo-relative path ascending, matching scan.Discover's sort) — BuildEdges
// iterates it as given and never re-sorts.
func BuildEdges(mi []ModuleImports, resolver *Resolver) []model.Edge {
	edges := make([]model.Edge, 0)
	for _, m := range mi {
		fromDir := path.Dir(m.Path)
		resolved := ResolveImports(m.Imports, fromDir, resolver)
		edges = append(edges, EdgesForModule(m.Path, resolved)...)
	}
	return edges
}

// UsedLocal is a local binding introduced by a resolved, non-re-export
// import — the unit CallConfidence/BuildCallEdges scan the raw source for
// (design Spike 4 §A2 "usedLocals").
type UsedLocal struct {
	// Local is the name bound in the importing module's scope (the
	// binding actually referenced at call sites).
	Local string
	// ImportedName is the symbol name as declared by the exporting module:
	// "default" for a default import, "*" for a namespace import, or the
	// imported (not local/aliased) name for a named import.
	ImportedName string
	// Target is the resolved module id the import came from.
	Target string
}

// CollectUsedLocals extracts the UsedLocal set from one module's already-
// resolved imports, in encounter order (draht-tools.cjs:2302-2307).
// Re-export imports never contribute (a barrel does not introduce local
// usage). A local name that recurs keeps its FIRST encounter position but
// its LAST target/importedName — mirroring a JS Map's `.set()`, which
// updates a key's value in place without moving it.
func CollectUsedLocals(resolved []ResolvedImport) []UsedLocal {
	var order []string
	byLocal := make(map[string]UsedLocal)
	add := func(local, importedName, target string) {
		if local == "" {
			return
		}
		if _, exists := byLocal[local]; !exists {
			order = append(order, local)
		}
		byLocal[local] = UsedLocal{Local: local, ImportedName: importedName, Target: target}
	}
	for _, ri := range resolved {
		if !ri.Resolved || ri.Import.Kind == parse.KindReExport {
			continue
		}
		if ri.Import.Default != "" {
			add(ri.Import.Default, "default", ri.Target)
		}
		if ri.Import.Namespace != "" {
			add(ri.Import.Namespace, "*", ri.Target)
		}
		for _, n := range ri.Import.Names {
			local := n.Local
			if local == "" {
				local = n.Imported
			}
			add(local, n.Imported, ri.Target)
		}
	}
	out := make([]UsedLocal, len(order))
	for i, l := range order {
		out[i] = byLocal[l]
	}
	return out
}

// CallConfidence classifies one symbol's call-site usage
// (draht-tools.cjs:2318-2321): INFERRED when the local name was seen at
// least once as a direct call (`name(`); AMBIGUOUS when it was seen only as
// a member call (`name.member(`) — the actual symbol invoked is uncertain.
func CallConfidence(hasDirectCall bool) string {
	if hasDirectCall {
		return model.ConfidenceInferred
	}
	return model.ConfidenceAmbiguous
}

// BuildCallEdges joins one module's resolved UsedLocal set (see
// CollectUsedLocals — already deduplicated, first-position/last-value,
// re-export imports excluded) with its cached per-local call-site scan
// (extract.CallSite, computed once at extraction time against the module's
// RAW source — see extract.ScanCallSites / extract.File) into
// model.CallEdge records, preserving locals' order. A local absent from
// sites, or present with zero recorded matches, produces no edge.
func BuildCallEdges(fromID string, locals []UsedLocal, sites map[string]extract.CallSite) []model.CallEdge {
	if len(locals) == 0 {
		return nil
	}
	out := make([]model.CallEdge, 0, len(locals))
	for _, l := range locals {
		site, ok := sites[l.Local]
		if !ok || site.Count == 0 {
			continue
		}
		out = append(out, model.CallEdge{
			From:       fromID,
			To:         l.Target,
			Symbol:     l.ImportedName,
			Count:      site.Count,
			Confidence: CallConfidence(site.Direct),
		})
	}
	return out
}

// BuildCallEdgesAll builds the full callEdges[] list for every TS/JS module
// in mi, in modules order then usedLocals-insertion order (matching
// draht-tools.cjs's own callEdges construction order). sitesByPath is each
// module's extract.CallSite scan results (extract.Facts.CallSites), keyed
// by the module's repo-relative path; a module absent from it (no TS/JS
// imports, or extraction never ran) contributes no callEdges. Imports are
// re-resolved here (cheap, pure — see ResolveImports) rather than sharing
// BuildEdges' pass, so this function has no dependency on edges[]'s own
// construction order.
func BuildCallEdgesAll(mi []ModuleImports, resolver *Resolver, sitesByPath map[string][]extract.CallSite) []model.CallEdge {
	out := make([]model.CallEdge, 0)
	for _, m := range mi {
		sitesSlice := sitesByPath[m.Path]
		if len(sitesSlice) == 0 {
			continue
		}
		fromDir := path.Dir(m.Path)
		resolved := ResolveImports(m.Imports, fromDir, resolver)
		locals := CollectUsedLocals(resolved)
		if len(locals) == 0 {
			continue
		}
		sites := make(map[string]extract.CallSite, len(sitesSlice))
		for _, s := range sitesSlice {
			sites[s.Local] = s
		}
		out = append(out, BuildCallEdges(m.Path, locals, sites)...)
	}
	return out
}

// ImportDegrees builds the test-INCLUDED import-edge degree maps
// (draht-tools.cjs:2364-2371 inDeg/outDeg — distinct from rank.NonTestDegrees'
// test-excluded inDegNT/outDegNT). Only edges with Kind == "import"
// contribute; duplicate edges are counted, not deduplicated. Shared by
// internal/container's topFiles ranking and internal/symindex's symbolIndex
// ranking, which both use this exact (test-inclusive) pair in the CJS
// source.
func ImportDegrees(edges []model.Edge) (in, out map[string]int) {
	in = make(map[string]int)
	out = make(map[string]int)
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		out[e.From]++
		in[e.To]++
	}
	return in, out
}

// Adjacency builds the directed, import+re-export reachability adjacency
// (draht-tools.cjs:2515-2520 / 2547-2550's `adj`), in edges order, with
// duplicates preserved. Used by internal/flow's BFS import-fallback.
func Adjacency(edges []model.Edge) map[string][]string {
	out := make(map[string][]string)
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport && e.Kind != model.EdgeKindReExport {
			continue
		}
		out[e.From] = append(out[e.From], e.To)
	}
	return out
}

// ReExportTargets extracts, per module id, the RESOLVED re-export target
// ids in edges order with self-targets removed (draht-tools.cjs:2559-2571's
// reExportTargetsByModule). edges is already built in modules-ASC x
// parsedImports order, and re-export edges retain their relative
// parsedImports order within that — so this needs no independent
// re-resolution pass.
func ReExportTargets(edges []model.Edge) map[string][]string {
	out := make(map[string][]string)
	for _, e := range edges {
		if e.Kind != model.EdgeKindReExport {
			continue
		}
		if e.To == e.From {
			continue
		}
		out[e.From] = append(out[e.From], e.To)
	}
	return out
}
