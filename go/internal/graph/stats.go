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
	// Containers/Groups/CallEdges/ContainerEdges/EntryPoints/SinkModules are
	// the Phase-2 rollup counts (draht-tools.cjs:2205-2213): each is simply
	// len() of the correspondingly-named top-level array. Zero (the Go zero
	// value) when the caller has none — e.g. Assemble's own fixture-only
	// callers that never populate those fields.
	Containers     int
	Groups         int
	CallEdges      int
	ContainerEdges int
	EntryPoints    int
	SinkModules    int
}

// BuildStats rolls up per-module and per-language counts into model.Stats /
// model.Assets (draht-tools.cjs:2205-2213, 2885-2886, 2938-2960).
func BuildStats(in StatsInput) (model.Stats, model.Assets) {
	stats := model.Stats{
		Files:          len(in.Modules),
		Languages:      model.NewOrderedCounts(),
		Packages:       in.Packages,
		Edges:          in.EdgeCount,
		Layers:         model.NewOrderedCounts(),
		Truncated:      in.Truncated,
		Containers:     in.Containers,
		Groups:         in.Groups,
		CallEdges:      in.CallEdges,
		ContainerEdges: in.ContainerEdges,
		EntryPoints:    in.EntryPoints,
		SinkModules:    in.SinkModules,
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
