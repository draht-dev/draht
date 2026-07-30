package query

import (
	"bytes"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// TestCallDir_MultiParentSameLevelAccumulatesSymbols exercises the CJS's
// verbatim (if unusual) hop-accumulation rule: a node re-discovered at the
// SAME level via a second parent still appends another {from,to,symbol,hop}
// record (the guard is `level.get(nb.to) === level.get(id) + 1`, which is
// true for the second parent too, not `!level.has(nb.to)`). The rendered
// hop line then lists every distinct symbol contributed by every parent
// that reaches the node at that level — this is the mechanism the spec
// calls out as "how symbol lists accumulate".
func TestCallDir_MultiParentSameLevelAccumulatesSymbols(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		mkModule("r.ts", "r.ts"),
		mkModule("b.ts", "b.ts"),
		mkModule("c.ts", "c.ts"),
		mkModule("d.ts", "d.ts"),
	}
	m.Edges = []model.Edge{
		{From: "r.ts", To: "b.ts", Kind: "import"},
		{From: "r.ts", To: "c.ts", Kind: "import"},
	}
	m.CallEdges = []model.CallEdge{
		{From: "b.ts", To: "d.ts", Symbol: "foo"},
		{From: "c.ts", To: "d.ts", Symbol: "bar"},
	}

	var buf bytes.Buffer
	Callees(m, []string{"r.ts", "--depth", "2"}, &buf)

	want := "callees of r.ts — 3 within 2 hops\n" +
		"  hop 1:\n" +
		"    b.ts\n" +
		"    c.ts\n" +
		"  hop 2:\n" +
		"    d.ts  [foo, bar]\n"
	if got := buf.String(); got != want {
		t.Errorf("output =\n%s\nwant\n%s", got, want)
	}
}

// TestCallDir_UsesImportEdgesOnly_NotReExport confirms graph-callers/
// graph-callees deliberately use a DIFFERENT adjacency than graph-context/
// graph-impact: a re-export edge must NOT contribute a hop, even though it
// would contribute to BuildImportAdj (used by graph-context/impact/path).
func TestCallDir_UsesImportEdgesOnly_NotReExport(t *testing.T) {
	m := model.NewMap()
	m.Modules = []model.Module{
		mkModule("r.ts", "r.ts"),
		mkModule("b.ts", "b.ts"),
	}
	m.Edges = []model.Edge{
		{From: "r.ts", To: "b.ts", Kind: "re-export"},
	}

	var buf bytes.Buffer
	Callees(m, []string{"r.ts"}, &buf)
	want := "callees of r.ts — 0 within 1 hop\n"
	if got := buf.String(); got != want {
		t.Errorf("output = %q, want %q (re-export edges must not feed graph-callees)", got, want)
	}

	// Sanity: the SAME edge DOES feed graph-context's importer/imports
	// count via BuildImportAdj (import+re-export).
	adj := BuildImportAdj(m)
	if got := adj.Fwd["r.ts"]; len(got) != 1 || got[0] != "b.ts" {
		t.Errorf("BuildImportAdj.Fwd[r.ts] = %v, want [b.ts] (re-export must count for graph-context)", got)
	}
}
