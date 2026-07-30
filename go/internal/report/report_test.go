package report

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// buildFullMap constructs a hand-built map exercising every branch of the
// renderer: >8 clusters (cap), a cluster with no members, a cluster whose
// members are all non-code (fallback to unfiltered), >8 godNodes (cap),
// >10 surprisingConnections including a "bridge" match ONLY in the entry
// past the render cap (proves the question-2 probe searches the full,
// unsliced list), and a rationaleIndex with 12 SECURITY entries filling the
// highlights cap plus a 13th (HACK) entry past the cap (proves the
// question-3 probe searches the full, unfiltered rationaleIndex). These
// values and the corresponding golden file (testdata/full.GRAPH_REPORT.md)
// were produced by feeding an equivalent JSON object straight into the
// CJS engine's own visRenderReport (draht-tools.cjs:5046-5096), extracted
// and evaluated in isolation — not hand-transcribed — so the golden is a
// genuine CJS output, not a guess at one.
func buildFullMap() *model.Map {
	m := model.NewMap()
	m.Root = "fixture-repo"

	m.Stats.Files = 11
	m.Stats.TotalLoc = 12345
	m.Stats.Packages = 3
	m.Stats.Edges = 8
	m.Stats.EntryPoints = 2
	for _, kv := range []struct {
		k string
		v int
	}{
		{"typescript", 10}, {"other", 99}, {"markdown", 5}, {"json", 4},
		{"go", 3}, {"javascript", 2}, {"shell", 2}, {"python", 1},
	} {
		m.Stats.Languages.Add(kv.k, kv.v)
	}

	m.Assets.Total = 4

	m.Clusters = []model.Cluster{
		{Label: "packages/core", Size: 42, DominantLayer: "domain", Members: []string{
			"docs/readme.md", "packages/core/src/a.ts", "packages/core/src/b.ts",
			"packages/core/src/c.ts", "packages/core/src/d.ts",
		}},
		{Label: "docs", Size: 5, DominantLayer: "support", Members: []string{
			"docs/readme.md", "docs/CHANGELOG.md",
		}},
		{Label: "empty-members", Size: 1, DominantLayer: "support", Members: []string{}},
		{Label: "c3", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x3.ts"}},
		{Label: "c4", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x4.ts"}},
		{Label: "c5", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x5.ts"}},
		{Label: "c6", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x6.ts"}},
		{Label: "c7", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x7.ts"}},
		{Label: "c8", Size: 2, DominantLayer: "application", Members: []string{"packages/app/src/x8.ts"}},
	}

	m.Hotspots.GodNodes = []model.GodNode{
		{Path: "packages/core/src/index.ts", InDegree: 144, OutDegree: 0, Reason: "144 dependents · 0 deps"},
		{Path: "packages/app/src/mod1.ts", InDegree: 139, OutDegree: 1, Reason: "139 dependents · 1 deps"},
		{Path: "packages/app/src/mod2.ts", InDegree: 134, OutDegree: 2, Reason: "134 dependents · 2 deps"},
		{Path: "packages/app/src/mod3.ts", InDegree: 129, OutDegree: 3, Reason: "129 dependents · 3 deps"},
		{Path: "packages/app/src/mod4.ts", InDegree: 124, OutDegree: 4, Reason: "124 dependents · 4 deps"},
		{Path: "packages/app/src/mod5.ts", InDegree: 119, OutDegree: 5, Reason: "119 dependents · 5 deps"},
		{Path: "packages/app/src/mod6.ts", InDegree: 114, OutDegree: 6, Reason: "114 dependents · 6 deps"},
		{Path: "packages/app/src/mod7.ts", InDegree: 109, OutDegree: 7, Reason: "109 dependents · 7 deps"},
		{Path: "packages/app/src/mod8.ts", InDegree: 104, OutDegree: 8, Reason: "104 dependents · 8 deps"},
	}

	m.SurprisingConnections = []model.SurprisingConnection{
		{From: "packages/app/src/foo.ts", To: "packages/core/src/bar.ts", Reason: "cross-group", Score: 3, SampleSymbols: []string{}},
		{From: "packages/app/src/f1.ts", To: "packages/core/src/b1.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym1"}},
		{From: "packages/app/src/f2.ts", To: "packages/core/src/b2.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym2"}},
		{From: "packages/app/src/f3.ts", To: "packages/core/src/b3.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym3"}},
		{From: "packages/app/src/f4.ts", To: "packages/core/src/b4.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym4"}},
		{From: "packages/app/src/f5.ts", To: "packages/core/src/b5.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym5"}},
		{From: "packages/app/src/f6.ts", To: "packages/core/src/b6.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym6"}},
		{From: "packages/app/src/f7.ts", To: "packages/core/src/b7.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym7"}},
		{From: "packages/app/src/f8.ts", To: "packages/core/src/b8.ts", Reason: "infrastructure→application (outward)", Score: 2, SampleSymbols: []string{"Sym8"}},
		{From: "packages/app/src/f9.ts", To: "packages/core/src/b9.ts", Reason: "cross-group", Score: 2, SampleSymbols: []string{}},
		// 11th entry: excluded from the rendered section (cap 10) but its
		// "bridge" reason must still drive suggested-question #2.
		{From: "packages/app/src/loader.ts", To: "packages/core/src/registry.ts", Reason: "bridge, cross-group", Score: 5, SampleSymbols: []string{"Loader", "Registry", "Init", "Extra"}},
	}

	m.RationaleIndex = []model.RationaleEntry{
		{Tag: "NOTE", File: "packages/core/src/index.ts", Line: 1, Text: "something"},
		{Tag: "SECURITY", File: "packages/core/src/sec0.ts", Line: 1, Text: "security note 0"},
		{Tag: "SECURITY", File: "packages/core/src/sec1.ts", Line: 2, Text: "security note 1"},
		{Tag: "SECURITY", File: "packages/core/src/sec2.ts", Line: 3, Text: "security note 2"},
		{Tag: "SECURITY", File: "packages/core/src/sec3.ts", Line: 4, Text: "security note 3"},
		{Tag: "SECURITY", File: "packages/core/src/sec4.ts", Line: 5, Text: "security note 4"},
		{Tag: "SECURITY", File: "packages/core/src/sec5.ts", Line: 6, Text: "security note 5"},
		{Tag: "SECURITY", File: "packages/core/src/sec6.ts", Line: 7, Text: "security note 6"},
		{Tag: "SECURITY", File: "packages/core/src/sec7.ts", Line: 8, Text: "security note 7"},
		{Tag: "SECURITY", File: "packages/core/src/sec8.ts", Line: 9, Text: "security note 8"},
		{Tag: "SECURITY", File: "packages/core/src/sec9.ts", Line: 10, Text: "security note 9"},
		{Tag: "SECURITY", File: "packages/core/src/sec10.ts", Line: 11, Text: "security note 10"},
		{Tag: "SECURITY", File: "packages/core/src/sec11.ts", Line: 12, Text: "security note 11"},
		// 14th entry (13th qualifying tag), past the highlights cap (12) —
		// must still surface via suggested-question #3.
		{Tag: "HACK", File: "packages/app/src/hack.ts", Line: 99, Text: "TODO: refactor this hack thoroughly"},
	}

	return m
}

