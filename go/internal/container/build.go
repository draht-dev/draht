package container

import "github.com/draht-dev/draht/go/internal/model"

// Input bundles everything Build needs. Every slice MUST already be in its
// final deterministic order (matching the rest of the pipeline's
// determinism inventory) — Build never sorts Modules, Edges, CallEdges, or
// Packages itself.
type Input struct {
	Modules   []model.Module
	Edges     []model.Edge
	CallEdges []model.CallEdge
	Packages  []model.Package

	// InDeg/OutDeg are the import-edge degree maps (test edges INCLUDED —
	// draht-tools.cjs:2364-2371), used by ComputeTopFiles. The caller
	// computes these (they are edge-derived and shared with other Phase 2
	// work packages).
	InDeg  map[string]int
	OutDeg map[string]int

	// PkgHasBin reports whether the package at pkgPath (repo-relative) has
	// a truthy `bin` in its manifest (draht-tools.cjs:1193-1201). Injected
	// so this package performs no file I/O.
	PkgHasBin func(pkgPath string) bool

	// GroupsJSON is the raw bytes of .planning/codebase/GROUPS.json, or nil
	// when the file does not exist.
	GroupsJSON []byte
}

// Result is Build's output. Containers is also what the caller should wire
// into Map.BoundedContexts (the CJS `boundedContexts: containers` alias is
// literally the same array — assign the SAME slice on both fields, do not
// copy it).
type Result struct {
	Containers     []model.Container
	Groups         []*RawObject
	ContainerEdges []model.ContainerEdge
}

// Build runs the full container/group/containerEdge derivation in the same
// order the CJS engine does: containers -> topFiles -> groups (mutates
// Containers[i].GroupID) -> GROUPS.json curation -> containerEdges.
func Build(in Input) Result {
	containers := BuildContainers(in.Modules, in.Packages)
	for i := range containers {
		containers[i].TopFiles = ComputeTopFiles(containers[i], in.Modules, in.InDeg, in.OutDeg)
	}

	groups := DeriveGroups(containers, in.Packages, in.PkgHasBin)
	curated := ApplyGroupsCuration(groups, in.GroupsJSON)

	containerEdges := BuildContainerEdges(in.Edges, in.CallEdges, in.Modules, in.Packages)

	return Result{
		Containers:     containers,
		Groups:         curated,
		ContainerEdges: containerEdges,
	}
}
