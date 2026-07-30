package graph

import (
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

// StatsInput bundles what BuildStats needs. LangCounts MUST already be in
// first-encounter order over the sorted file list (matching
// scan.Result.LangCounts — never a re-sorted or map-derived order, per the
// design's determinism inventory).
type StatsInput struct {
	// Modules is every code module in the graph (already sorted by path).
	Modules []model.Module
	// EdgeCount is len(edges) — duplicates included (design D6).
	EdgeCount int
	// Packages is len(packages[]).
	Packages int
	// LangCounts covers EVERY scanned file (code and non-code), in
	// first-encounter order.
	LangCounts []scan.LangCount
	// Truncated mirrors the walk's file-cap flag.
	Truncated bool
}

// BuildStats rolls up per-module and per-language counts into model.Stats /
// model.Assets (draht-tools.cjs:2205-2213, 2885-2886, 2938-2960). Phase 1
// zeros (design D3): Containers, Groups, CallEdges, ContainerEdges,
// EntryPoints, SinkModules are left at their Go zero value (0) — those
// top-level rollups are Phase-2 deferred.
func BuildStats(in StatsInput) (model.Stats, model.Assets) {
	stats := model.Stats{
		Files:     len(in.Modules),
		Languages: model.NewOrderedCounts(),
		Packages:  in.Packages,
		Edges:     in.EdgeCount,
		Layers:    model.NewOrderedCounts(),
		Truncated: in.Truncated,
	}
	assets := model.Assets{ByLanguage: model.NewOrderedCounts()}

	for _, lc := range in.LangCounts {
		stats.Languages.Add(string(lc.Lang), lc.Count)
		if !scan.IsCodeLang(lc.Lang) {
			assets.ByLanguage.Add(string(lc.Lang), lc.Count)
			assets.Total += lc.Count
		}
	}

	for _, m := range in.Modules {
		stats.TotalLoc += m.Loc
		stats.Layers.Inc(m.Layer)
	}

	return stats, assets
}
