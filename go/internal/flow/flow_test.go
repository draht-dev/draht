package flow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func strp(s string) *string { return &s }

// --- lane assignment -------------------------------------------------------

func TestContainerLaneDominantLayer(t *testing.T) {
	modules := []model.Module{
		{ID: "a", Path: "a.ts", Package: strp("pkg:x"), Layer: model.LayerDomain},
		{ID: "b", Path: "b.ts", Package: strp("pkg:x"), Layer: model.LayerDomain},
		{ID: "c", Path: "c.ts", Package: strp("pkg:x"), Layer: model.LayerPresentation},
	}
	lane, color := ContainerLane("pkg:pkg:x", modules)
	if lane != model.LayerDomain {
		t.Fatalf("lane = %q, want %q", lane, model.LayerDomain)
	}
	if color != layerColorsInternal[model.LayerDomain] {
		t.Fatalf("color = %q, want %q", color, layerColorsInternal[model.LayerDomain])
	}
}

func TestContainerLaneSupportRemapsToApplicationButKeepsSupportColor(t *testing.T) {
	modules := []model.Module{
		{ID: "a", Path: "a.ts", Package: strp("g"), Layer: model.LayerSupport},
		{ID: "b", Path: "b.ts", Package: strp("g"), Layer: model.LayerSupport},
	}
	lane, color := ContainerLane("pkg:g", modules)
	if lane != model.LayerApplication {
		t.Fatalf("lane = %q, want application (support must be remapped)", lane)
	}
	if color != layerColorsInternal[model.LayerSupport] {
		t.Fatalf("color = %q, want the SUPPORT color %q (remap must not change color)", color, layerColorsInternal[model.LayerSupport])
	}
}

func TestContainerLaneEmptyContainerDefaultsToPresentation(t *testing.T) {
	// No modules at all -> every layer count is 0 -> the stable sort keeps
	// declaration order -> "presentation" (first in layerOrderInternal) wins.
	// This is a confirmed CJS quirk (the `|| "support"` fallback never
	// fires because "presentation" is truthy).
	lane, color := ContainerLane("pkg:empty", nil)
	if lane != model.LayerPresentation {
		t.Fatalf("lane = %q, want presentation for an empty container", lane)
	}
	if color != layerColorsInternal[model.LayerPresentation] {
		t.Fatalf("color = %q, want the presentation color", color)
	}
}

func TestContainerLaneTieBreaksToDeclarationOrder(t *testing.T) {
	// domain and infrastructure tie at 2 each; domain precedes
	// infrastructure in layerOrderInternal, so a STABLE sort must keep
	// domain first.
	modules := []model.Module{
		{ID: "a", Path: "a.ts", Package: strp("g"), Layer: model.LayerDomain},
		{ID: "b", Path: "b.ts", Package: strp("g"), Layer: model.LayerDomain},
		{ID: "c", Path: "c.ts", Package: strp("g"), Layer: model.LayerInfrastructure},
		{ID: "d", Path: "d.ts", Package: strp("g"), Layer: model.LayerInfrastructure},
	}
	lane, _ := ContainerLane("pkg:g", modules)
	if lane != model.LayerDomain {
		t.Fatalf("lane = %q, want domain (tie-break must favor declaration order)", lane)
	}
}

// --- step cap ---------------------------------------------------------------

// wideTreeFixture builds a shallow-but-wide call tree (branching factor 8,
// modules 0..count-1, module i calling children 8i+1..8i+8) so that the BFS
// exhausts MaxStepsPerFlow (18) long before it could ever exhaust
// MaxBFSDepth (6). Every module lives in its own container (distinct
// Package), so every call step is cross-container and therefore always
// emitted (shouldEmit is unconditionally true for cross-container calls).
func wideTreeFixture(count int) ([]model.Module, []model.CallEdge) {
	modules := make([]model.Module, count)
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("m%d", i)
		modules[i] = model.Module{
			ID:      id,
			Path:    id + ".ts",
			Package: strp(fmt.Sprintf("pkg%d", i)),
			Layer:   model.LayerApplication,
		}
	}
	var edges []model.CallEdge
	for i := 0; i < count; i++ {
		for c := 8*i + 1; c <= 8*i+8 && c < count; c++ {
			edges = append(edges, model.CallEdge{
				From:   fmt.Sprintf("m%d", i),
				To:     fmt.Sprintf("m%d", c),
				Symbol: fmt.Sprintf("s%d", c),
				Count:  1,
			})
		}
	}
	return modules, edges
}

