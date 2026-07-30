package graph

import (
	"encoding/json"
	"time"

	"github.com/draht-dev/draht/go/internal/cluster"
	"github.com/draht-dev/draht/go/internal/container"
	"github.com/draht-dev/draht/go/internal/flow"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/rank"
	"github.com/draht-dev/draht/go/internal/rawobj"
	"github.com/draht-dev/draht/go/internal/scan"
	"github.com/draht-dev/draht/go/internal/symindex"
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

	// CallEdges is the full symbol-level callEdges[] list, already built in
	// modules-order x usedLocals-insertion order (see
	// BuildCallEdgesAll) — Assemble does not construct it, since doing so
	// requires the per-file extract.Facts.CallSites cache payload that only
	// the pipeline stage has access to.
	CallEdges []model.CallEdge

	// RationaleEntries is every inline SECURITY/BUG/.../WHY marker hit
	// across every eligible scanned file (code AND non-code — markdown/
	// html/sql included), in file-scan (path ascending) order. Assemble
	// sorts/caps this into rationaleIndex; the caller must not pre-sort it.
	RationaleEntries []model.RationaleEntry

	// PkgHasBin reports whether the package at pkgPath (repo-relative) has a
	// truthy `bin` in its manifest (draht-tools.cjs:1193-1201), for
	// internal/container's group-derivation bin cue. Nil is treated as
	// "never has a bin" (internal/container guards nil callers).
	PkgHasBin func(pkgPath string) bool

	// GroupsJSON / FlowsJSON are the raw bytes of
	// .planning/codebase/{GROUPS,FLOWS}.json, or nil when the file does not
	// exist — the respective curation passes are then a no-op.
	GroupsJSON []byte
	FlowsJSON  []byte
}

// mapTimeFormat matches JS's `new Date().toISOString()`: RFC3339 with
// millisecond precision and a literal "Z" (draht-tools.cjs:2940).
const mapTimeFormat = "2006-01-02T15:04:05.000Z"

// Assemble builds the full *model.Map: stats/assets/packages/modules/edges,
// the hardcoded lanes/agentHints constants, and every one of the 13
// Phase-2 fields (groups, containers, boundedContexts, callEdges,
// containerEdges, entryPoints, sinks, flows, boxes, symbolIndex, clusters,
// surprisingConnections, rationaleIndex) plus modules[*].depth/cluster and
// the hotspots object.
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
	m.CallEdges = in.CallEdges

	// Shared, test-INCLUDED import-edge degree maps (container topFiles +
	// symbolIndex ranking both use this exact pair in the CJS source).
	inDeg, outDeg := ImportDegrees(in.Edges)

	// entryPoints / sinks / depth (rank.Depths must run AFTER eps is built;
	// entryPoints itself has no dependency on anything computed below).
	eps := rank.EntryPoints(in.Modules)
	m.EntryPoints = eps
	m.Sinks = rank.SinkModules(in.Modules)
	rank.ApplyDepths(in.Modules, rank.Depths(in.Modules, in.Edges, eps))

	// hotspots (non-test degree maps are hotspots-only; independent of
	// everything else in this function).
	m.Hotspots = rank.Hotspots(in.Modules, rank.NonTestDegrees(in.Modules, in.Edges))

	// clustering: must run before containerEdges' consumer (surprising)
	// but has no dependency on containers/groups itself.
	clResult := cluster.Compute(in.Modules, in.Edges)
	cluster.ApplyClusters(in.Modules, clResult.ClusterOf)
	modelClusters := make([]model.Cluster, len(clResult.Clusters))
	for i, c := range clResult.Clusters {
		modelClusters[i] = c.ToModel()
	}
	m.Clusters = modelClusters

	// containers / groups / containerEdges.
	cRes := container.Build(container.Input{
		Modules:    in.Modules,
		Edges:      in.Edges,
		CallEdges:  in.CallEdges,
		Packages:   in.Packages,
		InDeg:      inDeg,
		OutDeg:     outDeg,
		PkgHasBin:  in.PkgHasBin,
		GroupsJSON: in.GroupsJSON,
	})
	m.Containers = cRes.Containers
	m.BoundedContexts = cRes.Containers // same slice: the CJS `boundedContexts: containers` alias
	m.ContainerEdges = cRes.ContainerEdges
	m.Groups = rawObjectsToRawMessages(cRes.Groups)

	// surprisingConnections needs both clustering AND (curated) groups.
	m.SurprisingConnections = cluster.Surprising(
		in.Modules, in.Edges, in.CallEdges,
		clResult.ClusterOf, groupOfContainerFromGroups(m.Groups),
	)

	// symbolIndex.
	m.SymbolIndex, m.SymbolIndexTruncated = symindex.BuildSymbolIndex(in.Modules, inDeg)

	// rationaleIndex.
	m.RationaleIndex = symindex.BuildRationaleIndex(in.RationaleEntries)

	// flows / lanes / boxes (needs containers, entryPoints, callEdges).
	fRes := flow.Build(flow.Input{
		Modules:         in.Modules,
		EntryPoints:     eps,
		CallEdges:       in.CallEdges,
		Containers:      cRes.Containers,
		Adjacency:       Adjacency(in.Edges),
		ReExportTargets: ReExportTargets(in.Edges),
		FlowsJSON:       in.FlowsJSON,
	})
	m.Flows = fRes.Flows
	m.Lanes = fRes.Lanes
	m.Boxes = boxesToRawMessages(fRes.Boxes)

	stats, assets := BuildStats(StatsInput{
		Modules:        in.Modules,
		EdgeCount:      len(in.Edges),
		Packages:       len(in.Packages),
		LangCounts:     in.LangCounts,
		Truncated:      in.Truncated,
		Containers:     len(m.Containers),
		Groups:         len(m.Groups),
		CallEdges:      len(m.CallEdges),
		ContainerEdges: len(m.ContainerEdges),
		EntryPoints:    len(m.EntryPoints),
		SinkModules:    len(m.Sinks),
	})
	m.Stats = stats
	m.Assets = assets

	return m
}

