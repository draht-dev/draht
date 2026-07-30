package htmlview

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// ---- structural landmarks --------------------------------------------

// TestRender_StructuralLandmarks asserts the rendered document contains the
// fixed markers a viewer must have: the doctype/closing tags, the
// map-data script tag the JS reads back via textContent + JSON.parse, and
// the JSON_PATH assignment. These are cheap, format-stable checks that
// don't require re-deriving the whole 2,000-line viewer.
func TestRender_StructuralLandmarks(t *testing.T) {
	m := model.NewMap()
	m.Root = "example-repo"

	out, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	html := string(out)

	for _, want := range []string{
		"<!doctype html>",
		"</html>",
		"<title>Draht ▸ Architecture " + "&" + " Flows</title>",
		`<script id="map-data" type="application/json">`,
		"var JSON_PATH =",
		"var GOLD = 2.399963229;",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("rendered output missing landmark %q", want)
		}
	}

	if strings.Contains(html, tokenMapJSON) {
		t.Error("rendered output still contains the raw map-JSON injection token")
	}
	if strings.Contains(html, tokenJSONPath) {
		t.Error("rendered output still contains the raw JSON-path injection token")
	}
}

// TestRender_JSONPath asserts JSON_PATH is "./" + basename(jsonPath),
// matching JSON.stringify("./" + jsonName) in the CJS.
func TestRender_JSONPath(t *testing.T) {
	m := model.NewMap()
	cases := []struct {
		in   string
		want string
	}{
		{"MAP.json", `var JSON_PATH = "./MAP.json";`},
		{"./MAP.json", `var JSON_PATH = "./MAP.json";`},
		{"/abs/path/to/.planning/codebase/MAP.json", `var JSON_PATH = "./MAP.json";`},
		{"other-name.json", `var JSON_PATH = "./other-name.json";`},
	}
	for _, tc := range cases {
		out, err := Render(tc.in, m)
		if err != nil {
			t.Fatalf("Render(%q): %v", tc.in, err)
		}
		if !strings.Contains(string(out), tc.want) {
			t.Errorf("Render(%q): output missing %q", tc.in, tc.want)
		}
	}
}

// ---- the escaping contract ---------------------------------------------

// TestEmbedJSON_EscapesAngleBrackets is the primary regression test for the
// one piece of real logic in this package. The real draht-mono repo's
// embedded JSON contains zero '<' bytes, so parity against this repo's own
// MAP.html cannot exercise the escape at all — this synthetic fixture is
// mandatory coverage, not optional. Expected bytes were independently
// verified by running the CJS's own two-line contract in isolation:
//
//	node -e 'console.log(JSON.stringify({doc:"SECURITY: sanitize </script><b> payloads before render"}).replace(/</g, "\\u003c"))'
//	=> {"doc":"SECURITY: sanitize \u003c/script>\u003cb> payloads before render"}
func TestEmbedJSON_EscapesAngleBrackets(t *testing.T) {
	m := model.NewMap()
	m.RationaleIndex = append(m.RationaleIndex, model.RationaleEntry{
		File: "src/example.ts",
		Line: 6,
		Tag:  "SECURITY",
		Text: "SECURITY: sanitize </script><b> payloads before render",
	})

	got, err := EmbedJSON(m)
	if err != nil {
		t.Fatalf("EmbedJSON: %v", err)
	}
	s := string(got)

	const wantFragment = `SECURITY: sanitize \u003c/script>\u003cb> payloads before render`
	if !strings.Contains(s, wantFragment) {
		t.Errorf("EmbedJSON output missing expected escaped fragment.\n got fragment around \"SECURITY\": %s\n want substring: %s",
			extractAround(s, "SECURITY", 120), wantFragment)
	}

	// '>' and '&' must be left untouched (CJS only escapes '<').
	if !strings.Contains(s, `/script>`) {
		t.Error("'>' was escaped or altered; the CJS only escapes '<'")
	}

	// No raw '<' byte may survive anywhere in the payload -- this is the
	// actual safety property: a "</script>" cannot appear because its
	// leading '<' has been replaced everywhere in the string.
	if strings.ContainsRune(s, '<') {
		t.Error("EmbedJSON output contains a raw '<' byte; the escape pass did not cover every occurrence")
	}
	if strings.Contains(s, "</script>") {
		t.Error("EmbedJSON output contains a raw \"</script>\" sequence -- script-tag breakout is possible")
	}
}

// TestRender_EscapePreventsScriptBreakout proves the property at the level
// that actually matters: embedding attacker-controlled data containing
// "</script>" must not increase the number of literal "</script>"
// occurrences in the final HTML document beyond what the static template
// itself already contains (its own closing </script> tags for the
// viewer's inline <script> blocks).
func TestRender_EscapePreventsScriptBreakout(t *testing.T) {
	baseline := strings.Count(viewerTemplate, "</script>")

	m := model.NewMap()
	m.RationaleIndex = append(m.RationaleIndex, model.RationaleEntry{
		File: "src/example.ts",
		Line: 1,
		Tag:  "HACK",
		Text: `</script><script>alert(1)</script>`,
	})

	out, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	got := strings.Count(string(out), "</script>")
	if got != baseline {
		t.Errorf("rendered document has %d occurrences of \"</script>\", want %d (the static template's own count) -- payload data leaked a raw closing script tag",
			got, baseline)
	}
}

