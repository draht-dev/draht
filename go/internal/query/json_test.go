package query

import (
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestMarshalPretty_NoTrailingNewline(t *testing.T) {
	b, err := MarshalPretty(map[string]int{"a": 1})
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasSuffix(string(b), "\n") {
		t.Errorf("MarshalPretty result has a trailing newline: %q", string(b))
	}
	if string(b) != "{\n  \"a\": 1\n}" {
		t.Errorf("MarshalPretty = %q", string(b))
	}
}

// escapedLessThan is the 6-byte JSON-escaped form of '<' that
// encoding/json's default SetEscapeHTML(true) would emit. Spelled out as a
// rune-code concatenation (rather than a literal in the source) so it is
// unambiguous on read: backslash, u, 0, 0, 3, c.
var escapedLessThan = "\\" + "u003c"

func TestMarshalPretty_DoesNotEscapeHTML(t *testing.T) {
	b, err := MarshalPretty(map[string]string{"s": "<b>&amp;</b>"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), escapedLessThan) {
		t.Errorf("MarshalPretty escaped '<' as %s (SetEscapeHTML must be false): %q", escapedLessThan, string(b))
	}
	if !strings.Contains(string(b), "<b>") {
		t.Errorf("MarshalPretty = %q, want literal <b>", string(b))
	}
}

// TestClustersJSON_SurprisingOmittedWithoutFlag / WithFlagEmpty pin the
// omitempty-vs-pointer contract: the key must be entirely absent without
// --surprising, but MUST still appear (as "[]") when --surprising is passed
// and the connections list happens to be empty — a plain (non-pointer)
// slice field with `omitempty` would incorrectly collapse both cases to
// "absent", which diverges from JSON.stringify's undefined-vs-[] distinction.
func TestClustersJSON_SurprisingOmittedWithoutFlag(t *testing.T) {
	payload := ClustersJSON{Clusters: []model.Cluster{}}
	b, err := MarshalPretty(payload)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "surprisingConnections") {
		t.Errorf("surprisingConnections key present without --surprising: %s", b)
	}
}

func TestClustersJSON_SurprisingPresentButEmptyWithFlag(t *testing.T) {
	empty := []model.SurprisingConnection{}
	payload := ClustersJSON{Clusters: []model.Cluster{}, SurprisingConnections: &empty}
	b, err := MarshalPretty(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"surprisingConnections": []`) {
		t.Errorf("surprisingConnections key missing/wrong for an empty-but-present list: %s", b)
	}
}

func TestOrderedStrSlices_PreservesInsertionOrder(t *testing.T) {
	o := NewOrderedStrSlices()
	o.Append("z", "1")
	o.Append("a", "2")
	o.Append("z", "3")
	b, err := MarshalPretty(o)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"z\": [\n    \"1\",\n    \"3\"\n  ],\n  \"a\": [\n    \"2\"\n  ]\n}"
	if string(b) != want {
		t.Errorf("MarshalPretty(OrderedStrSlices) =\n%s\nwant\n%s", b, want)
	}
}

// TestMarshalPretty_LeavesAngleBracketsRaw is the synthetic escape-payload
// regression the spec calls out for MAP.html's `<` -> `<` pass; this
// package's MarshalPretty must NOT perform that escape (it is htmlview's
// job, not query's) — graph-* --json output is meant to be read by an LLM
// or piped to `jq`, not embedded in a <script> tag.
func TestMarshalPretty_LeavesAngleBracketsRaw(t *testing.T) {
	b, err := MarshalPretty(map[string]string{"doc": "SECURITY: sanitize </script><b> payloads"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "</script><b>") {
		t.Errorf("MarshalPretty escaped angle brackets it should have left raw: %s", b)
	}
}
