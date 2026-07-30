package query

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// goldenMapJSONGz is the frozen MAP.json that every golden fixture in this
// package was captured against. Freezing the input is what makes the goldens
// meaningful: both engines are fed these exact bytes, so a stdout diff isolates
// a rendering difference rather than a graph-data difference.
//
// It is stored gzipped because the raw JSON is 5.6 MiB — committing that
// uncompressed would cost every clone of this monorepo permanently, for a file
// no human reads. gzip -9 takes it to 0.4 MiB and compress/gzip is stdlib, so
// the only price is the few milliseconds of decompression below.
//
// To regenerate: see the capture instructions further down in this file, then
// `gzip -9 -c testdata/MAP.json > testdata/MAP.json.gz && rm testdata/MAP.json`.
//
//go:embed testdata/MAP.json.gz
var goldenMapJSONGz []byte

// loadGoldenMap decompresses and parses the frozen testdata/MAP.json.gz.
// Each test gets its own unmarshal since Map isn't deep-copied between calls;
// modules is what matters and Resolve/etc. don't mutate the map.
func loadGoldenMap(t testing.TB) *model.Map {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(goldenMapJSONGz))
	if err != nil {
		t.Fatalf("open testdata/MAP.json.gz: %v", err)
	}
	defer zr.Close()
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("decompress testdata/MAP.json.gz: %v", err)
	}
	var m model.Map
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal testdata/MAP.json: %v", err)
	}
	return &m
}

func mustReadGolden(t testing.TB, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "golden", name+".txt"))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return string(b)
}

// dispatch mirrors the eventual CLI dispatcher's switch, kept local to the
// test so this package has no dependency on cmd/.
func dispatch(m *model.Map, cmd string, argv []string, w *bytes.Buffer) int {
	switch cmd {
	case "graph-context":
		return Context(m, argv, w)
	case "graph-impact":
		return Impact(m, argv, w)
	case "graph-callers":
		return Callers(m, argv, w)
	case "graph-callees":
		return Callees(m, argv, w)
	case "graph-path":
		return Path(m, argv, w)
	case "graph-query":
		return Query(m, argv, w)
	case "graph-hotspots":
		return Hotspots(m, argv, w)
	case "graph-clusters":
		return Clusters(m, argv, w)
	}
	panic("dispatch: unknown command " + cmd)
}

type goldenCase struct {
	name string
	cmd  string
	argv []string
}

