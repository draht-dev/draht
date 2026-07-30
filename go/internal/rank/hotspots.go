package rank

import (
	"fmt"
	"math"
	"sort"

	"github.com/draht-dev/draht/go/internal/model"
)

// HotspotCap is the per-list cap applied by List (draht-tools.cjs
// rankHotspots' `.slice(0, 15)`).
const HotspotCap = 15

// List is the generic hotspot ranker (draht-tools.cjs rankHotspots,
// line ~2912). It filters out test modules, scores every remaining module
// with metric, formats a reason string with reason, sorts by score DESC
// then id ASC (a full, order-independent tie-break — no stable sort is
// required), and caps the result at HotspotCap.
//
// metric and reason both receive (inDegree, outDegree, loc) for the
// module being scored.
func List(
	modules []model.Module,
	d Degrees,
	metric func(in, out, loc int) float64,
	reason func(in, out, loc int) string,
) []model.GodNode {
	arr := make([]model.GodNode, 0, len(modules))
	for _, m := range modules {
		if m.IsTest {
			continue
		}
		in := d.In[m.ID]
		out := d.Out[m.ID]
		loc := m.Loc
		arr = append(arr, model.GodNode{
			ID:        m.ID,
			Path:      m.Path,
			Package:   m.Package,
			InDegree:  in,
			OutDegree: out,
			Loc:       loc,
			Score:     model.ToFixed2(metric(in, out, loc)),
			Reason:    reason(in, out, loc),
		})
	}

	sort.Slice(arr, func(i, j int) bool {
		if arr[i].Score != arr[j].Score {
			return arr[i].Score > arr[j].Score
		}
		return arr[i].ID < arr[j].ID
	})

	if len(arr) > HotspotCap {
		arr = arr[:HotspotCap]
	}
	return arr
}

// Hotspots builds all four ranked lists with the reference formulas and
// reason strings (draht-tools.cjs rankHotspots call sites, line ~2916).
//
//   - godNodes:       score = inDeg*2 + outDeg + log2(1+loc)
//   - mostDependedOn: score = inDeg
//   - orchestrators:  score = outDeg
//   - largest:        score = loc
//
// The godNodes reason string uses U+00B7 MIDDLE DOT with a surrounding
// ASCII space on each side; this is load-bearing byte-for-byte parity, not
// a stylistic choice.
func Hotspots(modules []model.Module, d Degrees) model.Hotspots {
	return model.Hotspots{
		GodNodes: List(modules, d,
			func(in, out, loc int) float64 {
				return float64(in)*2 + float64(out) + math.Log2(1+float64(loc))
			},
			func(in, out, _ int) string {
				return fmt.Sprintf("%d dependents · %d deps", in, out)
			},
		),
		MostDependedOn: List(modules, d,
			func(in, _, _ int) float64 { return float64(in) },
			func(in, _, _ int) string { return fmt.Sprintf("%d dependents", in) },
		),
		Orchestrators: List(modules, d,
			func(_, out, _ int) float64 { return float64(out) },
			func(_, out, _ int) string { return fmt.Sprintf("imports %d modules", out) },
		),
		Largest: List(modules, d,
			func(_, _, loc int) float64 { return float64(loc) },
			func(_, _, loc int) string { return fmt.Sprintf("%d LOC", loc) },
		),
	}
}
