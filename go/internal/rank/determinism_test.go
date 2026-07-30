package rank

import (
	"encoding/json"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// fixtureModulesAndEdges builds a repeatable, non-trivial fixture (varied
// in/out degree, some test files, some entry points, some sinks) shared by
// TestDeterminism* below. Each call constructs fresh slices/maps so a test
// cannot accidentally observe shared mutable state between "runs".
func fixtureModulesAndEdges() ([]model.Module, []model.Edge) {
	pkg := model.Str("@draht/example")
	modules := []model.Module{
		{ID: "src/cli.ts", Path: "src/cli.ts", Package: pkg, Loc: 40,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "example"}},
		{ID: "src/http.ts", Path: "src/http.ts", Package: pkg, Loc: 55,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindHTTP, Routes: []model.Route{{Method: "GET", Path: "/health"}}}},
		{ID: "src/lib.ts", Path: "src/lib.ts", Package: pkg, Loc: 12,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindLibrary, Name: "lib"}},
		{ID: "src/core.ts", Path: "src/core.ts", Package: pkg, Loc: 220, Sinks: []string{model.SinkFSWrite}},
		{ID: "src/util.ts", Path: "src/util.ts", Package: pkg, Loc: 30},
		{ID: "src/models.ts", Path: "src/models.ts", Package: pkg, Loc: 90, Sinks: []string{model.SinkDBSQL, model.SinkNetFetch}},
		{ID: "test/core.test.ts", Path: "test/core.test.ts", Package: pkg, Loc: 500, IsTest: true},
	}
	edges := []model.Edge{
		{From: "src/cli.ts", To: "src/core.ts", Kind: model.EdgeKindImport},
		{From: "src/http.ts", To: "src/core.ts", Kind: model.EdgeKindImport},
		{From: "src/lib.ts", To: "src/util.ts", Kind: model.EdgeKindImport},
		{From: "src/core.ts", To: "src/util.ts", Kind: model.EdgeKindImport},
		{From: "src/core.ts", To: "src/models.ts", Kind: model.EdgeKindReExport},
		{From: "src/models.ts", To: "src/util.ts", Kind: model.EdgeKindImport},
		{From: "test/core.test.ts", To: "src/core.ts", Kind: model.EdgeKindImport},
		{From: "src/util.ts", To: "left-pad", Kind: model.EdgeKindExternal},
	}
	return modules, edges
}

// runOnce computes everything this package owns for one "assemble pass" and
// serializes it to JSON, mirroring how the integrator will call these
// functions in sequence (EntryPoints -> Depths -> ApplyDepths -> Hotspots).
func runOnce(t *testing.T) []byte {
	t.Helper()
	modules, edges := fixtureModulesAndEdges()

	eps := EntryPoints(modules)
	sinks := SinkModules(modules)
	depths := Depths(modules, edges, eps)
	ApplyDepths(modules, depths)
	hs := Hotspots(modules, NonTestDegrees(modules, edges))

	out := struct {
		Modules     []model.Module        `json:"modules"`
		EntryPoints []model.EntryPointRef `json:"entryPoints"`
		Sinks       []model.SinkModule    `json:"sinks"`
		Hotspots    model.Hotspots        `json:"hotspots"`
	}{modules, eps, sinks, hs}

	b, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

// TestDeterminismManyRuns computes the full rank output 20 times from
// independently-constructed fixture input and asserts every run byte-
// matches the first. This is this package's substitute for a race
// detector run (CGO_ENABLED=0 on this machine makes -race unavailable):
// it specifically targets the class of bug a stray Go map iteration would
// introduce (Degrees.In/Out lookups, the BFS adjacency map, the depth
// map) since map iteration order is randomized per-process in Go and would
// show up as a flake across repeated runs, not necessarily on run 1 vs 2.
func TestDeterminismManyRuns(t *testing.T) {
	const runs = 20
	var first []byte
	for i := 0; i < runs; i++ {
		got := runOnce(t)
		if i == 0 {
			first = got
			continue
		}
		if string(first) != string(got) {
			t.Fatalf("run %d diverged from run 0:\nrun0: %s\nrun%d: %s", i, first, i, got)
		}
	}
}
