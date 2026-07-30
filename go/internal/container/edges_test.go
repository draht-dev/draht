package container

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestBuildContainerEdges_AggregatesAndDedupsBySameContainerPair(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/a/y.ts", Path: "packages/a/y.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
		{From: "packages/a/y.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
		// same-container edge must be skipped
		{From: "packages/a/x.ts", To: "packages/a/y.ts", Kind: model.EdgeKindImport},
		// non-import kinds must be skipped in pass 1
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindReExport},
	}
	out := BuildContainerEdges(edges, nil, modules, nil)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1: %+v", len(out), out)
	}
	if out[0].From != "pkg:@draht/a" || out[0].To != "pkg:@draht/b" {
		t.Fatalf("edge = %+v, want pkg:@draht/a -> pkg:@draht/b", out[0])
	}
	if out[0].Count != 2 {
		t.Fatalf("Count = %d, want 2 (both import edges aggregated)", out[0].Count)
	}
	if out[0].CallCount != 0 {
		t.Fatalf("CallCount = %d, want 0 (no callEdges supplied)", out[0].CallCount)
	}
	if !reflect.DeepEqual(out[0].SymbolSamples, []string{}) {
		t.Fatalf("SymbolSamples = %v, want [] (never null)", out[0].SymbolSamples)
	}
}

func TestBuildContainerEdges_CallEdgesNeverCreateNewEntries(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
		{ID: "packages/c/w.ts", Path: "packages/c/w.ts", Package: model.Str("@draht/c")},
	}
	// No import edge from a->c, only a callEdge — must NOT produce a
	// containerEdge (pass 2 aggregates only, never creates).
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/c/w.ts", Symbol: "foo", Count: 1, Confidence: model.ConfidenceInferred},
	}
	out := BuildContainerEdges(nil, callEdges, modules, nil)
	if len(out) != 0 {
		t.Fatalf("len(out) = %d, want 0 (callEdges alone never create a containerEdge)", len(out))
	}
}

func TestBuildContainerEdges_CallEdgeAggregationAndSymbolSampleCapAndOrder(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
	}
	// 6 distinct symbols; only top 5 by frequency survive, ties broken by
	// first-seen order (stable sort).
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s1", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s2", Count: 5},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s3", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s4", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s5", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "s6", Count: 1}, // dropped: 6th, lowest freq tie, last-seen
	}
	out := BuildContainerEdges(edges, callEdges, modules, nil)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1", len(out))
	}
	want := []string{"s2", "s1", "s3", "s4", "s5"} // s2 highest freq first, rest tie-broken by first-seen order
	if !reflect.DeepEqual(out[0].SymbolSamples, want) {
		t.Fatalf("SymbolSamples = %v, want %v", out[0].SymbolSamples, want)
	}
	if out[0].CallCount != 10 {
		t.Fatalf("CallCount = %d, want 10 (sum of all 6 counts)", out[0].CallCount)
	}
}

func TestBuildContainerEdges_UnresolvedEndpointsSkipped(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/missing/z.ts", Kind: model.EdgeKindImport},
	}
	out := BuildContainerEdges(edges, nil, modules, nil)
	if len(out) != 0 {
		t.Fatalf("len(out) = %d, want 0 (unresolved target module must be skipped)", len(out))
	}
}

func TestBuildContainerEdges_Order_FirstImportOccurrence(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
		{ID: "packages/c/w.ts", Path: "packages/c/w.ts", Package: model.Str("@draht/c")},
	}
	edges := []model.Edge{
		{From: "packages/c/w.ts", To: "packages/a/x.ts", Kind: model.EdgeKindImport}, // c->a first
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport}, // a->b second
		{From: "packages/c/w.ts", To: "packages/a/x.ts", Kind: model.EdgeKindImport}, // repeat, no reorder
	}
	out := BuildContainerEdges(edges, nil, modules, nil)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	if out[0].From != "pkg:@draht/c" || out[0].To != "pkg:@draht/a" {
		t.Fatalf("out[0] = %+v, want first-occurrence c->a", out[0])
	}
	if out[1].From != "pkg:@draht/a" || out[1].To != "pkg:@draht/b" {
		t.Fatalf("out[1] = %+v, want second-occurrence a->b", out[1])
	}
}