// TestEmbedJSON_RoundTripsAsJSON simulates the viewer's own consumption
// path (`JSON.parse(document.getElementById("map-data").textContent)`):
// textContent of an un-executed application/json <script> yields the raw
// source text with '<' already reverted by the browser's HTML tokenizer
// only in the sense that it was never an active tag boundary -- the bytes
// "<" are standard JSON and decode back to '<' via JSON.parse. This
// test proves the escaped blob is valid, round-trippable JSON.
func TestEmbedJSON_RoundTripsAsJSON(t *testing.T) {
	m := model.NewMap()
	m.Root = "example-repo"
	m.RationaleIndex = append(m.RationaleIndex, model.RationaleEntry{
		File: "src/example.ts",
		Line: 1,
		Tag:  "SECURITY",
		Text: "</script><b>",
	})

	got, err := EmbedJSON(m)
	if err != nil {
		t.Fatalf("EmbedJSON: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("EmbedJSON output is not valid JSON: %v\npayload: %s", err, got)
	}
	rationale, ok := decoded["rationaleIndex"].([]any)
	if !ok || len(rationale) != 1 {
		t.Fatalf("decoded rationaleIndex = %#v, want a single-element slice", decoded["rationaleIndex"])
	}
	entry, ok := rationale[0].(map[string]any)
	if !ok {
		t.Fatalf("decoded rationaleIndex[0] = %#v, want an object", rationale[0])
	}
	if got, want := entry["text"], "</script><b>"; got != want {
		t.Errorf("round-tripped text = %q, want %q", got, want)
	}
}

// ---- generatedAt / buildMs zeroing --------------------------------------

// TestEmbedJSON_ZeroesGeneratedAtAndBuildMs asserts the embedded copy is
// zeroed (empty string, NOT null; 0, NOT omitted) while the caller's Map is
// never mutated (Object.assign({}, map, ...) is a shallow copy in the CJS).
func TestEmbedJSON_ZeroesGeneratedAtAndBuildMs(t *testing.T) {
	m := model.NewMap()
	m.GeneratedAt = "2026-01-01T00:00:00.000Z"
	m.BuildMs = 654

	got, err := EmbedJSON(m)
	if err != nil {
		t.Fatalf("EmbedJSON: %v", err)
	}
	s := string(got)

	if !strings.Contains(s, `"generatedAt":""`) {
		t.Error(`EmbedJSON output missing "generatedAt":""`)
	}
	if !strings.Contains(s, `"buildMs":0`) {
		t.Error(`EmbedJSON output missing "buildMs":0`)
	}
	if strings.Contains(s, "2026-01-01") {
		t.Error("EmbedJSON output leaked the real generatedAt timestamp")
	}

	if m.GeneratedAt != "2026-01-01T00:00:00.000Z" {
		t.Errorf("EmbedJSON mutated the caller's Map.GeneratedAt: got %q", m.GeneratedAt)
	}
	if m.BuildMs != 654 {
		t.Errorf("EmbedJSON mutated the caller's Map.BuildMs: got %d", m.BuildMs)
	}
}

// ---- determinism ---------------------------------------------------------

// TestRender_Determinism proves the whole point of zeroing
// generatedAt/buildMs: rendering the identical *model.Map twice, with real
// (non-empty) timestamp/duration fields set, produces byte-identical
// output. This is the guarantee visWriteOutputs relies on to write MAP.html
// unconditionally on every build without perturbing the git-churn gate.
func TestRender_Determinism(t *testing.T) {
	m := model.NewMap()
	m.Root = "example-repo"
	m.GeneratedAt = "2026-01-01T00:00:00.000Z"
	m.BuildMs = 42
	m.RationaleIndex = append(m.RationaleIndex, model.RationaleEntry{
		File: "src/example.ts", Line: 3, Tag: "NOTE", Text: "hello",
	})

	first, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render (1): %v", err)
	}

	m.GeneratedAt = "2026-06-15T12:34:56.000Z" // simulate wall-clock drift
	m.BuildMs = 999

	second, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render (2): %v", err)
	}

	if string(first) != string(second) {
		t.Fatalf("Render is not deterministic across differing GeneratedAt/BuildMs input")
	}
}

// TestRender_DeterministicRepeat proves plain repeatability with an
// unmodified Map (no field mutation between calls).
func TestRender_DeterministicRepeat(t *testing.T) {
	m := model.NewMap()
	m.Root = "example-repo"

	a, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render (1): %v", err)
	}
	b, err := Render("./MAP.json", m)
	if err != nil {
		t.Fatalf("Render (2): %v", err)
	}
	if string(a) != string(b) {
		t.Fatal("Render produced different bytes for two calls with an identical, unmutated Map")
	}
}

// ---- error paths ----------------------------------------------------------

func TestEmbedJSON_NilMap(t *testing.T) {
	if _, err := EmbedJSON(nil); err == nil {
		t.Fatal("EmbedJSON(nil): want error, got nil")
	}
}

// extractAround returns a small window of s around the first occurrence of
// needle, for readable test failure output.
func extractAround(s, needle string, radius int) string {
	i := strings.Index(s, needle)
	if i < 0 {
		return "(not found)"
	}
	start := i - radius
	if start < 0 {
		start = 0
	}
	end := i + radius
	if end > len(s) {
		end = len(s)
	}
	return s[start:end]
}
