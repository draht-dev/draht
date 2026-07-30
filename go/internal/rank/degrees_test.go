package rank

import (
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestNonTestDegrees(t *testing.T) {
	modules := []model.Module{
		{ID: "src/a.ts", IsTest: false},
		{ID: "src/b.ts", IsTest: false},
		{ID: "src/c.ts", IsTest: false},
		{ID: "test/a.test.ts", IsTest: true},
	}
	edges := []model.Edge{
		{From: "src/a.ts", To: "src/b.ts", Kind: model.EdgeKindImport},
		{From: "src/a.ts", To: "src/c.ts", Kind: model.EdgeKindImport},
		// Duplicate a->b import: must count twice (no dedup).
		{From: "src/a.ts", To: "src/b.ts", Kind: model.EdgeKindImport},
		// re-export and external edges must be excluded entirely.
		{From: "src/b.ts", To: "src/c.ts", Kind: model.EdgeKindReExport},
		{From: "src/b.ts", To: "external-pkg", Kind: model.EdgeKindExternal},
		// Edge sourced from a TEST module must be excluded ("test-originated
		// edges only" — the module at the FROM end is a test).
		{From: "test/a.test.ts", To: "src/b.ts", Kind: model.EdgeKindImport},
	}

	got := NonTestDegrees(modules, edges)

	// src/a.ts fans out 3 times total: b (x2, duplicate kept), c (x1).
	wantOut := map[string]int{"src/a.ts": 3}
	wantIn := map[string]int{"src/b.ts": 2, "src/c.ts": 1}

	if !reflect.DeepEqual(got.Out, wantOut) {
		t.Errorf("Out = %v, want %v", got.Out, wantOut)
	}
	if !reflect.DeepEqual(got.In, wantIn) {
		t.Errorf("In = %v, want %v", got.In, wantIn)
	}
}

func TestNonTestDegreesEdgeFromUnknownModuleIsCounted(t *testing.T) {
	// The CJS guard is `if (fm && fm.isTest) continue;` — an edge whose
	// FROM id has no corresponding module entry is NOT skipped (fm is
	// undefined, so `fm && fm.isTest` is falsy).
	modules := []model.Module{{ID: "src/b.ts", IsTest: false}}
	edges := []model.Edge{
		{From: "src/unregistered.ts", To: "src/b.ts", Kind: model.EdgeKindImport},
	}

	got := NonTestDegrees(modules, edges)

	if got.Out["src/unregistered.ts"] != 1 {
		t.Errorf("Out[unregistered] = %d, want 1", got.Out["src/unregistered.ts"])
	}
	if got.In["src/b.ts"] != 1 {
		t.Errorf("In[src/b.ts] = %d, want 1", got.In["src/b.ts"])
	}
}
