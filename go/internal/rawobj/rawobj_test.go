package rawobj

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestMarshalNoEscape_DoesNotEscapeHTMLCharacters(t *testing.T) {
	got, err := MarshalNoEscape("CLI & Runtime <thing> a<b")
	if err != nil {
		t.Fatalf("MarshalNoEscape: %v", err)
	}
	want := `"CLI & Runtime <thing> a<b"`
	if string(got) != want {
		t.Fatalf("MarshalNoEscape = %s, want %s (must not \\u003c/\\u0026-escape)", got, want)
	}
}

func TestObject_MarshalJSON_PreservesUnescapedValues(t *testing.T) {
	o := New()
	if err := o.SetValue("snippet", "if (a < b && c > d)"); err != nil {
		t.Fatalf("SetValue: %v", err)
	}
	out, err := o.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	escaped := "\\u003c"
	if strings.Contains(string(out), escaped) {
		t.Fatalf("MarshalJSON HTML-escaped its bytes: %s", out)
	}
	if !strings.Contains(string(out), `"if (a < b && c > d)"`) {
		t.Fatalf("MarshalJSON = %s, want literal < and & preserved", out)
	}
}

func TestObject_RoundTripPreservesOrderAndUnknownKeys(t *testing.T) {
	src := `{"id":"x","name":"Y","owner":"team-x","nested":{"a":1,"b":2},"members":["pkg:a"]}`
	o := New()
	if err := o.UnmarshalJSON([]byte(src)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	wantKeys := []string{"id", "name", "owner", "nested", "members"}
	if !reflect.DeepEqual(o.Keys(), wantKeys) {
		t.Fatalf("Keys() = %v, want %v", o.Keys(), wantKeys)
	}
	out, err := o.MarshalJSON()
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if string(out) != src {
		t.Fatalf("MarshalJSON round-trip = %s, want %s", out, src)
	}
}

func TestObject_SetPreservesPositionOnOverwrite(t *testing.T) {
	o := New()
	_ = o.SetValue("a", 1)
	_ = o.SetValue("b", 2)
	_ = o.SetValue("c", 3)
	_ = o.SetValue("b", "changed")
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(o.Keys(), want) {
		t.Fatalf("Keys() = %v, want %v", o.Keys(), want)
	}
}

func TestObject_Clone_Independent(t *testing.T) {
	o := New()
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
	b, err := MarshalNoEscape(v)
	if err != nil {
		t.Fatalf("MarshalNoEscape: %v", err)
	}
	return b
}

func TestAssign_KeyOrderAndOverwriteSemantics(t *testing.T) {
	base := New()
	base.Set("id", mustRaw(t, "g1"))
	base.Set("name", mustRaw(t, "Base"))
	base.Set("source", mustRaw(t, "auto"))

	overlay := New()
	overlay.Set("name", mustRaw(t, "Overlay"))
	overlay.Set("owner", mustRaw(t, "team-x"))

	merged := Assign(base, overlay, KV{Key: "source", Value: mustRaw(t, "curated")})

	wantKeys := []string{"id", "name", "source", "owner"}
	if !reflect.DeepEqual(merged.Keys(), wantKeys) {
		t.Fatalf("Keys() = %v, want %v", merged.Keys(), wantKeys)
	}
	if raw, _ := merged.Get("source"); string(raw) != `"curated"` {
		t.Fatalf("source = %s, want curated (forced overwrite)", raw)
	}
}

func TestAssign_NilBase(t *testing.T) {
	overlay := New()
	overlay.Set("id", mustRaw(t, "new"))
	merged := Assign(nil, overlay, KV{Key: "source", Value: mustRaw(t, "curated")})
	want := []string{"id", "source"}
	if !reflect.DeepEqual(merged.Keys(), want) {
		t.Fatalf("Keys() = %v, want %v", merged.Keys(), want)
	}
}

func TestTruthy(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{`null`, false},
		{`false`, false},
		{`0`, false},
		{`""`, false},
		{`true`, true},
		{`1`, true},
		{`"x"`, true},
		{`[]`, true},
		{`{}`, true},
	}
	for _, c := range cases {
		if got := Truthy(json.RawMessage(c.raw)); got != c.want {
			t.Errorf("Truthy(%s) = %v, want %v", c.raw, got, c.want)
		}
	}
}

func TestUnmarshalJSON_NotAnObjectErrors(t *testing.T) {
	o := New()
	if err := o.UnmarshalJSON([]byte(`[1,2,3]`)); err == nil {
		t.Fatal("expected an error for a non-object top-level value")
	}
}