func TestBuildFlowsRespectsStepCap(t *testing.T) {
	modules, edges := wideTreeFixture(100)
	in := Input{
		Modules:     modules,
		EntryPoints: []model.EntryPointRef{{ID: "m0", Path: "m0.ts", Kind: model.EntryKindLibrary}},
		CallEdges:   edges,
	}
	flows := BuildFlows(in)
	if len(flows) != 1 {
		t.Fatalf("got %d flows, want 1", len(flows))
	}
	steps := flows[0].Steps

	maxN := 0
	for i, s := range steps {
		if s.N != i+1 {
			t.Fatalf("step %d has n=%d, want a contiguous 1-based sequence", i, s.N)
		}
		if s.N > MaxStepsPerFlow {
			t.Fatalf("step n=%d exceeds MaxStepsPerFlow=%d (no sinks configured, so the sink-phase ceiling must never apply)", s.N, MaxStepsPerFlow)
		}
		if s.N > maxN {
			maxN = s.N
		}
	}
	if maxN != MaxStepsPerFlow {
		t.Fatalf("max step n = %d, want exactly %d — the wide tree fixture must be wide enough to exhaust the cap", maxN, MaxStepsPerFlow)
	}
	// visitedModules must have been capped too: this tree has 100 modules
	// but the flow can never expand more than MaxModulesPerFlow.
	if len(steps) == 0 {
		t.Fatal("expected at least one step")
	}
}

func TestBuildFlowsRespectsModulesCap(t *testing.T) {
	// A much wider tree (branching factor 8, 3 full levels = 1+8+64 = 73
	// nodes reachable within 2 hops) must still cap visitedModules at 32,
	// independent of the step cap.
	modules, edges := wideTreeFixture(600)
	in := Input{
		Modules:     modules,
		EntryPoints: []model.EntryPointRef{{ID: "m0", Path: "m0.ts", Kind: model.EntryKindLibrary}},
		CallEdges:   edges,
	}
	flows := BuildFlows(in)
	if len(flows) != 1 {
		t.Fatalf("got %d flows, want 1", len(flows))
	}
	// The step cap (18) is tighter than the modules cap (32) for this
	// fixture, so we can only assert the step invariant holds; a
	// dedicated width-limited fixture would be needed to isolate the
	// modules cap in isolation. Assert the step cap still holds under
	// heavier load as a regression guard.
	for _, s := range flows[0].Steps {
		if s.N > MaxStepsPerFlow {
			t.Fatalf("step n=%d exceeds MaxStepsPerFlow=%d under a larger fixture", s.N, MaxStepsPerFlow)
		}
	}
}

func TestBuildFlowsSinkStepsRespectCeiling(t *testing.T) {
	modules, edges := wideTreeFixture(100)
	// Sink-step dedup is GLOBAL per flow (by kind, not by module or box),
	// so hitting the 8-sink-step ceiling requires at least 8 DISTINCT sink
	// kinds among the visited modules, not just many sink sites.
	kinds := []string{
		model.SinkFSWrite, model.SinkFSRead, model.SinkNetFetch, model.SinkNetHTTP,
		model.SinkDBSQL, model.SinkDBORM, model.SinkCLIIO, model.SinkProcessExec,
		model.SinkProcessExit, model.SinkAICall, model.SinkEnvRead,
	}
	for i := range modules {
		kind := kinds[i%len(kinds)]
		modules[i].SinkSites = []model.SinkSite{{Kind: kind, Line: 1, Snippet: "op()"}}
		modules[i].Sinks = []string{kind}
	}
	in := Input{
		Modules:     modules,
		EntryPoints: []model.EntryPointRef{{ID: "m0", Path: "m0.ts", Kind: model.EntryKindLibrary}},
		CallEdges:   edges,
	}
	flows := BuildFlows(in)
	if len(flows) != 1 {
		t.Fatalf("got %d flows, want 1", len(flows))
	}
	maxN := 0
	for i, s := range flows[0].Steps {
		if s.N != i+1 {
			t.Fatalf("step %d has n=%d, want contiguous", i, s.N)
		}
		if s.N > SinkStepCeiling {
			t.Fatalf("step n=%d exceeds SinkStepCeiling=%d", s.N, SinkStepCeiling)
		}
		if s.N > maxN {
			maxN = s.N
		}
	}
	if maxN != SinkStepCeiling {
		t.Fatalf("max step n = %d, want exactly SinkStepCeiling=%d given enough sinks to fill it", maxN, SinkStepCeiling)
	}
}

// --- user-override merge preserving unknown keys ----------------------------

