// Package emit ports visWriteOutputs' handling of the two artifacts derived
// from a built *model.Map: GRAPH_REPORT.md and MAP.html (draht-tools.cjs
// 5098-5124).
//
// MAP.json itself is NOT written here. graph.Build (internal/graph) already
// writes MAP.json via model.WriteIfChanged as part of assembling the map —
// several of that package's own tests (cancelled-context-does-not-write,
// warm-cache byte-identity, the golden fixture test) depend on that write
// happening as a side effect of Build, so Phase 3 does not relocate it.
// Because of that, WriteOutputs takes the caller's already-computed
// "did MAP.json change" boolean (graph.Report.Changed) as jsonChanged,
// rather than recomputing it: if this package re-read the MAP.json file
// after graph.Build had just written it, the comparison would always see
// "unchanged" (the file already matches m) and GRAPH_REPORT.md would never
// regenerate on the very build that changed the data.
package emit

import (
	"path/filepath"

	"github.com/draht-dev/draht/go/internal/htmlview"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/report"
)

// Result mirrors visWriteOutputs' return value.
type Result struct {
	JSONPath   string
	HTMLPath   string
	ReportPath string
	// Unchanged is the negation of the jsonChanged argument passed to
	// WriteOutputs, kept here so callers can print e.g. "Wrote:" vs
	// "Unchanged:" without re-threading the original bool.
	Unchanged bool
}

// WriteOutputs writes GRAPH_REPORT.md when jsonChanged (cjs: `if
// (!unchanged) { ...; fs.writeFileSync(reportPath, ...) }`), and writes
// MAP.html unconditionally unless quiet (cjs: `if (!opts.quiet)
// fs.writeFileSync(htmlPath, ...)`) — MAP.html is a derived view artifact,
// not the git-committed source of truth, so it is always refreshed on a
// full build regardless of whether the underlying graph data changed. A
// deleted GRAPH_REPORT.md with an unchanged MAP.json is deliberately NOT
// regenerated; do not "fix" this.
func WriteOutputs(outDir string, m *model.Map, jsonChanged bool, quiet bool) (Result, error) {
	res := Result{
		JSONPath:   filepath.Join(outDir, "MAP.json"),
		HTMLPath:   filepath.Join(outDir, "MAP.html"),
		ReportPath: filepath.Join(outDir, "GRAPH_REPORT.md"),
		Unchanged:  !jsonChanged,
	}

	if jsonChanged {
		if err := report.Write(res.ReportPath, m); err != nil {
			return res, err
		}
	}

	if !quiet {
		if err := htmlview.Write(res.HTMLPath, res.JSONPath, m); err != nil {
			return res, err
		}
	}

	return res, nil
}