// buildEmptyMap is the all-empty edge case: zero clusters, zero godNodes,
// zero surprisingConnections, zero rationaleIndex, zero assets, no
// languages. Exercises the zero-cluster double-blank-line quirk, the
// always-emitted God-nodes header-only table, the two conditional sections
// being fully absent, and the fallback suggested-question line.
func buildEmptyMap() *model.Map {
	m := model.NewMap()
	m.Root = "fixture-empty"
	return m
}

func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return b
}

func TestRender_FullGolden(t *testing.T) {
	got := Render(buildFullMap())
	want := readGolden(t, "full.GRAPH_REPORT.md")
	if !bytes.Equal(got, want) {
		diffAt := firstDiff(got, want)
		t.Fatalf("Render() mismatch at byte %d\n--- got ---\n%s\n--- want ---\n%s", diffAt, got, want)
	}
}

func TestRender_EmptyGolden(t *testing.T) {
	got := Render(buildEmptyMap())
	want := readGolden(t, "empty.GRAPH_REPORT.md")
	if !bytes.Equal(got, want) {
		diffAt := firstDiff(got, want)
		t.Fatalf("Render() mismatch at byte %d\n--- got ---\n%s\n--- want ---\n%s", diffAt, got, want)
	}
}

func firstDiff(a, b []byte) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