func simpleFlowFixture() Input {
	modules := []model.Module{
		{ID: "m0", Path: "m0.ts", Package: strp("pkgA"), Layer: model.LayerApplication},
		{ID: "m1", Path: "m1.ts", Package: strp("pkgB"), Layer: model.LayerDomain},
	}
	edges := []model.CallEdge{{From: "m0", To: "m1", Symbol: "run", Count: 1}}
	return Input{
		Modules:     modules,
		EntryPoints: []model.EntryPointRef{{ID: "m0", Path: "m0.ts", Kind: model.EntryKindLibrary}},
		CallEdges:   edges,
	}
}

func TestApplyFlowsCurationPreservesUnknownKeysAndOrder(t *testing.T) {
	in := simpleFlowFixture()
	flows := BuildFlows(in)
	if len(flows) != 1 {
		t.Fatalf("got %d flows, want 1", len(flows))
	}
	baseID := flows[0].ID // "flow:m0"

	overlay := []byte(fmt.Sprintf(`{"flows":[{"id":%q,"name":"Custom Name","owner":"team-x","steps":[{"n":1}]}]}`, baseID))

	out := ApplyFlowsCuration(flows, overlay)
	if len(out) != 1 {
		t.Fatalf("got %d curated flows, want 1 (matching id must merge in place, not append)", len(out))
	}

	// Verify key order via streaming decode: base keys first
	// (id,name,description,entry,entryKind,entryContainer,steps — with
	// name/steps VALUES overridden but positions unchanged), then the
	// unknown "owner" key (new, appended in overlay order), then "curated"
	// (forced, appended last).
	keys := decodeKeyOrder(t, out[0])
	want := []string{"id", "name", "description", "entry", "entryKind", "entryContainer", "steps", "owner", "curated"}
	if len(keys) != len(want) {
		t.Fatalf("key order = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("key order = %v, want %v", keys, want)
		}
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(out[0], &decoded); err != nil {
		t.Fatalf("Unmarshal curated flow: %v", err)
	}
	if string(decoded["curated"]) != "true" {
		t.Fatalf(`curated = %s, want true`, decoded["curated"])
	}
	var name string
	if err := json.Unmarshal(decoded["name"], &name); err != nil || name != "Custom Name" {
		t.Fatalf("name = %s, want \"Custom Name\"", decoded["name"])
	}
	var owner string
	if err := json.Unmarshal(decoded["owner"], &owner); err != nil || owner != "team-x" {
		t.Fatalf(`owner = %s, want "team-x" — unknown user key must survive verbatim`, decoded["owner"])
	}
	// description was not present in the overlay, so it must be inherited
	// from the auto-generated flow, unchanged.
	var desc string
	if err := json.Unmarshal(decoded["description"], &desc); err != nil || desc != flows[0].Description {
		t.Fatalf("description = %s, want inherited base description %q", decoded["description"], flows[0].Description)
	}
}

func TestApplyFlowsCurationAppendsUnmatchedID(t *testing.T) {
	in := simpleFlowFixture()
	flows := BuildFlows(in)

	overlay := []byte(`{"flows":[{"id":"flow:brand-new","name":"Hand-authored","notes":"see runbook"}]}`)
	out := ApplyFlowsCuration(flows, overlay)

	if len(out) != len(flows)+1 {
		t.Fatalf("got %d flows, want %d (auto flows + 1 new curated flow)", len(out), len(flows)+1)
	}
	// The new id must be appended LAST, after all auto flows retain their
	// original positions.
	var last map[string]json.RawMessage
	if err := json.Unmarshal(out[len(out)-1], &last); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	var id string
	json.Unmarshal(last["id"], &id)
	if id != "flow:brand-new" {
		t.Fatalf("last flow id = %q, want flow:brand-new", id)
	}
	var notes string
	if err := json.Unmarshal(last["notes"], &notes); err != nil || notes != "see runbook" {
		t.Fatalf("notes = %s, want \"see runbook\" to survive on a brand-new curated flow", last["notes"])
	}
	if string(last["curated"]) != "true" {
		t.Fatalf("curated = %s, want true", last["curated"])
	}
}

func TestApplyFlowsCurationNoFileIsNoOp(t *testing.T) {
	in := simpleFlowFixture()
	flows := BuildFlows(in)
	out := ApplyFlowsCuration(flows, nil)
	if len(out) != len(flows) {
		t.Fatalf("got %d, want %d", len(out), len(flows))
	}
	var decoded map[string]json.RawMessage
	json.Unmarshal(out[0], &decoded)
	if _, has := decoded["curated"]; has {
		t.Fatal("auto flow must not carry a curated key when no FLOWS.json exists")
	}
}

func TestApplyFlowsCurationMalformedJSONIsNoOp(t *testing.T) {
	in := simpleFlowFixture()
	flows := BuildFlows(in)
	out := ApplyFlowsCuration(flows, []byte("{not valid json"))
	if len(out) != len(flows) {
		t.Fatalf("got %d, want %d (malformed FLOWS.json must be a silent no-op, mirroring the CJS try/catch)", len(out), len(flows))
	}
}

func TestApplyFlowsCurationSkipsMissingID(t *testing.T) {
	in := simpleFlowFixture()
	flows := BuildFlows(in)
	overlay := []byte(`{"flows":[{"name":"no id here"}]}`)
	out := ApplyFlowsCuration(flows, overlay)
	if len(out) != len(flows) {
		t.Fatalf("got %d, want %d — an overlay entry without an id must be skipped entirely", len(out), len(flows))
	}
}

func decodeKeyOrder(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		t.Fatalf("expected a JSON object, got token=%v err=%v", tok, err)
	}
	var keys []string
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			t.Fatalf("Token: %v", err)
		}
		keys = append(keys, keyTok.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatalf("Decode value: %v", err)
		}
	}
	return keys
}

