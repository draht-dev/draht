package cluster

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestBuildAdjacency(t *testing.T) {
	modules := []model.Module{
		{ID: "a.ts", Path: "a.ts"},
		{ID: "b.ts", Path: "b.ts"},
		{ID: "c.ts", Path: "c.ts"},
	}
	edges := []model.Edge{
		{From: "a.ts", To: "b.ts", Kind: model.EdgeKindImport},
		{From: "a.ts", To: "b.ts", Kind: model.EdgeKindImport},       // duplicate, must collapse
		{From: "a.ts", To: "a.ts", Kind: model.EdgeKindImport},       // self-loop, must drop
		{From: "b.ts", To: "missing.ts", Kind: model.EdgeKindImport}, // unknown endpoint
		{From: "a.ts", To: "c.ts", Kind: model.EdgeKindReExport},     // wrong kind, excluded
	}

	adj := BuildAdjacency(modules, edges)

	if got := len(adj["a.ts"]); got != 1 {
		t.Fatalf("a.ts degree = %d, want 1", got)
	}
	if _, ok := adj["a.ts"]["b.ts"]; !ok {
		t.Errorf("a.ts should link to b.ts")
	}
	if got := len(adj["b.ts"]); got != 1 {
		t.Fatalf("b.ts degree = %d, want 1 (undirected back-link only)", got)
	}
	if _, present := adj["c.ts"]; present {
		t.Errorf("c.ts should have no adjacency entry (re-export excluded, no import edges)")
	}
}

func TestHubSet_BarrelAlwaysHub(t *testing.T) {
	ids := []string{"a/index.ts", "b/mod.ts"}
	adj := Adjacency{} // no edges, degree 0 everywhere
	hubs, threshold := HubSet(ids, adj)

	if threshold != 0 {
		t.Errorf("threshold = %d, want 0", threshold)
	}
	if _, ok := hubs["a/index.ts"]; !ok {
		t.Errorf("a/index.ts should be a hub via barrel regex")
	}
	if _, ok := hubs["b/mod.ts"]; ok {
		t.Errorf("b/mod.ts should not be a hub (degree 0, not a barrel file)")
	}
}

func TestHubSet_DegreeThreshold(t *testing.T) {
	// 21 modules so pIdx = floor(0.95*21) = 19 < 20 (last index), giving
	// room for a degree-based hub above the percentile line.
	ids := make([]string, 21)
	adj := Adjacency{}
	for i := 0; i < 21; i++ {
		ids[i] = fmtID(i)
	}
	// Give the last module (by sorted id) a much higher degree than the
	// rest by fabricating neighbour sets directly.
	for i := 0; i < 20; i++ {
		adj[ids[i]] = map[string]struct{}{"x": {}}
	}
	adj[ids[20]] = map[string]struct{}{}
	for i := 0; i < 20; i++ {
		adj[ids[20]][ids[i]] = struct{}{}
	}

	hubs, threshold := HubSet(ids, adj)
	if _, ok := hubs[ids[20]]; !ok {
		t.Errorf("high-degree module should be a hub (degree 20 > threshold %d)", threshold)
	}
}

func fmtID(i int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	return string(letters[i%26]) + ".ts"
}

func TestBarrelRe(t *testing.T) {
	cases := map[string]bool{
		"index.ts":        true,
		"index.tsx":       true,
		"index.js":        true,
		"index.mjs":       true,
		"index.cjs":       true,
		"a/b/index.ts":    true,
		"index.py":        false,
		"myindex.ts":      false,
		"a/b/notindex.ts": false,
		"a/index.ts/f.ts": false,
	}
	for id, want := range cases {
		if got := BarrelRe.MatchString(id); got != want {
			t.Errorf("BarrelRe.MatchString(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestContainerOf(t *testing.T) {
	pkg := "scope/pkg"
	cases := []struct {
		name string
		m    model.Module
		want string
	}{
		{"with package", model.Module{Path: "a/b.ts", Package: &pkg}, "pkg:scope/pkg"},
		{"no package, nested", model.Module{Path: "a/b/c.ts"}, "dir:a"},
		{"no package, root-level", model.Module{Path: "root.ts"}, "dir:root.ts"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ContainerOf(&tc.m); got != tc.want {
				t.Errorf("ContainerOf() = %q, want %q", got, tc.want)
			}
		})
	}
}
