package symindex

import (
	"fmt"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestExtractRationale_TypeScriptLineComment(t *testing.T) {
	content := []byte("doThing(); // SECURITY: validate input before use\n")
	got := ExtractRationale(content, "typescript")
	if len(got) != 1 {
		t.Fatalf("want 1 hit, got %+v", got)
	}
	if got[0].Tag != "SECURITY" {
		t.Errorf("want tag SECURITY, got %q", got[0].Tag)
	}
	if got[0].Text != "validate input before use" {
		t.Errorf("want trimmed text, got %q", got[0].Text)
	}
	if got[0].Line != 1 {
		t.Errorf("want line 1, got %d", got[0].Line)
	}
}

func TestExtractRationale_PythonHashComment(t *testing.T) {
	content := []byte("x = 1  # HACK: temporary until v2 ships\n")
	got := ExtractRationale(content, "python")
	if len(got) != 1 || got[0].Tag != "HACK" {
		t.Fatalf("got %+v", got)
	}
	if got[0].Text != "temporary until v2 ships" {
		t.Errorf("got text %q", got[0].Text)
	}
}

func TestExtractRationale_BlockCommentGo(t *testing.T) {
	content := []byte("/* WHY: this order matters for determinism */\nfunc f() {}\n")
	got := ExtractRationale(content, "go")
	if len(got) != 1 || got[0].Tag != "WHY" {
		t.Fatalf("got %+v", got)
	}
	if got[0].Text != "this order matters for determinism" {
		t.Errorf("got text %q", got[0].Text)
	}
}

func TestExtractRationale_MarkdownHTMLComment(t *testing.T) {
	// cjs:2159 — inline rationale is scanned for any commented language,
	// including markdown, even though markdown files never become modules.
	content := []byte("# Title\n\n<!-- TODO: document the retry policy -->\n")
	got := ExtractRationale(content, "markdown")
	if len(got) != 1 || got[0].Tag != "TODO" {
		t.Fatalf("got %+v", got)
	}
	if got[0].Text != "document the retry policy" {
		t.Errorf("got text %q", got[0].Text)
	}
}

func TestExtractRationale_IgnoresUnmarkedComments(t *testing.T) {
	content := []byte("// just an ordinary comment\nconst x = 1;\n")
	got := ExtractRationale(content, "typescript")
	if len(got) != 0 {
		t.Fatalf("want no hits, got %+v", got)
	}
}

func TestExtractRationale_IgnoresUnrecognisedLanguage(t *testing.T) {
	content := []byte(`{"note": "TODO: not a comment, this is JSON"}`)
	got := ExtractRationale(content, "json")
	if len(got) != 0 {
		t.Fatalf("want no hits for a language with no comment style, got %+v", got)
	}
}

func TestExtractRationale_PerFileCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 40; i++ {
		fmt.Fprintf(&b, "call(); // TODO: item %d\n", i)
	}
	got := ExtractRationale([]byte(b.String()), "typescript")
	if len(got) != RationalePerFile {
		t.Fatalf("want exactly %d hits (per-file cap), got %d", RationalePerFile, len(got))
	}
	// The cap must keep the FIRST 30 encountered, not e.g. the last 30.
	if got[0].Text != "item 0" {
		t.Errorf("want first hit to be item 0, got %q", got[0].Text)
	}
	if got[29].Text != "item 29" {
		t.Errorf("want 30th hit to be item 29, got %q", got[29].Text)
	}
}

func TestExtractRationale_TextTruncatedTo120UTF16Units(t *testing.T) {
	long := strings.Repeat("x", 200)
	content := []byte("// NOTE: " + long + "\n")
	got := ExtractRationale(content, "typescript")
	if len(got) != 1 {
		t.Fatalf("want 1 hit, got %d", len(got))
	}
	if len(got[0].Text) != 120 {
		t.Fatalf("want text truncated to 120 (ASCII, so bytes==UTF-16 units), got %d: %q", len(got[0].Text), got[0].Text)
	}
}

func TestSliceUTF16_CountsSurrogatePairsAsTwoUnits(t *testing.T) {
	// U+1F600 (😀) is a single Go rune but encodes as a UTF-16 SURROGATE
	// PAIR (2 code units), exactly like JS — a naive rune-count slice would
	// cut after 1 rune, but JS (and this function) cut after 1 UTF-16 unit,
	// landing mid-surrogate-pair.
	s := "😀x"

	// Slicing to 1 unit lands inside the pair: not empty, and not the whole
	// emoji either.
	if got := sliceUTF16(s, 1); got == "" || got == "😀" {
		t.Fatalf("sliceUTF16(%q, 1) = %q, want a lone-surrogate replacement, not empty or the whole emoji", s, got)
	}
	if got := sliceUTF16(s, 2); got != "😀" {
		t.Errorf("sliceUTF16(%q, 2) = %q, want the whole emoji (2 UTF-16 units)", s, got)
	}
	if got := sliceUTF16(s, 3); got != "😀x" {
		t.Errorf("sliceUTF16(%q, 3) = %q, want the full string", s, got)
	}
}