// goldenCases is the exhaustive fixture set captured from the live CJS
// engine (packages/draht-tools/bin/draht-tools.cjs) against a frozen copy of
// this repo's own MAP.json — see testdata/MAP.json and the capture
// transcript in the phase-3 C-query spec. Every case here was regenerated
// and diffed against the spec's verbatim captures before being committed.
var goldenCases = []goldenCase{
	{"hotspots", "graph-hotspots", nil},
	{"hotspots_limit2", "graph-hotspots", []string{"--limit", "2"}},
	{"hotspots_limit0", "graph-hotspots", []string{"--limit", "0"}},
	{"hotspots_json", "graph-hotspots", []string{"--json"}},

	{"clusters", "graph-clusters", nil},
	{"clusters_surprising", "graph-clusters", []string{"--surprising"}},
	{"clusters_json", "graph-clusters", []string{"--json"}},
	{"clusters_surp_json", "graph-clusters", []string{"--surprising", "--json"}},

	{"context_index", "graph-context", []string{"packages/ai/src/index.ts"}},
	{"context_types", "graph-context", []string{"packages/ai/src/types.ts"}},
	{"context_dotslash", "graph-context", []string{"./packages/ai/src/types.ts"}},
	{"context_sinks", "graph-context", []string{"packages/agent/src/harness/env/nodejs.ts"}},
	{"context_rationale", "graph-context", []string{"go/internal/graph/rationale.go"}},
	{"context_fuzzy_base", "graph-context", []string{"nodejs.ts"}},
	{"context_fuzzy_ambig", "graph-context", []string{"types.ts"}},
	{"context_fuzzy_dir", "graph-context", []string{"packages/ai"}},
	{"context_abs", "graph-context", []string{"/srv/work/draht/draht-mono/.claude/worktrees/draht-graph-go/packages/ai/src/types.ts"}},
	{"context_multi", "graph-context", []string{"packages/ai/src/types.ts", "nope.ts", "packages/agent/src/harness/env/nodejs.ts"}},
	{"context_noargs", "graph-context", nil},
	{"context_missing", "graph-context", []string{"does/not/exist.ts"}},
	{"context_json", "graph-context", []string{"packages/agent/src/harness/env/nodejs.ts", "--json"}},

	{"impact_types", "graph-impact", []string{"packages/ai/src/types.ts"}},
	{"impact_small", "graph-impact", []string{"packages/agent/src/harness/env/nodejs.ts", "nope.ts"}},
	{"impact_isolated", "graph-impact", []string{"go/cmd/draht-tools/doc.go"}},
	{"impact_nomatch", "graph-impact", []string{"nope.ts"}},
	{"impact_noargs", "graph-impact", nil},
	{"impact_json", "graph-impact", []string{"packages/ai/src/types.ts", "--json"}},

	{"callers_types", "graph-callers", []string{"packages/ai/src/types.ts"}},
	{"callers_depth2", "graph-callers", []string{"packages/ai/src/models.ts", "--depth", "2"}},
	{"callers_depth0", "graph-callers", []string{"packages/agent/src/harness/env/nodejs.ts", "--depth", "0"}},
	{"callers_depthabc", "graph-callers", []string{"packages/agent/src/harness/env/nodejs.ts", "--depth", "abc"}},
	{"callers_fuzzy", "graph-callers", []string{"theme.ts"}},
	{"callers_isolated", "graph-callers", []string{"go/cmd/draht-tools/doc.go"}},
	{"callers_missing", "graph-callers", []string{"does/not/exist.ts"}},
	{"callers_noargs", "graph-callers", nil},
	{"callers_json", "graph-callers", []string{"packages/ai/src/types.ts", "--json"}},

	{"callees_empty", "graph-callees", []string{"packages/ai/src/index.ts"}},
	{"callees_depth2", "graph-callees", []string{"packages/coding-agent/src/core/sdk.ts", "--depth", "2"}},
	{"callees_noargs", "graph-callees", nil},

	{"path_forward", "graph-path", []string{"packages/coding-agent/src/index.ts", "packages/ai/src/types.ts"}},
	{"path_reverse", "graph-path", []string{"packages/ai/src/types.ts", "packages/coding-agent/src/index.ts"}},
	{"path_symbol", "graph-path", []string{"sdk.ts", "types.ts"}},
	{"path_none", "graph-path", []string{"go/cmd/draht-tools/doc.go", "packages/ai/src/types.ts"}},
	{"path_unresolvable", "graph-path", []string{"does/not/exist.ts", "packages/ai/src/types.ts"}},
	{"path_noargs", "graph-path", nil},

	{"query_compaction", "graph-query", []string{"compaction"}},
	{"query_multiterm", "graph-query", []string{"session", "token"}},
	{"query_uppercase", "graph-query", []string{"TYPES"}},
	{"query_nohits", "graph-query", []string{"zzzznotathing"}},
	{"query_shortterm", "graph-query", []string{"ab"}},
	{"query_noargs", "graph-query", nil},
	{"query_json", "graph-query", []string{"compaction", "--json"}},
}

func TestGolden(t *testing.T) {
	m := loadGoldenMap(t)
	for _, tc := range goldenCases {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			code := dispatch(m, tc.cmd, tc.argv, &buf)
			if code != 0 {
				t.Errorf("exit code = %d, want 0", code)
			}
			want := mustReadGolden(t, tc.name)
			got := buf.String()
			if got != want {
				firstDiff := -1
				n := len(got)
				if len(want) < n {
					n = len(want)
				}
				for i := 0; i < n; i++ {
					if got[i] != want[i] {
						firstDiff = i
						break
					}
				}
				if firstDiff == -1 {
					firstDiff = n
				}
				lo := firstDiff - 40
				if lo < 0 {
					lo = 0
				}
				gotHi := firstDiff + 40
				if gotHi > len(got) {
					gotHi = len(got)
				}
				wantHi := firstDiff + 40
				if wantHi > len(want) {
					wantHi = len(want)
				}
				t.Errorf("mismatch at byte %d (got len=%d, want len=%d)\n got: %q\nwant: %q",
					firstDiff, len(got), len(want), got[lo:gotHi], want[lo:wantHi])
			}
		})
	}
}

// TestNoMapMessage locks the exact literal every graph-* command must print
// (before argument validation — see load.go's doc comment) when no map is
// loadable.
func TestNoMapMessage(t *testing.T) {
	want := "no map — run `draht-tools map-graph` first.\n"
	var buf bytes.Buffer
	buf.WriteString(NoMapMessage + "\n")
	if buf.String() != want {
		t.Fatalf("NoMapMessage+\\n = %q, want %q", buf.String(), want)
	}
}
