package model

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestNewMapDeferredArraysNeverNull asserts every one of the 13 Phase-1
// deferred top-level arrays serializes as `[]`, never `null` (design §R5 —
// MAP.html dereferences these without a `|| []` guard).
func TestNewMapDeferredArraysNeverNull(t *testing.T) {
	m := NewMap()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	s := string(b)

	deferredKeys := []string{
		"packages", "groups", "containers", "boundedContexts", "modules",
		"edges", "callEdges", "containerEdges", "entryPoints", "sinks",
		"flows", "boxes", "symbolIndex", "clusters", "surprisingConnections",
		"rationaleIndex",
	}
	for _, key := range deferredKeys {
		needle := `"` + key + `":null`
		if strings.Contains(s, needle) {
			t.Errorf("key %q marshaled as null, want []: %s", key, s)
		}
	}
	// stats.layers must also be a non-nil object (design §R5).
	if strings.Contains(s, `"layers":null`) {
		t.Error(`stats.layers marshaled as null, want {}`)
	}
	if !strings.Contains(s, `"lanes":[{`) {
		t.Errorf("expected NewMap() to pre-populate the 6 hardcoded lanes, got: %s", s)
	}
}

func TestEdgeResolvedPointerSemantics(t *testing.T) {
	falseVal := false
	e := Edge{From: "a", To: "b", Kind: EdgeKindExternal, Confidence: ConfidenceExtracted, Resolved: &falseVal}
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(b), `"resolved":false`) {
		t.Errorf("expected resolved:false in %s", b)
	}

	// An import/re-export edge must OMIT resolved entirely (nil pointer).
	e2 := Edge{From: "a", To: "b", Kind: EdgeKindImport, Confidence: ConfidenceExtracted}
	b2, err := json.Marshal(e2)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(b2), "resolved") {
		t.Errorf("expected resolved to be omitted, got %s", b2)
	}
}

func TestEntryPointRefRoutesNullNotEmpty(t *testing.T) {
	ref := EntryPointRef{ID: "a", Path: "a", Kind: EntryKindCLI, Name: Str("cli")}
	b, err := json.Marshal(ref)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(b), `"routes":null`) {
		t.Errorf("expected routes:null (no omitempty) for a nil Routes slice, got %s", b)
	}
}

func TestRound2(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{144, 144},
		{293.6149, 293.61},
		{0, 0},
		{2.345, 2.35}, // round-half-away-from-zero, matching Math.round semantics
	}
	for _, c := range cases {
		if got := Round2(c.in); got != c.want {
			t.Errorf("Round2(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestPointerConstructors(t *testing.T) {
	if s := Str("x"); s == nil || *s != "x" {
		t.Errorf("Str(%q) = %v", "x", s)
	}
	if n := Int(5); n == nil || *n != 5 {
		t.Errorf("Int(5) = %v", n)
	}
	if b := Bool(true); b == nil || *b != true {
		t.Errorf("Bool(true) = %v", b)
	}
}

func TestDefaultLanes(t *testing.T) {
	lanes := DefaultLanes()
	if len(lanes) != 6 {
		t.Fatalf("len(DefaultLanes()) = %d, want 6", len(lanes))
	}
	want := []string{"actor", "presentation", "application", "domain", "infrastructure", "sinks"}
	for i, id := range want {
		if lanes[i].ID != id {
			t.Errorf("lanes[%d].ID = %q, want %q", i, lanes[i].ID, id)
		}
	}
}

func TestDefaultAgentHints(t *testing.T) {
	h := DefaultAgentHints()
	if len(h.HowToUse) != 20 {
		t.Errorf("len(HowToUse) = %d, want 20", len(h.HowToUse))
	}
	if h.Description == "" {
		t.Error("Description must not be empty")
	}
}

// TestUnescapedHTMLChars ensures the encoder never escapes '<', '>', '&' —
// the reference MAP.json contains raw instances of both (design's
// SERIALIZATION CONTRACT).
func TestUnescapedHTMLChars(t *testing.T) {
	m := NewMap()
	m.Root = "a<b>&c"
	var buf strings.Builder
	if err := WriteMapJSON(&buf, m); err != nil {
		t.Fatalf("WriteMapJSON: %v", err)
	}
	if !strings.Contains(buf.String(), `a<b>&c`) {
		t.Errorf("expected raw a<b>&c in output, got escaped: %s", buf.String())
	}
}