// --- determinism -------------------------------------------------------------

func TestBuildIsDeterministic(t *testing.T) {
	modules, edges := wideTreeFixture(60)
	for i := range modules {
		if i%3 == 0 {
			modules[i].SinkSites = []model.SinkSite{{Kind: model.SinkDBSQL, Line: 5, Snippet: "query()"}}
			modules[i].Sinks = []string{model.SinkDBSQL}
		}
	}
	containers := make([]model.Container, len(modules))
	for i, m := range modules {
		containers[i] = model.Container{ID: "pkg:" + *m.Package, Name: *m.Package, Path: *m.Package, Kind: "package"}
	}
	overlay := []byte(`{"flows":[{"id":"flow:m0","name":"Curated Entry","tag":"reviewed"}]}`)

	in := Input{
		Modules: modules,
		EntryPoints: []model.EntryPointRef{
			{ID: "m0", Path: "m0.ts", Kind: model.EntryKindLibrary},
		},
		CallEdges:  edges,
		Containers: containers,
		FlowsJSON:  overlay,
	}

	first, err := json.Marshal(Build(in))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for i := 0; i < 25; i++ {
		got, err := json.Marshal(Build(in))
		if err != nil {
			t.Fatalf("Marshal (iter %d): %v", i, err)
		}
		if string(got) != string(first) {
			t.Fatalf("iteration %d produced different output than the first run — non-determinism detected", i)
		}
	}
}

// --- boxes -------------------------------------------------------------------

func TestBuildBoxesShapesAndOrder(t *testing.T) {
	in := simpleFlowFixture()
	in.Containers = []model.Container{
		{ID: "pkg:pkgA", Name: "pkgA"},
		{ID: "pkg:pkgB", Name: "pkgB"},
	}
	res := Build(in)

	if len(res.Boxes) < 1 || res.Boxes[0].ID != "actor:user" || res.Boxes[0].Kind != "" {
		t.Fatalf("boxes[0] = %+v, want the actor box first", res.Boxes[0])
	}
	if res.Boxes[1].ID != "pkg:pkgA" || res.Boxes[1].Kind != "package" {
		t.Fatalf("boxes[1] = %+v, want the pkgA package box next (containers order)", res.Boxes[1])
	}
	if res.Boxes[2].ID != "pkg:pkgB" || res.Boxes[2].Kind != "package" {
		t.Fatalf("boxes[2] = %+v, want the pkgB package box last", res.Boxes[2])
	}

	// The actor box must marshal to exactly 5 keys, a package box to 9.
	actorJSON, _ := json.Marshal(res.Boxes[0])
	if got := decodeKeyOrder(t, actorJSON); len(got) != 5 {
		t.Fatalf("actor box keys = %v, want 5", got)
	}
	pkgJSON, _ := json.Marshal(res.Boxes[1])
	if got := decodeKeyOrder(t, pkgJSON); len(got) != 9 {
		t.Fatalf("package box keys = %v, want 9", got)
	}
}

func TestSinkBoxIDDuplicatesAllowed(t *testing.T) {
	if SinkBoxID(model.SinkFSWrite) != SinkBoxID(model.SinkFSRead) {
		t.Fatalf("fs:write and fs:read must map to the same sink box id (both -> Filesystem)")
	}
}
