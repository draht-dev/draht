package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/extract"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// sitesFrom scans src for every local's call sites (via extract.ScanCallSites)
// and returns them keyed by local name, the shape BuildCallEdges now expects
// (Phase 2 moved the regex scan itself into internal/extract — see
// extract.ScanCallSites/CallLocals).
func sitesFrom(src string, locals []UsedLocal) map[string]extract.CallSite {
	names := make([]string, len(locals))
	for i, l := range locals {
		names[i] = l.Local
	}
	scanned := extract.ScanCallSites([]byte(src), names)
	out := make(map[string]extract.CallSite, len(scanned))
	for _, s := range scanned {
		out[s.Local] = s
	}
	return out
}

func idxFor(modules []string, workspaceEntry map[string]string) *ResolverIndex {
	set := make(map[string]struct{}, len(modules))
	for _, m := range modules {
		set[m] = struct{}{}
	}
	if workspaceEntry == nil {
		workspaceEntry = map[string]string{}
	}
	return &ResolverIndex{Modules: set, WorkspaceEntry: workspaceEntry}
}

func TestBuildEdgesImportKind(t *testing.T) {
	idx := idxFor([]string{"packages/ai/src/index.ts", "packages/ai/src/models.ts"}, nil)
	r := NewResolver(idx)
	mi := []ModuleImports{
		{
			Path: "packages/ai/src/index.ts",
			Imports: []parse.Import{
				{Kind: parse.KindImport, Specifier: "./models"},
			},
		},
	}
	edges := BuildEdges(mi, r)
	if len(edges) != 1 {
		t.Fatalf("len(edges) = %d, want 1", len(edges))
	}
	e := edges[0]
	if e.From != "packages/ai/src/index.ts" || e.To != "packages/ai/src/models.ts" {
		t.Errorf("edge = %+v", e)
	}
	if e.Kind != model.EdgeKindImport {
		t.Errorf("Kind = %q, want %q", e.Kind, model.EdgeKindImport)
	}
	if e.Confidence != model.ConfidenceExtracted {
		t.Errorf("Confidence = %q, want %q", e.Confidence, model.ConfidenceExtracted)
	}
	if e.Resolved != nil {
		t.Errorf("Resolved = %v, want nil (omitted) for a resolved import edge", e.Resolved)
	}
}

func TestBuildEdgesReExportKind(t *testing.T) {
	idx := idxFor([]string{"packages/ai/src/index.ts", "packages/ai/src/models.ts"}, nil)
	r := NewResolver(idx)
	mi := []ModuleImports{
		{
			Path: "packages/ai/src/index.ts",
			Imports: []parse.Import{
				{Kind: parse.KindReExport, Specifier: "./models"},
			},
		},
	}
	edges := BuildEdges(mi, r)
	if len(edges) != 1 || edges[0].Kind != model.EdgeKindReExport {
		t.Fatalf("edges = %+v, want a single re-export edge", edges)
	}
}

func TestBuildEdgesUnresolvedIsExternal(t *testing.T) {
	idx := idxFor([]string{"packages/ai/src/index.ts"}, nil)
	r := NewResolver(idx)
	mi := []ModuleImports{
		{
			Path: "packages/ai/src/index.ts",
			Imports: []parse.Import{
				{Kind: parse.KindImport, Specifier: "lodash"},
				{Kind: parse.KindImport, Specifier: "./nonexistent"},
			},
		},
	}
	edges := BuildEdges(mi, r)
	if len(edges) != 2 {
		t.Fatalf("len(edges) = %d, want 2", len(edges))
	}
	for i, e := range edges {
		if e.Kind != model.EdgeKindExternal {
			t.Errorf("edges[%d].Kind = %q, want external", i, e.Kind)
		}
		if e.Resolved == nil || *e.Resolved != false {
			t.Errorf("edges[%d].Resolved = %v, want &false", i, e.Resolved)
		}
		if e.Confidence != model.ConfidenceExtracted {
			t.Errorf("edges[%d].Confidence = %q, want EXTRACTED (edges[] is always EXTRACTED)", i, e.Confidence)
		}
	}
	if edges[0].To != "lodash" {
		t.Errorf("edges[0].To = %q, want the raw specifier %q", edges[0].To, "lodash")
	}
	if edges[1].To != "./nonexistent" {
		t.Errorf("edges[1].To = %q, want the raw specifier %q", edges[1].To, "./nonexistent")
	}
}

