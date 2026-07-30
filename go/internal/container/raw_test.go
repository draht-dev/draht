package container

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestRawObject_RoundTripPreservesOrderAndUnknownKeys(t *testing.T) {
	src := `{"id":"group:core","name":"Core","owner":"team-x","nested":{"a":1,"b":2},"members":["pkg:a"]}`
	o := NewRawObject()
	if err := o.UnmarshalJSON([]byte(src)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	wantKeys := []string{"id", "name", "owner", "nested", "members"}
	if !reflect.DeepEqual(o.Keys(), wantKeys) {
		t.Fatalf("Keys() = %v, want %v", o.Keys(), wantKeys)
	}
	if raw, ok := o.Get("owner"); !ok || string(raw) != `"team-x"` {
		t.Fatalf("Get(owner) = %s, %v", raw, ok)
	}
	out, err := o.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	// Compact-vs-compact byte equality (both sides are already compact
	// JSON with no re-ordering).
	if string(out) != src {
		t.Fatalf("MarshalJSON round-trip = %s, want %s", out, src)
	}
}

func TestRawObjectFrom_CanonicalStructOrder(t *testing.T) {
	g := model.Group{
		ID: "group:core", Name: "Core", Color: "#d2a8ff", Description: "desc",
		Members: []string{"pkg:a"}, Source: "auto", ModuleCount: 3,
	}
	o, err := RawObjectFrom(g)
	if err != nil {
		t.Fatalf("RawObjectFrom: %v", err)
	}
	want := []string{"id", "name", "color", "description", "members", "source", "moduleCount"}
	if !reflect.DeepEqual(o.Keys(), want) {
		t.Fatalf("Keys() = %v, want %v", o.Keys(), want)
	}
}

func TestRawObject_SetPreservesPositionOnOverwrite(t *testing.T) {
	o := NewRawObject()
	_ = o.SetValue("a", 1)
	_ = o.SetValue("b", 2)
	_ = o.SetValue("c", 3)
	_ = o.SetValue("b", "changed") // overwrite, must NOT move to the end
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(o.Keys(), want) {
		t.Fatalf("Keys() = %v, want %v", o.Keys(), want)
	}
	raw, _ := o.Get("b")
	if string(raw) != `"changed"` {
		t.Fatalf("Get(b) = %s, want \"changed\"", raw)
	}
}

func TestRawObject_Clone_Independent(t *testing.T) {
	o := NewRawObject()
	_ = o.SetValue("a", 1)
	c := o.Clone()
	_ = c.SetValue("a", 2)
	raw, _ := o.Get("a")
	if string(raw) != "1" {
		t.Fatalf("original mutated by clone: %s", raw)
	}
}

func mustRaw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

func TestAssign_KeyOrderAndOverwriteSemantics(t *testing.T) {
	base := NewRawObject()
	base.Set("id", mustRaw(t, "g1"))
	base.Set("name", mustRaw(t, "Base"))
	base.Set("source", mustRaw(t, "auto"))

	overlay := NewRawObject()
	overlay.Set("name", mustRaw(t, "Overlay")) // overwrite, keeps base position
	overlay.Set("owner", mustRaw(t, "team-x")) // new key, appended after base's keys

	merged := Assign(base, overlay, KV{Key: "source", Value: mustRaw(t, "curated")})

	wantKeys := []string{"id", "name", "source", "owner"}
	if !reflect.DeepEqual(merged.Keys(), wantKeys) {
		t.Fatalf("Keys() = %v, want %v", merged.Keys(), wantKeys)
	}
	if raw, _ := merged.Get("name"); string(raw) != `"Overlay"` {
		t.Fatalf("name = %s, want Overlay", raw)
	}
	if raw, _ := merged.Get("source"); string(raw) != `"curated"` {
		t.Fatalf("source = %s, want curated (forced overwrite)", raw)
	}
	if raw, _ := merged.Get("id"); string(raw) != `"g1"` {
		t.Fatalf("id = %s, want g1 (inherited from base)", raw)
	}
}

func TestAssign_NilBase(t *testing.T) {
	overlay := NewRawObject()
	overlay.Set("id", mustRaw(t, "new"))
	merged := Assign(nil, overlay, KV{Key: "source", Value: mustRaw(t, "curated")})
	want := []string{"id", "source"}
	if !reflect.DeepEqual(merged.Keys(), want) {
		t.Fatalf("Keys() = %v, want %v", merged.Keys(), want)
	}
}

func autoGroupsFixture() []model.Group {
	return []model.Group{
		{ID: "group:frontend", Name: "Frontend", Color: "#79c0ff", Description: "d1",
			Members: []string{"pkg:@draht/web-ui"}, Source: "auto", ModuleCount: 4},
		{ID: "group:core", Name: "Core", Color: "#d2a8ff", Description: "d2",
			Members: []string{"pkg:@draht/ai"}, Source: "auto", ModuleCount: 6},
	}
}

func TestApplyGroupsCuration_NoFileReturnsCanonicalSnapshot(t *testing.T) {
	groups := autoGroupsFixture()
	out := ApplyGroupsCuration(groups, nil)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	var g model.Group
	if err := out[0].Into(&g); err != nil {
		t.Fatalf("Into: %v", err)
	}
	if !reflect.DeepEqual(g, groups[0]) {
		t.Fatalf("out[0] = %+v, want %+v", g, groups[0])
	}
}

func TestApplyGroupsCuration_NoFileSkipsDedupPass(t *testing.T) {
	// Mirrors draht-tools.cjs:1220 `if (!fs.existsSync(file)) return groups;`
	// — the absent-file path returns groups completely untouched, including
	// any pre-existing cross-group member duplication (which deriveGroups
	// itself never produces, but a hand-rolled fixture can).
	groups := []model.Group{
		{ID: "group:a", Name: "A", Color: "#111111", Members: []string{"pkg:x", "pkg:y"}, Source: "auto"},
		{ID: "group:b", Name: "B", Color: "#222222", Members: []string{"pkg:y", "pkg:z"}, Source: "auto"},
	}
	out := ApplyGroupsCuration(groups, nil)
	var b struct {
		Members []string `json:"members"`
	}
	if err := out[1].Into(&b); err != nil {
		t.Fatalf("Into: %v", err)
	}
	if !reflect.DeepEqual(b.Members, []string{"pkg:y", "pkg:z"}) {
		t.Fatalf("b.members = %v, want [pkg:y pkg:z] unchanged (no-file path skips dedup)", b.Members)
	}
}

func TestApplyGroupsCuration_MalformedJSONReturnsUnchanged(t *testing.T) {
	groups := autoGroupsFixture()
	out := ApplyGroupsCuration(groups, []byte(`{not valid json`))
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2 (malformed JSON must not error, must fall back)", len(out))
	}
}