// rawObjectsToRawMessages marshals an ordered list of container.RawObject
// into []json.RawMessage for model.Map.Groups, preserving each object's key
// order. Always returns a non-nil slice (never null in the emitted JSON —
// design §R5).
func rawObjectsToRawMessages(objs []*container.RawObject) []json.RawMessage {
	out := make([]json.RawMessage, len(objs))
	for i, o := range objs {
		b, err := o.MarshalJSON()
		if err != nil {
			b = []byte("{}")
		}
		out[i] = b
	}
	return out
}

// boxesToRawMessages marshals flow.Box (whose own MarshalJSON emits the 3
// CJS box shapes, HTML-escaping disabled) into []json.RawMessage for
// model.Map.Boxes. Always returns a non-nil slice.
//
// This uses rawobj.MarshalNoEscape, NOT the package-level json.Marshal:
// flow.Box.MarshalJSON already builds its own bytes with HTML escaping
// disabled, but the package-level json.Marshal used here previously would
// still run its own (escaping-enabled) compact() pass over those bytes on
// the way out, silently re-escaping <, >, & that flow.Box's MarshalJSON had
// deliberately left literal.
func boxesToRawMessages(boxes []flow.Box) []json.RawMessage {
	out := make([]json.RawMessage, len(boxes))
	for i, b := range boxes {
		raw, err := rawobj.MarshalNoEscape(b)
		if err != nil {
			raw = []byte("{}")
		}
		out[i] = raw
	}
	return out
}

// groupOfContainerFromGroups maps a container id ("pkg:NAME" / "dir:X") to
// its group id, decoded from the already-curated groups[] raw objects
// (draht-tools.cjs:2930-2931 builds this from groups[*].members after
// curation, not from the pre-curation auto groups — see internal/cluster's
// Surprising, which consumes exactly this map).
func groupOfContainerFromGroups(groups []json.RawMessage) map[string]string {
	out := make(map[string]string)
	for _, raw := range groups {
		var g struct {
			ID      string   `json:"id"`
			Members []string `json:"members"`
		}
		if err := json.Unmarshal(raw, &g); err != nil {
			continue
		}
		for _, id := range g.Members {
			out[id] = g.ID
		}
	}
	return out
}