func TestBuildEdgesNoDedup(t *testing.T) {
	idx := idxFor([]string{"packages/ai/src/index.ts", "packages/ai/src/models.ts"}, nil)
	r := NewResolver(idx)
	mi := []ModuleImports{
		{
			Path: "packages/ai/src/index.ts",
			Imports: []parse.Import{
				{Kind: parse.KindImport, Specifier: "./models"},
				{Kind: parse.KindImport, Specifier: "./models"},
			},
		},
	}
	edges := BuildEdges(mi, r)
	if len(edges) != 2 {
		t.Fatalf("len(edges) = %d, want 2 (duplicates must be preserved, design D6)", len(edges))
	}
}

func TestBuildEdgesPreservesModuleAndImportOrder(t *testing.T) {
	idx := idxFor([]string{
		"packages/ai/src/a.ts", "packages/ai/src/b.ts", "packages/ai/src/c.ts",
	}, nil)
	r := NewResolver(idx)
	mi := []ModuleImports{
		{Path: "packages/ai/src/c.ts", Imports: []parse.Import{{Kind: parse.KindImport, Specifier: "./a"}}},
		{Path: "packages/ai/src/b.ts", Imports: []parse.Import{{Kind: parse.KindImport, Specifier: "./a"}, {Kind: parse.KindImport, Specifier: "./c"}}},
	}
	edges := BuildEdges(mi, r)
	want := []string{"packages/ai/src/c.ts", "packages/ai/src/b.ts", "packages/ai/src/b.ts"}
	if len(edges) != len(want) {
		t.Fatalf("len(edges) = %d, want %d", len(edges), len(want))
	}
	for i, e := range edges {
		if e.From != want[i] {
			t.Errorf("edges[%d].From = %q, want %q (module order must be preserved, never re-sorted)", i, e.From, want[i])
		}
	}
}

func TestCollectUsedLocalsSkipsReExports(t *testing.T) {
	resolved := []ResolvedImport{
		{Import: parse.Import{Kind: parse.KindReExport, Names: []parse.Name{{Imported: "foo"}}}, Target: "m1", Resolved: true},
		{Import: parse.Import{Kind: parse.KindImport, Default: "bar"}, Target: "m2", Resolved: true},
	}
	got := CollectUsedLocals(resolved)
	if len(got) != 1 || got[0].Local != "bar" || got[0].ImportedName != "default" {
		t.Fatalf("got %+v", got)
	}
}

func TestCollectUsedLocalsSkipsUnresolved(t *testing.T) {
	resolved := []ResolvedImport{
		{Import: parse.Import{Kind: parse.KindImport, Default: "bar"}, Target: "lodash", Resolved: false},
	}
	got := CollectUsedLocals(resolved)
	if len(got) != 0 {
		t.Fatalf("got %+v, want no locals from an unresolved import", got)
	}
}

func TestCollectUsedLocalsNamedImportLocalAlias(t *testing.T) {
	resolved := []ResolvedImport{
		{
			Import: parse.Import{
				Kind:  parse.KindImport,
				Names: []parse.Name{{Imported: "a", Local: "b"}, {Imported: "c"}},
			},
			Target:   "m1",
			Resolved: true,
		},
	}
	got := CollectUsedLocals(resolved)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].Local != "b" || got[0].ImportedName != "a" {
		t.Errorf("got[0] = %+v, want Local=b ImportedName=a", got[0])
	}
	if got[1].Local != "c" || got[1].ImportedName != "c" {
		t.Errorf("got[1] = %+v, want Local=c ImportedName=c (Local omitted == Imported)", got[1])
	}
}

func TestCollectUsedLocalsNamespaceImport(t *testing.T) {
	resolved := []ResolvedImport{
		{Import: parse.Import{Kind: parse.KindImport, Namespace: "ns"}, Target: "m1", Resolved: true},
	}
	got := CollectUsedLocals(resolved)
	if len(got) != 1 || got[0].Local != "ns" || got[0].ImportedName != "*" {
		t.Fatalf("got %+v", got)
	}
}

func TestCollectUsedLocalsFirstEncounterPositionLastValueWins(t *testing.T) {
	resolved := []ResolvedImport{
		{Import: parse.Import{Kind: parse.KindImport, Default: "x"}, Target: "first", Resolved: true},
		{Import: parse.Import{Kind: parse.KindImport, Names: []parse.Name{{Imported: "y"}}}, Target: "second", Resolved: true},
		{Import: parse.Import{Kind: parse.KindImport, Default: "x"}, Target: "third", Resolved: true},
	}
	got := CollectUsedLocals(resolved)
	if len(got) != 2 {
		t.Fatalf("got %+v, want 2 distinct locals", got)
	}
	if got[0].Local != "x" || got[0].Target != "third" {
		t.Errorf("got[0] = %+v, want Local=x Target=third (position kept, value updated)", got[0])
	}
	if got[1].Local != "y" {
		t.Errorf("got[1] = %+v, want Local=y", got[1])
	}
}