func TestClassifyContainerEdge_LabelPriority(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b"), Sinks: []string{"fs:write"}},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
	}
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "emitSomething", Count: 3},
	}
	out := BuildContainerEdges(edges, callEdges, modules, nil)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1", len(out))
	}
	// "Sends Events" (rule 2) should win over "Persists" (rule 3, the
	// callee has fs:write) because it is checked first, and label is
	// labels[0].
	if out[0].Label != "Sends Events" {
		t.Fatalf("Label = %q, want Sends Events (priority order)", out[0].Label)
	}
	if !contains(out[0].Labels, "Persists") {
		t.Fatalf("Labels = %v, want to also contain Persists (ALL matching rules collected)", out[0].Labels)
	}
}

func TestClassifyContainerEdge_UsesWhenSparse(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
	}
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "Widget", Count: 2},
	}
	out := BuildContainerEdges(edges, callEdges, modules, nil)
	if out[0].Label != "Uses" {
		t.Fatalf("Label = %q, want Uses (only 1 symbol < 3)", out[0].Label)
	}
}

func TestClassifyContainerEdge_CallsFallback(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
	}
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "zzzOne", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "zzzTwo", Count: 1},
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "zzzThree", Count: 1},
	}
	out := BuildContainerEdges(edges, callEdges, modules, nil)
	if out[0].Label != "Calls" {
		t.Fatalf("Label = %q, want Calls (no rule matches, callCount>0, symbols>=3)", out[0].Label)
	}
}

func TestClassifyContainerEdge_RendersRequiresReactDepAndUppercaseSymbol(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/ui/z.ts", Path: "packages/ui/z.ts", Package: model.Str("@draht/ui")},
	}
	pkgs := []model.Package{
		{Name: "@draht/ui", Path: "packages/ui", Dependencies: []string{"react"}},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/ui/z.ts", Kind: model.EdgeKindImport},
	}
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/ui/z.ts", Symbol: "Button", Count: 4},
	}
	out := BuildContainerEdges(edges, callEdges, modules, pkgs)
	if out[0].Label != "Renders" {
		t.Fatalf("Label = %q, want Renders (react dep + uppercase symbol)", out[0].Label)
	}
}

func TestClassifyContainerEdge_NoConfidenceField(t *testing.T) {
	// Round-trip through JSON and assert "confidence" never appears —
	// v5's containerEdges record has exactly 7 keys, no confidence.
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
	}
	edges := []model.Edge{{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport}}
	out := BuildContainerEdges(edges, nil, modules, nil)
	b, err := json.Marshal(out[0])
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, ok := m["confidence"]; ok {
		t.Fatalf("containerEdge must not carry a confidence field: %s", b)
	}
	wantKeys := map[string]bool{"from": true, "to": true, "count": true, "callCount": true, "label": true, "labels": true, "symbolSamples": true}
	if len(m) != len(wantKeys) {
		t.Fatalf("containerEdge keys = %v, want exactly %v", m, wantKeys)
	}
	for k := range m {
		if !wantKeys[k] {
			t.Fatalf("unexpected key %q in containerEdge: %s", k, b)
		}
	}
}

func TestBuildContainerEdges_Determinism(t *testing.T) {
	modules := []model.Module{
		{ID: "packages/a/x.ts", Path: "packages/a/x.ts", Package: model.Str("@draht/a")},
		{ID: "packages/b/z.ts", Path: "packages/b/z.ts", Package: model.Str("@draht/b")},
		{ID: "packages/c/w.ts", Path: "packages/c/w.ts", Package: model.Str("@draht/c")},
	}
	edges := []model.Edge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Kind: model.EdgeKindImport},
		{From: "packages/b/z.ts", To: "packages/c/w.ts", Kind: model.EdgeKindImport},
		{From: "packages/c/w.ts", To: "packages/a/x.ts", Kind: model.EdgeKindImport},
	}
	callEdges := []model.CallEdge{
		{From: "packages/a/x.ts", To: "packages/b/z.ts", Symbol: "getFoo", Count: 2},
		{From: "packages/b/z.ts", To: "packages/c/w.ts", Symbol: "runTask", Count: 1},
	}
	run := func() []byte {
		out := BuildContainerEdges(edges, callEdges, modules, nil)
		b, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		return b
	}
	first := run()
	for i := 0; i < 20; i++ {
		if next := run(); string(next) != string(first) {
			t.Fatalf("BuildContainerEdges is not deterministic:\n%s\nvs\n%s", first, next)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
