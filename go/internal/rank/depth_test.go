package rank

import (
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestDepthsBFS(t *testing.T) {
	// entry -> mid (import) -> leaf (re-export); a parallel unreachable
	// island; and an external edge that must never contribute reachability.
	entryPoints := []model.EntryPointRef{{ID: "entry.ts", Kind: model.EntryKindCLI}}
	edges := []model.Edge{
		{From: "entry.ts", To: "mid.ts", Kind: model.EdgeKindImport},
		{From: "mid.ts", To: "leaf.ts", Kind: model.EdgeKindReExport},
		{From: "leaf.ts", To: "deeper.ts", Kind: model.EdgeKindImport},
		{From: "island-a.ts", To: "island-b.ts", Kind: model.EdgeKindImport},
		{From: "entry.ts", To: "external-pkg", Kind: model.EdgeKindExternal},
	}

	got := Depths(nil, edges, entryPoints)

	want := map[string]int{
		"entry.ts":  0,
		"mid.ts":    1,
		"leaf.ts":   2,
		"deeper.ts": 3,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Depths = %v, want %v", got, want)
	}
	if _, unreachable := got["island-a.ts"]; unreachable {
		t.Error("island-a.ts should be unreachable from entry.ts")
	}
	if _, unreachable := got["external-pkg"]; unreachable {
		t.Error("external-pkg should never be reachable (external edges excluded)")
	}
}

func TestDepthsShortestPathWinsOverMultipleRoutes(t *testing.T) {
	// entry -> a -> c (depth 2) AND entry -> b -> c -> ... ; c must land at
	// its SHORTEST distance regardless of adjacency-list / queue order.
	entryPoints := []model.EntryPointRef{{ID: "entry.ts"}}
	edges := []model.Edge{
		{From: "entry.ts", To: "a.ts", Kind: model.EdgeKindImport},
		{From: "a.ts", To: "c.ts", Kind: model.EdgeKindImport},
		{From: "entry.ts", To: "b.ts", Kind: model.EdgeKindImport},
		{From: "b.ts", To: "c.ts", Kind: model.EdgeKindImport}, // also depth 2 via b; same result
		{From: "c.ts", To: "d.ts", Kind: model.EdgeKindImport},
	}

	got := Depths(nil, edges, entryPoints)
	want := map[string]int{"entry.ts": 0, "a.ts": 1, "b.ts": 1, "c.ts": 2, "d.ts": 3}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Depths = %v, want %v", got, want)
	}
}

func TestDepthsMultipleEntryPointsAllSeedZero(t *testing.T) {
	entryPoints := []model.EntryPointRef{{ID: "e1.ts"}, {ID: "e2.ts"}}
	edges := []model.Edge{
		{From: "e1.ts", To: "shared.ts", Kind: model.EdgeKindImport},
		{From: "e2.ts", To: "shared.ts", Kind: model.EdgeKindImport},
	}
	got := Depths(nil, edges, entryPoints)
	want := map[string]int{"e1.ts": 0, "e2.ts": 0, "shared.ts": 1}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Depths = %v, want %v", got, want)
	}
}

func TestApplyDepths(t *testing.T) {
	modules := []model.Module{
		{ID: "a.ts"},
		{ID: "b.ts"},
		{ID: "c.ts"},
	}
	depths := map[string]int{"a.ts": 0, "b.ts": 2}

	ApplyDepths(modules, depths)

	if modules[0].Depth == nil || *modules[0].Depth != 0 {
		t.Errorf("modules[0].Depth = %v, want *0", modules[0].Depth)
	}
	if modules[1].Depth == nil || *modules[1].Depth != 2 {
		t.Errorf("modules[1].Depth = %v, want *2", modules[1].Depth)
	}
	if modules[2].Depth != nil {
		t.Errorf("modules[2].Depth = %v, want nil (unreachable -> null)", modules[2].Depth)
	}
}
