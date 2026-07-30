package graph

import (
	"time"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

// AssembleInput bundles everything the assemble stage needs. Every slice
// MUST already be in its final deterministic order (see design's
// determinism inventory) — Assemble computes derived rollups only, it never
// sorts modules, edges, or packages itself.
type AssembleInput struct {
	Root       string
	Modules    []model.Module
	Edges      []model.Edge
	Packages   []model.Package
	LangCounts []scan.LangCount
	Truncated  bool
	// Now overrides time.Now for GeneratedAt, for deterministic tests. Nil
	// uses time.Now().
	Now func() time.Time
}

// mapTimeFormat matches JS's `new Date().toISOString()`: RFC3339 with
// millisecond precision and a literal "Z" (draht-tools.cjs:2940).
const mapTimeFormat = "2006-01-02T15:04:05.000Z"

// Assemble builds the full *model.Map for Phase 1 (design §8 PHASE 1
// scope): real stats/assets/packages/modules/edges, the hardcoded
// lanes/agentHints constants, and the 13 Phase-1-deferred arrays as empty
// placeholders (via model.NewMap — see design §R5).
//
// Deterministic: for identical AssembleInput values (and, for a byte-exact
// comparison, an identical Now), Assemble produces a *model.Map that
// serializes to byte-identical output via model.WriteMapJSON.
func Assemble(in AssembleInput) *model.Map {
	m := model.NewMap()
	m.Root = in.Root

	now := in.Now
	if now == nil {
		now = time.Now
	}
	m.GeneratedAt = now().UTC().Format(mapTimeFormat)

	m.Packages = in.Packages
	m.Modules = in.Modules
	m.Edges = in.Edges

	stats, assets := BuildStats(StatsInput{
		Modules:    in.Modules,
		EdgeCount:  len(in.Edges),
		Packages:   len(in.Packages),
		LangCounts: in.LangCounts,
		Truncated:  in.Truncated,
	})
	m.Stats = stats
	m.Assets = assets

	return m
}