// TestRender_Determinism renders the same map twice and asserts byte
// identity — the git-churn gate this phase must satisfy.
func TestRender_Determinism(t *testing.T) {
	m := buildFullMap()
	a := Render(m)
	b := Render(m)
	if !bytes.Equal(a, b) {
		t.Fatalf("Render() is not deterministic across two calls on the same map")
	}

	m2 := buildEmptyMap()
	c := Render(m2)
	d := Render(m2)
	if !bytes.Equal(c, d) {
		t.Fatalf("Render() is not deterministic across two calls on the same (empty) map")
	}
}

// TestRender_TrailingNewline asserts the single-trailing-\n contract (A1):
// the last L.push(..., "") supplies exactly one trailing "\n", never zero,
// never two.
func TestRender_TrailingNewline(t *testing.T) {
	for _, m := range []*model.Map{buildFullMap(), buildEmptyMap()} {
		got := Render(m)
		if len(got) == 0 || got[len(got)-1] != '\n' {
			t.Fatalf("Render() must end with exactly one trailing newline, got suffix %q", tail(got, 5))
		}
		if len(got) >= 2 && got[len(got)-2] == '\n' {
			t.Fatalf("Render() ended with two trailing newlines, want exactly one; suffix %q", tail(got, 5))
		}
	}
}

func tail(b []byte, n int) []byte {
	if len(b) <= n {
		return b
	}
	return b[len(b)-n:]
}

// TestRender_AssetsZero_NoParenthetical checks A6: assets.total == 0 omits
// the "(+N non-code files)" parenthetical entirely (not "(+0 ...)").
func TestRender_AssetsZero_NoParenthetical(t *testing.T) {
	m := model.NewMap()
	m.Root = "r"
	m.Stats.Files = 5
	m.Assets.Total = 0
	got := string(Render(m))
	if bytes.Contains([]byte(got), []byte("non-code files")) {
		t.Fatalf("expected no non-code-files parenthetical when assets.total == 0, got: %s", got)
	}
	if !bytes.Contains([]byte(got), []byte("5 code modules ·")) {
		t.Fatalf("expected '5 code modules ·' immediately (no parenthetical), got: %s", got)
	}
}

// TestRender_LanguagesEmpty_NA checks A5's empty fallback in isolation from
// the full empty-map golden.
func TestRender_LanguagesEmpty_NA(t *testing.T) {
	m := model.NewMap()
	m.Root = "r"
	got := string(Render(m))
	if !bytes.Contains([]byte(got), []byte("Languages: n/a.")) {
		t.Fatalf("expected 'Languages: n/a.' line, got: %s", got)
	}
}

// TestRender_QuestionsPartial covers the case where only ONE of the four
// question probes matches (godNodes present, no bridge, no rationale, no
// clusters) — the fallback line must NOT appear (fallback is only for the
// zero-match case).
func TestRender_QuestionsPartial(t *testing.T) {
	m := model.NewMap()
	m.Root = "r"
	m.Hotspots.GodNodes = []model.GodNode{
		{Path: "a/b/c.ts", InDegree: 7, OutDegree: 0, Reason: "7 dependents · 0 deps"},
	}
	lines := questionLines(t, m)
	want := []string{"- Why does `a/b/c.ts` have 7 dependents — is that coupling intended?"}
	if len(lines) != len(want) || lines[0] != want[0] {
		t.Fatalf("suggested questions = %#v, want %#v", lines, want)
	}
}