func TestApplyGroupsCuration_GroupsFieldNotArrayReturnsUnchanged(t *testing.T) {
	groups := autoGroupsFixture()
	out := ApplyGroupsCuration(groups, []byte(`{"groups":{"not":"an array"}}`))
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
}

func TestApplyGroupsCuration_MergePreservesUnknownKeysAndSetsSourceCurated(t *testing.T) {
	groups := autoGroupsFixture()
	userJSON := []byte(`{"groups":[{"id":"group:frontend","owner":"team-ui","name":"Frontend UI"}]}`)
	out := ApplyGroupsCuration(groups, userJSON)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	fe := out[0] // matched id keeps its original position (index 0)
	if fe.Keys()[0] != "id" {
		t.Fatalf("frontend keys = %v, want id first (base order preserved)", fe.Keys())
	}
	if raw, ok := fe.Get("owner"); !ok || string(raw) != `"team-ui"` {
		t.Fatalf("owner = %s, %v, want team-ui (unknown key must survive)", raw, ok)
	}
	if raw, _ := fe.Get("name"); string(raw) != `"Frontend UI"` {
		t.Fatalf("name = %s, want overridden Frontend UI", raw)
	}
	if raw, _ := fe.Get("source"); string(raw) != `"curated"` {
		t.Fatalf("source = %s, want curated", raw)
	}
	// The unmatched auto group must stay untouched (source: auto).
	core := out[1]
	if raw, _ := core.Get("source"); string(raw) != `"auto"` {
		t.Fatalf("core source = %s, want auto (untouched)", raw)
	}
}

