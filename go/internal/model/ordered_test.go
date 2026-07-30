package model

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestOrderedCountsInsertionOrderNotSorted(t *testing.T) {
	o := NewOrderedCounts()
	o.Inc("other")
	o.Inc("markdown")
	o.Inc("json")

	b, err := json.Marshal(o)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"other":1,"markdown":1,"json":1}`
	if string(b) != want {
		t.Errorf("Marshal() = %s, want %s (must NOT sort to json,markdown,other)", b, want)
	}
}

func TestOrderedCountsAddAccumulates(t *testing.T) {
	o := NewOrderedCounts()
	o.Add("a", 3)
	o.Add("b", 1)
	o.Add("a", 2)
	if got := o.Get("a"); got != 5 {
		t.Errorf("Get(a) = %d, want 5", got)
	}
	if got := o.Len(); got != 2 {
		t.Errorf("Len() = %d, want 2", got)
	}
	if keys := o.Keys(); len(keys) != 2 || keys[0] != "a" || keys[1] != "b" {
		t.Errorf("Keys() = %v, want [a b]", keys)
	}
}

// TestOrderedCountsEmptyMarshalsBraces covers the empty (but non-nil) case.
// NOTE: a genuinely nil *OrderedCounts marshals as JSON `null` regardless of
// MarshalJSON's own nil-safety, because encoding/json short-circuits nil
// pointers to `null` before invoking a custom Marshaler (see
// encoding/json's marshalerEncoder). MarshalJSON's nil-receiver handling
// only matters if it is invoked directly, not via json.Marshal on a nil
// field — so every *OrderedCounts field MUST be constructed via
// NewOrderedCounts() (which NewMap() already does for all four).
func TestOrderedCountsEmptyMarshalsBraces(t *testing.T) {
	b, err := json.Marshal(NewOrderedCounts())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(b) != "{}" {
		t.Errorf("Marshal() = %s, want {}", b)
	}
}

// TestOrderedCountsIndentedNesting verifies MarshalJSON emits compact JSON
// that the ENCLOSING json.Encoder correctly re-indents when nested inside an
// indented encode (design: "emit COMPACT JSON and let the encoder indent
// it" — encoding/json re-indents the output of a custom marshaler).
func TestOrderedCountsIndentedNesting(t *testing.T) {
	type wrapper struct {
		Counts *OrderedCounts `json:"counts"`
	}
	o := NewOrderedCounts()
	o.Inc("a")
	o.Inc("b")

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(wrapper{Counts: o}); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	want := "{\n  \"counts\": {\n    \"a\": 1,\n    \"b\": 1\n  }\n}\n"
	if buf.String() != want {
		t.Errorf("indented encode mismatch:\ngot:  %q\nwant: %q", buf.String(), want)
	}
}

func TestOrderedCountsUnmarshalPreservesOrder(t *testing.T) {
	src := `{"z":1,"a":2,"m":3}`
	var o OrderedCounts
	if err := json.Unmarshal([]byte(src), &o); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if keys := o.Keys(); len(keys) != 3 || keys[0] != "z" || keys[1] != "a" || keys[2] != "m" {
		t.Errorf("Keys() = %v, want [z a m]", keys)
	}
	if o.Get("a") != 2 {
		t.Errorf("Get(a) = %d, want 2", o.Get("a"))
	}
	// Round-trip: re-marshal must reproduce the same key order.
	b, err := json.Marshal(&o)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(b) != src {
		t.Errorf("round-trip = %s, want %s", b, src)
	}
}

func TestOrderedCountsUnmarshalRejectsNonObject(t *testing.T) {
	var o OrderedCounts
	if err := json.Unmarshal([]byte(`[1,2,3]`), &o); err == nil {
		t.Error("expected an error unmarshaling a JSON array into OrderedCounts")
	}
}