func TestCallConfidence(t *testing.T) {
	if got := CallConfidence(true); got != model.ConfidenceInferred {
		t.Errorf("CallConfidence(true) = %q, want INFERRED", got)
	}
	if got := CallConfidence(false); got != model.ConfidenceAmbiguous {
		t.Errorf("CallConfidence(false) = %q, want AMBIGUOUS", got)
	}
}

func TestBuildCallEdgesDirectCallIsInferred(t *testing.T) {
	src := `const result = calculateCost(a, b);`
	locals := []UsedLocal{{Local: "calculateCost", ImportedName: "calculateCost", Target: "packages/ai/src/models.ts"}}
	edges := BuildCallEdges("packages/ai/src/caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 1 {
		t.Fatalf("len(edges) = %d, want 1", len(edges))
	}
	e := edges[0]
	if e.Confidence != model.ConfidenceInferred {
		t.Errorf("Confidence = %q, want INFERRED", e.Confidence)
	}
	if e.Count != 1 {
		t.Errorf("Count = %d, want 1", e.Count)
	}
	if e.To != "packages/ai/src/models.ts" || e.Symbol != "calculateCost" || e.From != "packages/ai/src/caller.ts" {
		t.Errorf("edge = %+v", e)
	}
}

func TestBuildCallEdgesMemberOnlyCallIsAmbiguous(t *testing.T) {
	src := `const x = models.calculateCost(a, b);`
	locals := []UsedLocal{{Local: "models", ImportedName: "*", Target: "packages/ai/src/models.ts"}}
	edges := BuildCallEdges("caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 1 || edges[0].Confidence != model.ConfidenceAmbiguous {
		t.Fatalf("edges = %+v, want a single AMBIGUOUS edge", edges)
	}
}

func TestBuildCallEdgesMixedDirectAndMemberIsInferred(t *testing.T) {
	// Seen once as a direct call and once as a member call -> INFERRED wins
	// (at least one direct call was observed), count reflects BOTH forms.
	src := `models(); models.foo();`
	locals := []UsedLocal{{Local: "models", ImportedName: "*", Target: "m1"}}
	edges := BuildCallEdges("caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 1 {
		t.Fatalf("edges = %+v", edges)
	}
	if edges[0].Confidence != model.ConfidenceInferred {
		t.Errorf("Confidence = %q, want INFERRED", edges[0].Confidence)
	}
	if edges[0].Count != 2 {
		t.Errorf("Count = %d, want 2", edges[0].Count)
	}
}

func TestBuildCallEdgesZeroCallSitesProducesNoEdge(t *testing.T) {
	src := `const x = 1;`
	locals := []UsedLocal{{Local: "unused", ImportedName: "unused", Target: "m1"}}
	edges := BuildCallEdges("caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 0 {
		t.Fatalf("edges = %+v, want none", edges)
	}
}

func TestBuildCallEdgesCapsCountAt101(t *testing.T) {
	src := ""
	for i := 0; i < 150; i++ {
		src += "fn();"
	}
	locals := []UsedLocal{{Local: "fn", ImportedName: "fn", Target: "m1"}}
	edges := BuildCallEdges("caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 1 {
		t.Fatalf("edges = %+v", edges)
	}
	if edges[0].Count != 101 {
		t.Errorf("Count = %d, want 101 (cjs caps at count>100 break, i.e. 101 recorded)", edges[0].Count)
	}
}

func TestBuildCallEdgesEscapesRegexMetacharacters(t *testing.T) {
	// A local name containing a regex metacharacter ("$", a valid JS/TS
	// identifier character) must not corrupt the generated call-site
	// pattern. Placed mid-identifier (not leading) so the \b word-boundary
	// anchor still applies, matching a real local name shape.
	src := `const y = a$b(1);`
	locals := []UsedLocal{{Local: "a$b", ImportedName: "a$b", Target: "m1"}}
	edges := BuildCallEdges("caller.ts", locals, sitesFrom(src, locals))
	if len(edges) != 1 || edges[0].Count != 1 {
		t.Fatalf("edges = %+v", edges)
	}
}