func TestApplyGroupsCuration_NewGroupIDAppendsAtEnd(t *testing.T) {
	groups := autoGroupsFixture()
	userJSON := []byte(`{"groups":[{"id":"group:custom","name":"Custom","members":["pkg:@draht/x"]}]}`)
	out := ApplyGroupsCuration(groups, userJSON)
	if len(out) != 3 {
		t.Fatalf("len(out) = %d, want 3", len(out))
	}
	if out[2].Keys()[0] != "id" {
		t.Fatalf("new group keys = %v", out[2].Keys())
	}
	idRaw, _ := out[2].Get("id")
	if string(idRaw) != `"group:custom"` {
		t.Fatalf("out[2] id = %s, want group:custom", idRaw)
	}
	srcRaw, _ := out[2].Get("source")
	if string(srcRaw) != `"curated"` {
		t.Fatalf("out[2] source = %s, want curated", srcRaw)
	}
}

func TestApplyGroupsCuration_MissingOrFalsyIDSkipsEntry(t *testing.T) {
	groups := autoGroupsFixture()
	userJSON := []byte(`{"groups":[{"name":"NoID"},{"id":"","name":"EmptyID"},{"id":null,"name":"NullID"}]}`)
	out := ApplyGroupsCuration(groups, userJSON)
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2 (all three entries lack a truthy id and must be skipped)", len(out))
	}
}

func TestApplyGroupsCuration_MembersDedupedGloballyFirstWins(t *testing.T) {
	// The member-dedup pass only runs when curation actually executes (a
	// parseable GROUPS.json with an array `groups` field) — when the file
	// is absent, applyGroupsCuration returns EARLY with groups UNCHANGED
	// (draht-tools.cjs:1220 `if (!fs.existsSync(file)) return groups;`), so
	// an empty-but-valid curation payload is used here to exercise the
	// dedup pass without curating anything.
	groups := []model.Group{
		{ID: "group:a", Name: "A", Color: "#111111", Description: "", Members: []string{"pkg:x", "pkg:y"}, Source: "auto", ModuleCount: 2},
		{ID: "group:b", Name: "B", Color: "#222222", Description: "", Members: []string{"pkg:y", "pkg:z"}, Source: "auto", ModuleCount: 2},
	}
	out := ApplyGroupsCuration(groups, []byte(`{"groups":[]}`))
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2", len(out))
	}
	var a, b struct {
		Members []string `json:"members"`
	}
	if err := out[0].Into(&a); err != nil {
		t.Fatalf("Into a: %v", err)
	}
	if err := out[1].Into(&b); err != nil {
		t.Fatalf("Into b: %v", err)
	}
	if !reflect.DeepEqual(a.Members, []string{"pkg:x", "pkg:y"}) {
		t.Fatalf("a.members = %v, want [pkg:x pkg:y] (untouched, scanned first)", a.Members)
	}
	if !reflect.DeepEqual(b.Members, []string{"pkg:z"}) {
		t.Fatalf("b.members = %v, want [pkg:z] (pkg:y already claimed by group:a)", b.Members)
	}
}

func TestApplyGroupsCuration_Determinism(t *testing.T) {
	groups := autoGroupsFixture()
	userJSON := []byte(`{"groups":[{"id":"group:frontend","owner":"team-ui"},{"id":"group:new","members":["pkg:x"]}]}`)
	run := func() []byte {
		out := ApplyGroupsCuration(groups, userJSON)
		b, err := json.Marshal(out)
		if err != nil {
			t.Fatalf("json.Marshal: %v", err)
		}
		return b
	}
	first := run()
	for i := 0; i < 20; i++ {
		next := run()
		if string(first) != string(next) {
			t.Fatalf("ApplyGroupsCuration is not deterministic:\n%s\nvs\n%s", first, next)
		}
	}
}
