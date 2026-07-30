package cluster

import (
	"fmt"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func layerModule(id, layer string) model.Module {
	return model.Module{ID: id, Path: id, Layer: layer}
}

func TestSurprising_AllThreeRulesScore(t *testing.T) {
	modules := []model.Module{
		layerModule("cluster1/a.ts", model.LayerInfrastructure),
		layerModule("cluster2/b.ts", model.LayerPresentation),
	}
	edges := []model.Edge{imp("cluster1/a.ts", "cluster2/b.ts")}
	clusterOf := map[string]string{
		"cluster1/a.ts": "cluster:1",
		"cluster2/b.ts": "cluster:2",
	}
	groupOfContainer := map[string]string{
		"dir:cluster1": "group:x",
		"dir:cluster2": "group:y",
	}

	out := Surprising(modules, edges, nil, clusterOf, groupOfContainer)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1", len(out))
	}
	got := out[0]
	if got.Score != 5 {
		t.Errorf("score = %v, want 5 (outward +2, bridge +2, cross-group +1)", got.Score)
	}
	wantReason := "infrastructure→presentation (outward), bridge, cross-group"
	if got.Reason != wantReason {
		t.Errorf("reason = %q, want %q", got.Reason, wantReason)
	}
	if len(got.SampleSymbols) != 0 {
		t.Errorf("sampleSymbols = %v, want empty (never nil)", got.SampleSymbols)
	}
}

func TestSurprising_SameClusterSkipped(t *testing.T) {
	modules := []model.Module{
		layerModule("a.ts", model.LayerInfrastructure),
		layerModule("b.ts", model.LayerPresentation),
	}
	edges := []model.Edge{imp("a.ts", "b.ts")}
	clusterOf := map[string]string{"a.ts": "cluster:same", "b.ts": "cluster:same"}

	out := Surprising(modules, edges, nil, clusterOf, nil)
	if len(out) != 0 {
		t.Fatalf("len(out) = %d, want 0 (same-cluster edges are never surprising)", len(out))
	}
}

func TestSurprising_DedupsByFromTo(t *testing.T) {
	modules := []model.Module{
		layerModule("a.ts", model.LayerSupport),
		layerModule("b.ts", model.LayerSupport),
	}
	edges := []model.Edge{
		imp("a.ts", "b.ts"),
		imp("a.ts", "b.ts"), // duplicate must not produce a second candidate
	}
	clusterOf := map[string]string{"a.ts": "cluster:1", "b.ts": "cluster:2"}
	// Duplicate edges also count twice in pairCount, disqualifying the
	// "bridge" rule (pairCount > 1) — use cross-group scoring instead so
	// the candidate still scores, isolating the dedup behaviour under test.
	groupOfContainer := map[string]string{"dir:a.ts": "group:x", "dir:b.ts": "group:y"}

	out := Surprising(modules, edges, nil, clusterOf, groupOfContainer)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1 (deduped)", len(out))
	}
	if out[0].Score != 1 {
		t.Errorf("score = %v, want 1 (cross-group only; bridge disqualified by pairCount=2)", out[0].Score)
	}
}

func TestSurprising_SampleSymbolsCappedAtFourDistinct(t *testing.T) {
	modules := []model.Module{
		layerModule("a.ts", model.LayerSupport),
		layerModule("b.ts", model.LayerSupport),
	}
	edges := []model.Edge{imp("a.ts", "b.ts")}
	clusterOf := map[string]string{"a.ts": "cluster:1", "b.ts": "cluster:2"}
	callEdges := []model.CallEdge{
		{From: "a.ts", To: "b.ts", Symbol: "one", Count: 1},
		{From: "a.ts", To: "b.ts", Symbol: "two", Count: 1},
		{From: "a.ts", To: "b.ts", Symbol: "one", Count: 1}, // duplicate symbol, no growth
		{From: "a.ts", To: "b.ts", Symbol: "three", Count: 1},
		{From: "a.ts", To: "b.ts", Symbol: "four", Count: 1},
		{From: "a.ts", To: "b.ts", Symbol: "five", Count: 1}, // beyond cap of 4, dropped
	}

	out := Surprising(modules, edges, callEdges, clusterOf, nil)
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1", len(out))
	}
	want := []string{"one", "two", "three", "four"}
	if fmt.Sprint(out[0].SampleSymbols) != fmt.Sprint(want) {
		t.Errorf("sampleSymbols = %v, want %v", out[0].SampleSymbols, want)
	}
}

func TestSurprising_CapAndSortOrder(t *testing.T) {
	// 25 bridge-only candidates, each in its own unique cluster pair so
	// every one scores exactly 2 (bridge). With every score tied, the
	// entire cap-20 result is ordered purely by `from` ASC.
	var modules []model.Module
	var edges []model.Edge
	clusterOf := make(map[string]string)
	for i := 0; i < 25; i++ {
		from := fmt.Sprintf("c%02d/from.ts", i)
		to := fmt.Sprintf("c%02d/to.ts", i)
		modules = append(modules, layerModule(from, model.LayerSupport), layerModule(to, model.LayerSupport))
		edges = append(edges, imp(from, to))
		clusterOf[from] = fmt.Sprintf("cluster:from%02d", i)
		clusterOf[to] = fmt.Sprintf("cluster:to%02d", i)
	}

	out := Surprising(modules, edges, nil, clusterOf, nil)
	if len(out) != SurprisingCap {
		t.Fatalf("len(out) = %d, want %d (cap)", len(out), SurprisingCap)
	}
	for i := 1; i < len(out); i++ {
		if out[i-1].Score < out[i].Score {
			t.Fatalf("out[%d].Score (%v) < out[%d].Score (%v): not sorted DESC", i-1, out[i-1].Score, i, out[i].Score)
		}
		if out[i-1].Score == out[i].Score && out[i-1].From > out[i].From {
			t.Fatalf("out[%d].From (%q) > out[%d].From (%q): not sorted ASC on tie", i-1, out[i-1].From, i, out[i].From)
		}
	}
}
