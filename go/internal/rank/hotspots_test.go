package rank

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// TestGodNodesFormula hand-verifies the exact formula
// inDeg*2 + outDeg + log2(1+loc), rounded via ToFixed2, using node's own
// `+((i*2+o+Math.log2(1+l)).toFixed(2))` as the oracle (values below were
// computed with that exact expression).
func TestGodNodesFormula(t *testing.T) {
	tests := []struct {
		name         string
		in, out, loc int
		wantScore    float64
		wantReason   string
	}{
		{"packages/ai/src/index.ts reference sample", 144, 0, 48, 293.61, "144 dependents · 0 deps"},
		{"a", 5, 2, 100, 18.66, "5 dependents · 2 deps"},
		{"b", 2, 5, 200, 16.65, "2 dependents · 5 deps"},
		{"c", 10, 0, 10, 23.46, "10 dependents · 0 deps"},
		{"zero everything", 0, 0, 0, 0, "0 dependents · 0 deps"},
	}
	modules := []model.Module{}
	degIn := map[string]int{}
	degOut := map[string]int{}
	for i, tt := range tests {
		id := tt.name
		modules = append(modules, model.Module{ID: id, Path: id, Loc: tt.loc})
		degIn[id] = tt.in
		degOut[id] = tt.out
		_ = i
	}
	d := Degrees{In: degIn, Out: degOut}

	got := Hotspots(modules, d)
	byID := map[string]model.GodNode{}
	for _, g := range got.GodNodes {
		byID[g.ID] = g
	}

	for _, tt := range tests {
		g, ok := byID[tt.name]
		if !ok {
			t.Fatalf("godNodes missing entry %q", tt.name)
		}
		if g.Score != tt.wantScore {
			t.Errorf("%s: score = %v, want %v", tt.name, g.Score, tt.wantScore)
		}
		if g.Reason != tt.wantReason {
			t.Errorf("%s: reason = %q, want %q", tt.name, g.Reason, tt.wantReason)
		}
	}
}

func TestMostDependedOnFormula(t *testing.T) {
	modules := []model.Module{{ID: "a", Path: "a"}, {ID: "b", Path: "b"}}
	d := Degrees{In: map[string]int{"a": 7, "b": 3}, Out: map[string]int{}}

	got := Hotspots(modules, d).MostDependedOn
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].ID != "a" || got[0].Score != 7 || got[0].Reason != "7 dependents" {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].ID != "b" || got[1].Score != 3 || got[1].Reason != "3 dependents" {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func TestOrchestratorsFormula(t *testing.T) {
	modules := []model.Module{{ID: "a", Path: "a"}, {ID: "b", Path: "b"}}
	d := Degrees{In: map[string]int{}, Out: map[string]int{"a": 4, "b": 9}}

	got := Hotspots(modules, d).Orchestrators
	if got[0].ID != "b" || got[0].Score != 9 || got[0].Reason != "imports 9 modules" {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].ID != "a" || got[1].Score != 4 || got[1].Reason != "imports 4 modules" {
		t.Errorf("got[1] = %+v", got[1])
	}
}

func TestLargestFormula(t *testing.T) {
	modules := []model.Module{{ID: "a", Path: "a", Loc: 300}, {ID: "b", Path: "b", Loc: 900}}
	d := Degrees{In: map[string]int{}, Out: map[string]int{}}

	got := Hotspots(modules, d).Largest
	if got[0].ID != "b" || got[0].Score != 900 || got[0].Reason != "900 LOC" {
		t.Errorf("got[0] = %+v", got[0])
	}
	if got[1].ID != "a" || got[1].Score != 300 || got[1].Reason != "300 LOC" {
		t.Errorf("got[1] = %+v", got[1])
	}
}

// TestListCapsAt15 builds 20 distinctly-scored non-test modules and asserts
// the ranker caps the output at HotspotCap (15), keeping the top-scoring
// ones.
func TestListCapsAt15(t *testing.T) {
	var modules []model.Module
	in := map[string]int{}
	for i := 0; i < 20; i++ {
		id := string(rune('a' + i))
		modules = append(modules, model.Module{ID: id, Path: id})
		in[id] = i // scores 0..19, all distinct
	}
	d := Degrees{In: in, Out: map[string]int{}}

	got := List(modules, d,
		func(inD, _, _ int) float64 { return float64(inD) },
		func(inD, _, _ int) string { return "" },
	)

	if len(got) != HotspotCap {
		t.Fatalf("len = %d, want %d", len(got), HotspotCap)
	}
	// Highest scores (19 down to 5) must survive; scores 0..4 must be cut.
	for i, g := range got {
		wantScore := float64(19 - i)
		if g.Score != wantScore {
			t.Errorf("got[%d].Score = %v, want %v", i, g.Score, wantScore)
		}
	}
}

// TestListExcludesTestModules asserts a test module is excluded from every
// ranked list even when it would otherwise dominate every metric.
func TestListExcludesTestModules(t *testing.T) {
	modules := []model.Module{
		{ID: "src/real.ts", Path: "src/real.ts", Loc: 10},
		{ID: "test/huge.test.ts", Path: "test/huge.test.ts", Loc: 999999, IsTest: true},
	}
	d := Degrees{
		In:  map[string]int{"test/huge.test.ts": 999},
		Out: map[string]int{"test/huge.test.ts": 999},
	}

	got := Hotspots(modules, d)
	for _, list := range [][]model.GodNode{got.GodNodes, got.MostDependedOn, got.Orchestrators, got.Largest} {
		for _, g := range list {
			if g.ID == "test/huge.test.ts" {
				t.Fatalf("test module leaked into hotspot list: %+v", g)
			}
		}
	}
	if len(got.Largest) != 1 || got.Largest[0].ID != "src/real.ts" {
		t.Errorf("Largest = %+v, want only src/real.ts", got.Largest)
	}
}

// TestListTieBreakByIDAscending asserts that when scores tie, the ranker
// breaks ties by id ascending (full 3-way comparator: score DESC, id ASC).
func TestListTieBreakByIDAscending(t *testing.T) {
	modules := []model.Module{
		{ID: "z.ts", Path: "z.ts"},
		{ID: "a.ts", Path: "a.ts"},
		{ID: "m.ts", Path: "m.ts"},
	}
	// All three tie at score 5.
	d := Degrees{In: map[string]int{"z.ts": 5, "a.ts": 5, "m.ts": 5}, Out: map[string]int{}}

	got := Hotspots(modules, d).MostDependedOn
	wantOrder := []string{"a.ts", "m.ts", "z.ts"}
	if len(got) != len(wantOrder) {
		t.Fatalf("len = %d, want %d", len(got), len(wantOrder))
	}
	for i, id := range wantOrder {
		if got[i].ID != id {
			t.Errorf("got[%d].ID = %q, want %q", i, got[i].ID, id)
		}
	}
}
