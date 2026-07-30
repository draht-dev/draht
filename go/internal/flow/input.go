package flow

import (
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/model"
)

// Input is everything Build/BuildFlows/BuildBoxes needs. Every field is a
// plain value the caller (the assembler) is responsible for computing — this
// package performs no resolution of its own.
type Input struct {
	// Modules is the full module list, in the canonical id-ascending order
	// the rest of the pipeline already guarantees.
	Modules []model.Module
	// EntryPoints is graph.EntryPoints(Modules) (already modules-order).
	EntryPoints []model.EntryPointRef
	// CallEdges is the full callEdges list, in modules-order ×
	// usedLocals-insertion-order (draht-tools.cjs's callEdges construction
	// order). BuildFlows groups these by From while preserving this order.
	CallEdges []model.CallEdge
	// Containers is the containers list (packages/directories), in its own
	// canonical (unsorted, discovery) order.
	Containers []model.Container
	// Adjacency is the import+re-export reachability adjacency
	// (module id -> []module id, edges order, duplicates preserved) —
	// graph.Adjacency(edges) in the design's terms.
	Adjacency map[string][]string
	// ReExportTargets holds, per module id, the RESOLVED re-export target
	// ids in parsedImports order with self-targets removed
	// (draht-tools.cjs:2559-2571).
	ReExportTargets map[string][]string
	// FlowsJSON is the raw bytes of .planning/codebase/FLOWS.json, or nil
	// when the file does not exist.
	FlowsJSON []byte
}

// Result is the full flow-graph output: flows (post FLOWS.json curation, as
// ordered raw JSON objects so unknown user keys survive), the 6 fixed lanes,
// and the boxes swim-lane viewers position on those lanes.
type Result struct {
	Flows []json.RawMessage
	Lanes []model.Lane
	Boxes []Box
}

// Build runs the full flow pipeline: BuildFlows, then ApplyFlowsCuration,
// then BuildBoxes (which reads the curated flows' sinkKind steps to
// determine which sink boxes exist). Pure; deterministic for identical
// input.
func Build(in Input) Result {
	flows := BuildFlows(in)
	curated := ApplyFlowsCuration(flows, in.FlowsJSON)
	boxes := BuildBoxes(in.Containers, in.Modules, curated)
	return Result{
		Flows: curated,
		Lanes: model.DefaultLanes(),
		Boxes: boxes,
	}
}
