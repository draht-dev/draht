package rank

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestEntryPointsProjection(t *testing.T) {
	pkg := model.Str("@draht/tools")
	modules := []model.Module{
		{ID: "a.ts", Path: "a.ts", Package: pkg}, // no entry point: excluded
		{ID: "b.ts", Path: "b.ts", Package: pkg,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "draht-tools"}},
		{ID: "c.ts", Path: "c.ts", Package: pkg,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindHTTP, Routes: []model.Route{{Method: "GET", Path: "/x"}}}},
		{ID: "d.ts", Path: "d.ts", Package: pkg,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindLibrary, Name: "d"}},
	}

	got := EntryPoints(modules)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 (module a.ts has no entryPoint)", len(got))
	}

	// b.ts: cli entry -> Name set, Routes literal null (nil slice).
	if got[0].ID != "b.ts" || got[0].Kind != model.EntryKindCLI {
		t.Fatalf("got[0] = %+v", got[0])
	}
	if got[0].Name == nil || *got[0].Name != "draht-tools" {
		t.Errorf("got[0].Name = %v, want \"draht-tools\"", got[0].Name)
	}
	if got[0].Routes != nil {
		t.Errorf("got[0].Routes = %v, want nil (JSON null)", got[0].Routes)
	}

	// c.ts: http entry -> Name literal null, Routes populated.
	if got[1].ID != "c.ts" || got[1].Kind != model.EntryKindHTTP {
		t.Fatalf("got[1] = %+v", got[1])
	}
	if got[1].Name != nil {
		t.Errorf("got[1].Name = %v, want nil (JSON null)", got[1].Name)
	}
	if len(got[1].Routes) != 1 || got[1].Routes[0].Path != "/x" {
		t.Errorf("got[1].Routes = %v", got[1].Routes)
	}

	// d.ts: library entry -> Name set, Routes literal null.
	if got[2].ID != "d.ts" || got[2].Kind != model.EntryKindLibrary {
		t.Fatalf("got[2] = %+v", got[2])
	}
	if got[2].Name == nil || *got[2].Name != "d" {
		t.Errorf("got[2].Name = %v, want \"d\"", got[2].Name)
	}
	if got[2].Routes != nil {
		t.Errorf("got[2].Routes = %v, want nil (JSON null)", got[2].Routes)
	}
}

func TestEntryPointsOrderMatchesModulesOrderNoSort(t *testing.T) {
	// entryPoints has no cap and no sort: it inherits modules' order
	// verbatim, even if that order were NOT id-ascending (the caller's
	// responsibility, not this function's).
	modules := []model.Module{
		{ID: "z.ts", Path: "z.ts", EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "z"}},
		{ID: "a.ts", Path: "a.ts", EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "a"}},
	}
	got := EntryPoints(modules)
	if len(got) != 2 || got[0].ID != "z.ts" || got[1].ID != "a.ts" {
		t.Errorf("got = %+v, want modules order [z.ts, a.ts] preserved", got)
	}
}

func TestSinkModulesProjection(t *testing.T) {
	pkg := model.Str("@draht/tools")
	modules := []model.Module{
		{ID: "a.ts", Path: "a.ts", Package: pkg, Sinks: nil},
		{ID: "b.ts", Path: "b.ts", Package: pkg, Sinks: []string{}},
		{ID: "c.ts", Path: "c.ts", Package: pkg, Sinks: []string{model.SinkFSWrite, model.SinkNetFetch}},
	}

	got := SinkModules(modules)
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1 (only c.ts has sinks)", len(got))
	}
	if got[0].ID != "c.ts" {
		t.Errorf("got[0].ID = %q, want c.ts", got[0].ID)
	}
	if len(got[0].Sinks) != 2 || got[0].Sinks[0] != model.SinkFSWrite || got[0].Sinks[1] != model.SinkNetFetch {
		t.Errorf("got[0].Sinks = %v", got[0].Sinks)
	}
}
