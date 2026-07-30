package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

func TestBuildStatsBasicRollup(t *testing.T) {
	modules := []model.Module{
		{ID: "a.ts", Path: "a.ts", Loc: 100, Layer: model.LayerApplication},
		{ID: "b.ts", Path: "b.ts", Loc: 50, Layer: model.LayerApplication},
		{ID: "c.ts", Path: "c.ts", Loc: 25, Layer: model.LayerSupport},
	}
	langCounts := []scan.LangCount{
		{Lang: scan.LangTypeScript, Count: 3},
		{Lang: scan.Lang("markdown"), Count: 2},
		{Lang: scan.LangOther, Count: 1},
	}
	stats, assets := BuildStats(StatsInput{
		Modules:    modules,
		EdgeCount:  5,
		Packages:   2,
		LangCounts: langCounts,
		Truncated:  false,
	})

	if stats.Files != 3 {
		t.Errorf("Files = %d, want 3", stats.Files)
	}
	if stats.TotalLoc != 175 {
		t.Errorf("TotalLoc = %d, want 175", stats.TotalLoc)
	}
	if stats.Edges != 5 {
		t.Errorf("Edges = %d, want 5", stats.Edges)
	}
	if stats.Packages != 2 {
		t.Errorf("Packages = %d, want 2", stats.Packages)
	}
	if stats.Truncated {
		t.Error("Truncated = true, want false")
	}
	if got := stats.Languages.Get(string(scan.LangTypeScript)); got != 3 {
		t.Errorf("Languages[typescript] = %d, want 3", got)
	}
	if got := stats.Languages.Get(string(scan.Lang("markdown"))); got != 2 {
		t.Errorf("Languages[markdown] = %d, want 2", got)
	}
	if got := stats.Layers.Get(model.LayerApplication); got != 2 {
		t.Errorf("Layers[application] = %d, want 2", got)
	}
	if got := stats.Layers.Get(model.LayerSupport); got != 1 {
		t.Errorf("Layers[support] = %d, want 1", got)
	}

	// assets rolls up NON-code languages only.
	if assets.Total != 3 {
		t.Errorf("assets.Total = %d, want 3 (2 markdown + 1 other)", assets.Total)
	}
	if got := assets.ByLanguage.Get(string(scan.Lang("markdown"))); got != 2 {
		t.Errorf("assets.ByLanguage[markdown] = %d, want 2", got)
	}
	if got := assets.ByLanguage.Get(string(scan.LangOther)); got != 1 {
		t.Errorf("assets.ByLanguage[other] = %d, want 1", got)
	}
	if _, present := assetsHasKey(assets, string(scan.LangTypeScript)); present {
		t.Error("assets.ByLanguage must not include a code language")
	}
}

func assetsHasKey(a model.Assets, key string) (int, bool) {
	for _, k := range a.ByLanguage.Keys() {
		if k == key {
			return a.ByLanguage.Get(k), true
		}
	}
	return 0, false
}

func TestBuildStatsPhase1ZerosStayZero(t *testing.T) {
	stats, _ := BuildStats(StatsInput{})
	if stats.Containers != 0 || stats.Groups != 0 || stats.CallEdges != 0 ||
		stats.ContainerEdges != 0 || stats.EntryPoints != 0 || stats.SinkModules != 0 {
		t.Errorf("expected all Phase-1-deferred counters to be 0, got %+v", stats)
	}
}

func TestBuildStatsLanguagesPreservesFirstEncounterOrder(t *testing.T) {
	// A non-alphabetical order must survive (design §R4): "other" before
	// "markdown" before "json".
	langCounts := []scan.LangCount{
		{Lang: scan.LangOther, Count: 1},
		{Lang: scan.Lang("markdown"), Count: 1},
		{Lang: scan.Lang("json"), Count: 1},
	}
	stats, _ := BuildStats(StatsInput{LangCounts: langCounts})
	keys := stats.Languages.Keys()
	want := []string{"other", "markdown", "json"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Errorf("keys[%d] = %q, want %q (must NOT be sorted)", i, keys[i], want[i])
		}
	}
}

func TestBuildStatsEmptyInputNeverNil(t *testing.T) {
	stats, assets := BuildStats(StatsInput{})
	if stats.Languages == nil || stats.Layers == nil || assets.ByLanguage == nil {
		t.Fatal("BuildStats must never leave an OrderedCounts field nil")
	}
}
