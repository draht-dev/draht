package query

import (
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// ImportAdj is graphImportAdj's return value: forward/reverse adjacency
// over import + re-export edges (external edges are excluded). Values are
// deduped, insertion-ordered by first appearance in map.edges — this is the
// order graph-context's importers/imports lists and graph-impact's BFS
// depend on, so it must never be re-sorted.
type ImportAdj struct {
	Fwd map[string][]string
	Rev map[string][]string
}

// BuildImportAdj ports graphImportAdj (draht-tools.cjs:5375-5384). Barrels
// re-export their internals, so import + re-export are both treated as real
// structural dependency edges here; graph-callers/graph-callees use a
// DIFFERENT adjacency (import edges only — see buildCallAdj in calldir.go),
// which is why the same file can report different importer counts from
// graph-context vs graph-callers. Do not unify the two.
func BuildImportAdj(m *model.Map) *ImportAdj {
	fwd := map[string][]string{}
	rev := map[string][]string{}
	for _, e := range m.Edges {
		if e.Kind != "import" && e.Kind != "re-export" {
			continue
		}
		if !containsStr(fwd[e.From], e.To) {
			fwd[e.From] = append(fwd[e.From], e.To)
		}
		if !containsStr(rev[e.To], e.From) {
			rev[e.To] = append(rev[e.To], e.From)
		}
	}
	return &ImportAdj{Fwd: fwd, Rev: rev}
}

func containsStr(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// Short ports graphShort: the last two "/"-delimited path segments (a
// 1-segment path yields itself unchanged).
func Short(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) <= 2 {
		return p
	}
	return strings.Join(parts[len(parts)-2:], "/")
}
