package symindex

import (
	"fmt"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func exportedModule(id string, inDegKey string, n int) model.Module {
	exports := make([]model.Export, n)
	for i := 0; i < n; i++ {
		exports[i] = model.Export{Name: fmt.Sprintf("Sym%d", i), Kind: "function", Line: i + 1}
	}
	return model.Module{ID: id, Path: id, Exports: exports}
}

func TestBuildSymbolIndex_RankedByInDegreeDescending(t *testing.T) {
	modules := []model.Module{
		exportedModule("low.ts", "", 1),
		exportedModule("high.ts", "", 1),
		exportedModule("mid.ts", "", 1),
	}
	inDeg := map[string]int{"low.ts": 1, "high.ts": 100, "mid.ts": 50}

	entries, truncated := BuildSymbolIndex(modules, inDeg)
	if truncated {
		t.Fatalf("unexpected truncation")
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 entries, got %d", len(entries))
	}
	want := []string{"high.ts", "mid.ts", "low.ts"}
	for i, w := range want {
		if entries[i].File != w {
			t.Errorf("entry %d: want file %q, got %q", i, w, entries[i].File)
		}
	}
}

func TestBuildSymbolIndex_TieBreaksOnPathAscending(t *testing.T) {
	// Equal in-degree (including the "not present in the map" == 0 case)
	// must fall back to path ASC, mirroring
	// `(a.path < b.path ? -1 : a.path > b.path ? 1 : 0)`.
	modules := []model.Module{
		exportedModule("z.ts", "", 1),
		exportedModule("a.ts", "", 1),
		exportedModule("m.ts", "", 1),
	}
	entries, _ := BuildSymbolIndex(modules, nil)
	want := []string{"a.ts", "m.ts", "z.ts"}
	for i, w := range want {
		if entries[i].File != w {
			t.Errorf("entry %d: want file %q, got %q", i, w, entries[i].File)
		}
	}
}

func TestBuildSymbolIndex_SkipsModulesWithNoExports(t *testing.T) {
	modules := []model.Module{
		{ID: "empty.ts", Path: "empty.ts", Exports: nil},
		exportedModule("has.ts", "", 2),
	}
	entries, truncated := BuildSymbolIndex(modules, map[string]int{"empty.ts": 999})
	if truncated {
		t.Fatalf("unexpected truncation")
	}
	if len(entries) != 2 {
		t.Fatalf("want 2 entries (only has.ts's exports), got %d: %+v", len(entries), entries)
	}
	for _, e := range entries {
		if e.File != "has.ts" {
			t.Errorf("unexpected entry from module with no declared exports: %+v", e)
		}
	}
}

func TestBuildSymbolIndex_EntryShapeAndExportedIsAlwaysTrue(t *testing.T) {
	pkg := "pkg-a"
	modules := []model.Module{
		{ID: "a.ts", Path: "a.ts", Package: &pkg, Exports: []model.Export{
			{Name: "Foo", Kind: "function", Line: 10},
		}},
	}
	entries, _ := BuildSymbolIndex(modules, nil)
	if len(entries) != 1 {
		t.Fatalf("want 1 entry, got %d", len(entries))
	}
	e := entries[0]
	if e.Name != "Foo" || e.Kind != "function" || e.Line != 10 || e.File != "a.ts" {
		t.Errorf("unexpected entry shape: %+v", e)
	}
	if e.Package == nil || *e.Package != pkg {
		t.Errorf("want package %q, got %v", pkg, e.Package)
	}
	if !e.Exported {
		t.Errorf("exported must always be literal true")
	}
}

// TestBuildSymbolIndex_TruncationKeepsMostDependedOnModules is the load-bearing
// truncation test: it builds enough modules to exceed SymbolIndexCap and
// verifies that (a) the cap and truncated flag are honoured, and (b) the
// surviving entries are exactly the ones from the highest in-degree modules
// — the CJS engine's documented truncation contract (agentHints, cjs:3008).
func TestBuildSymbolIndex_TruncationKeepsMostDependedOnModules(t *testing.T) {
	const perModule = 10
	const moduleCount = 520 // 520*10 = 5200 > SymbolIndexCap(5000)

	modules := make([]model.Module, moduleCount)
	inDeg := make(map[string]int, moduleCount)
	for i := 0; i < moduleCount; i++ {
		id := fmt.Sprintf("m%04d.ts", i)
		modules[i] = exportedModule(id, "", perModule)
		// Descending in-degree by construction index: m0000 has the highest
		// in-degree, m0519 the lowest.
		inDeg[id] = moduleCount - i
	}

	entries, truncated := BuildSymbolIndex(modules, inDeg)
	if !truncated {
		t.Fatalf("want symbolIndexTruncated=true when input exceeds the cap")
	}
	if len(entries) != SymbolIndexCap {
		t.Fatalf("want exactly %d entries, got %d", SymbolIndexCap, len(entries))
	}

	// The most-depended-on module's symbols must all survive.
	topFile := "m0000.ts"
	topCount := 0
	for _, e := range entries {
		if e.File == topFile {
			topCount++
		}
	}
	if topCount != perModule {
		t.Errorf("want all %d symbols of the highest in-degree module to survive, got %d", perModule, topCount)
	}

	// The least-depended-on module (last by construction, lowest in-degree)
	// must have been cut entirely.
	bottomFile := fmt.Sprintf("m%04d.ts", moduleCount-1)
	for _, e := range entries {
		if e.File == bottomFile {
			t.Fatalf("did not expect any symbols from the lowest in-degree module %q to survive truncation", bottomFile)
		}
	}

	// Exactly 5000/10 = 500 whole modules survive (the cap lands on a module
	// boundary by construction), i.e. modules m0000..m0499.
	survivors := map[string]int{}
	for _, e := range entries {
		survivors[e.File]++
	}
	if len(survivors) != 500 {
		t.Fatalf("want 500 surviving modules, got %d", len(survivors))
	}
	if _, ok := survivors["m0499.ts"]; !ok {
		t.Errorf("want m0499.ts (rank 500) to survive")
	}
	if _, ok := survivors["m0500.ts"]; ok {
		t.Errorf("did not want m0500.ts (rank 501) to survive")
	}
}

// TestBuildSymbolIndex_ExactCapNoTruncation replicates the CJS "quirk" noted
// in the spec: when the total available entries equal the cap exactly and
// the module list is exhausted at the same moment, truncated stays false
// because the cap check that would set it is never reached with more work
// pending.
func TestBuildSymbolIndex_ExactCapNoTruncation(t *testing.T) {
	const perModule = 10
	const moduleCount = SymbolIndexCap / perModule // exactly hits the cap

	modules := make([]model.Module, moduleCount)
	inDeg := make(map[string]int, moduleCount)
	for i := 0; i < moduleCount; i++ {
		id := fmt.Sprintf("m%04d.ts", i)
		modules[i] = exportedModule(id, "", perModule)
		inDeg[id] = moduleCount - i
	}

	entries, truncated := BuildSymbolIndex(modules, inDeg)
	if len(entries) != SymbolIndexCap {
		t.Fatalf("want exactly %d entries, got %d", SymbolIndexCap, len(entries))
	}
	if truncated {
		t.Errorf("want truncated=false when the input exactly fills the cap with no module left over")
	}
}

func TestBuildSymbolIndex_Determinism(t *testing.T) {
	modules := []model.Module{
		exportedModule("b.ts", "", 3),
		exportedModule("a.ts", "", 2),
		exportedModule("c.ts", "", 1),
	}
	inDeg := map[string]int{"a.ts": 5, "b.ts": 5, "c.ts": 1}

	first, firstTrunc := BuildSymbolIndex(modules, inDeg)

	// Feed the same logical input in a different slice order — the module
	// order coming out of graph.Modules should never affect the ranked
	// output.
	shuffled := []model.Module{modules[2], modules[0], modules[1]}
	second, secondTrunc := BuildSymbolIndex(shuffled, inDeg)

	if firstTrunc != secondTrunc {
		t.Fatalf("truncated flag differs across input orderings")
	}
	if len(first) != len(second) {
		t.Fatalf("entry count differs across input orderings: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("entry %d differs across input orderings: %+v vs %+v", i, first[i], second[i])
		}
	}
}