func TestHitsToEntries(t *testing.T) {
	hits := []Hit{{Line: 3, Tag: "TODO", Text: "fix"}}
	got := HitsToEntries("pkg/a.ts", hits)
	want := []model.RationaleEntry{{File: "pkg/a.ts", Line: 3, Tag: "TODO", Text: "fix"}}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestHitsToEntries_Empty(t *testing.T) {
	if got := HitsToEntries("a.ts", nil); got != nil {
		t.Fatalf("want nil for no hits, got %+v", got)
	}
}

func TestBuildRationaleIndex_SortsBySeverityThenFileThenLine(t *testing.T) {
	all := []model.RationaleEntry{
		{File: "b.ts", Line: 1, Tag: "TODO", Text: "t1"},    // severity 8
		{File: "a.ts", Line: 5, Tag: "SECURITY", Text: "s"}, // severity 0
		{File: "a.ts", Line: 1, Tag: "BUG", Text: "b"},      // severity 1
		{File: "a.ts", Line: 2, Tag: "BUG", Text: "b2"},     // severity 1, same file, later line
	}
	got := BuildRationaleIndex(all)
	wantOrder := []string{"s", "b", "b2", "t1"}
	if len(got) != len(wantOrder) {
		t.Fatalf("want %d entries, got %d: %+v", len(wantOrder), len(got), got)
	}
	for i, w := range wantOrder {
		if got[i].Text != w {
			t.Errorf("entry %d: want text %q, got %q (%+v)", i, w, got[i].Text, got[i])
		}
	}
}

func TestBuildRationaleIndex_StableOnFullTies(t *testing.T) {
	// Two hits with identical severity, file, and line — order must be
	// preserved from the input (JS Array.sort is stable since ES2019).
	all := []model.RationaleEntry{
		{File: "a.ts", Line: 10, Tag: "NOTE", Text: "first"},
		{File: "a.ts", Line: 10, Tag: "NOTE", Text: "second"},
	}
	got := BuildRationaleIndex(all)
	if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" {
		t.Fatalf("stability broken: %+v", got)
	}
}

func TestBuildRationaleIndex_DoesNotMutateInput(t *testing.T) {
	all := []model.RationaleEntry{
		{File: "b.ts", Line: 1, Tag: "TODO", Text: "t1"},
		{File: "a.ts", Line: 1, Tag: "SECURITY", Text: "s"},
	}
	original := append([]model.RationaleEntry(nil), all...)
	_ = BuildRationaleIndex(all)
	for i := range all {
		if all[i] != original[i] {
			t.Fatalf("BuildRationaleIndex mutated its input at index %d", i)
		}
	}
}

func TestBuildRationaleIndex_GlobalCap(t *testing.T) {
	all := make([]model.RationaleEntry, 0, 700)
	for i := 0; i < 700; i++ {
		all = append(all, model.RationaleEntry{
			File: fmt.Sprintf("f%04d.ts", i),
			Line: 1,
			Tag:  "NOTE",
			Text: fmt.Sprintf("n%d", i),
		})
	}
	got := BuildRationaleIndex(all)
	if len(got) != RationaleGlobalCap {
		t.Fatalf("want exactly %d entries (global cap), got %d", RationaleGlobalCap, len(got))
	}
	// All entries share severity, so the surviving 600 must be the
	// file-ASC-lowest 600 (f0000..f0599).
	if got[0].File != "f0000.ts" {
		t.Errorf("want first survivor f0000.ts, got %s", got[0].File)
	}
	if got[len(got)-1].File != "f0599.ts" {
		t.Errorf("want last survivor f0599.ts, got %s", got[len(got)-1].File)
	}
}

func TestBuildRationaleIndex_HigherSeveritySurvivesOverLowerWhenCapped(t *testing.T) {
	// A single SECURITY hit must outrank hundreds of NOTE/WHY hits even
	// when the NOTE/WHY hits would otherwise sort earlier by file/line.
	all := []model.RationaleEntry{{File: "zzz.ts", Line: 999, Tag: "SECURITY", Text: "critical"}}
	for i := 0; i < 700; i++ {
		all = append(all, model.RationaleEntry{
			File: fmt.Sprintf("a%04d.ts", i), Line: 1, Tag: "WHY", Text: "low",
		})
	}
	got := BuildRationaleIndex(all)
	if len(got) != RationaleGlobalCap {
		t.Fatalf("want %d entries, got %d", RationaleGlobalCap, len(got))
	}
	if got[0].Tag != "SECURITY" || got[0].Text != "critical" {
		t.Fatalf("want the SECURITY hit ranked first regardless of file/line, got %+v", got[0])
	}
}

func TestSeverityAndMarkersConsistency(t *testing.T) {
	if len(Markers) != len(Severity) {
		t.Fatalf("Markers and Severity must describe the same 11 tags")
	}
	for _, m := range Markers {
		if _, ok := Severity[m]; !ok {
			t.Errorf("marker %q missing from Severity", m)
		}
	}
}
