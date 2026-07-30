package rank

import "github.com/draht-dev/draht/go/internal/model"

// Degrees holds the NON-TEST import-edge degree maps that feed the
// hotspot rankers (draht-tools.cjs:2374-2382). Only edges whose Kind is
// "import" are counted (re-export and external edges are excluded), and
// duplicate edges are NOT deduplicated — the same from->to pair counted
// twice increments the degree twice.
type Degrees struct {
	In  map[string]int
	Out map[string]int
}

// NonTestDegrees builds Degrees from modules and edges. An edge is skipped
// when its FROM module is a test file (fm.IsTest); an edge whose FROM id
// does not resolve to any module in modules is still counted (mirrors the
// CJS `if (fm && fm.isTest) continue;` guard, which only skips on a
// positive test match, never on an unresolved lookup).
func NonTestDegrees(modules []model.Module, edges []model.Edge) Degrees {
	isTest := make(map[string]bool, len(modules))
	for _, m := range modules {
		isTest[m.ID] = m.IsTest
	}

	in := make(map[string]int)
	out := make(map[string]int)
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		if isTest[e.From] {
			continue
		}
		out[e.From]++
		in[e.To]++
	}
	return Degrees{In: in, Out: out}
}