// questionLines extracts the "- ..." lines under "## Suggested questions"
// from a rendered report.
func questionLines(t *testing.T, m *model.Map) []string {
	t.Helper()
	out := string(Render(m))
	const marker = "## Suggested questions\n\n"
	idx := indexOf(out, marker)
	if idx < 0 {
		t.Fatalf("no '## Suggested questions' section found in: %s", out)
	}
	rest := out[idx+len(marker):]
	end := indexOf(rest, "\n\n---")
	if end < 0 {
		t.Fatalf("no trailing '---' after suggested questions in: %s", out)
	}
	block := rest[:end]
	return splitLines(block)
}

func indexOf(s, sub string) int {
	return bytes.Index([]byte(s), []byte(sub))
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func TestWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "GRAPH_REPORT.md")
	m := buildFullMap()

	if err := Write(path, m); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after Write: %v", err)
	}
	want := Render(m)
	if !bytes.Equal(got, want) {
		t.Fatalf("written file does not match Render() output")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("Write() file mode = %o, want 0644", perm)
	}
}

// ---- helper-level unit tests ----------------------------------------

func TestTopLanguages(t *testing.T) {
	oc := model.NewOrderedCounts()
	for _, kv := range []struct {
		k string
		v int
	}{
		{"typescript", 10}, {"other", 99}, {"markdown", 5}, {"json", 4},
		{"go", 3}, {"javascript", 2}, {"shell", 2}, {"python", 1},
	} {
		oc.Add(kv.k, kv.v)
	}
	got := topLanguages(oc)
	want := "typescript 10, markdown 5, json 4, go 3, javascript 2, shell 2"
	if got != want {
		t.Fatalf("topLanguages() = %q, want %q", got, want)
	}
}

func TestTopLanguages_Empty(t *testing.T) {
	if got := topLanguages(model.NewOrderedCounts()); got != "n/a" {
		t.Fatalf("topLanguages(empty) = %q, want n/a", got)
	}
	if got := topLanguages(nil); got != "n/a" {
		t.Fatalf("topLanguages(nil) = %q, want n/a", got)
	}
}

func TestClusterMembers_FiltersToCodeExtensions(t *testing.T) {
	got := clusterMembers([]string{
		"docs/readme.md", "packages/core/src/a.ts", "packages/core/src/b.ts",
		"packages/core/src/c.ts", "packages/core/src/d.ts",
	})
	want := "`src/a.ts`, `src/b.ts`, `src/c.ts`, `src/d.ts`"
	if got != want {
		t.Fatalf("clusterMembers() = %q, want %q", got, want)
	}
}

func TestClusterMembers_FallsBackWhenNoCodeFiles(t *testing.T) {
	got := clusterMembers([]string{"docs/readme.md", "docs/CHANGELOG.md"})
	want := "`docs/readme.md`, `docs/CHANGELOG.md`"
	if got != want {
		t.Fatalf("clusterMembers() = %q, want %q", got, want)
	}
}

func TestClusterMembers_Empty(t *testing.T) {
	if got := clusterMembers(nil); got != "" {
		t.Fatalf("clusterMembers(nil) = %q, want empty", got)
	}
	if got := clusterMembers([]string{}); got != "" {
		t.Fatalf("clusterMembers([]) = %q, want empty", got)
	}
}

func TestCommaGroup(t *testing.T) {
	cases := map[int]string{
		0: "0", 5: "5", 999: "999", 1000: "1,000", 12345: "12,345",
		326932: "326,932", -12345: "-12,345",
	}
	for n, want := range cases {
		if got := commaGroup(n); got != want {
			t.Fatalf("commaGroup(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestJSNumber(t *testing.T) {
	cases := map[float64]string{
		4: "4", 3: "3", 0: "0", 58.5: "58.5", -2: "-2",
	}
	for f, want := range cases {
		if got := jsNumber(f); got != want {
			t.Fatalf("jsNumber(%v) = %q, want %q", f, got, want)
		}
	}
}
