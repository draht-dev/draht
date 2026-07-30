package cluster

import (
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// LayerRankInward mirrors LAYER_RANK_INWARD (cjs:2029-2030). "support" is
// deliberately absent — the layer-violation rule is skipped for support
// modules (a missing map entry mirrors JS `undefined`).
var LayerRankInward = map[string]int{
	model.LayerPresentation:   0,
	model.LayerApplication:    1,
	model.LayerDomain:         2,
	model.LayerInfrastructure: 3,
}

// Surprising mirrors visComputeSurprising (cjs:2029-2063). It MUST be
// called with edges built in modules-ASC x parsedImports order and
// callEdges built in their own natural insertion order — the tie-break on
// (score, from) is intentionally incomplete in the reference implementation
// (no tie-break on `to`), so a stable sort over candidates appended in
// `edges` order is required to reproduce it byte-for-byte. sort.SliceStable
// is used for exactly this reason; sort.Slice would silently scramble ties.
func Surprising(
	modules []model.Module,
	edges []model.Edge,
	callEdges []model.CallEdge,
	clusterOf map[string]string,
	groupOfContainer map[string]string,
) []model.SurprisingConnection {
	moduleByID := make(map[string]*model.Module, len(modules))
	for i := range modules {
		moduleByID[modules[i].ID] = &modules[i]
	}

	// Directional cross-cluster import-edge counts, keyed "ca|cb".
	pairCount := make(map[string]int)
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		ca, okA := clusterOf[e.From]
		cb, okB := clusterOf[e.To]
		if !okA || !okB || ca == cb {
			continue
		}
		pairCount[ca+"|"+cb]++
	}

	// Up to 4 distinct call symbols per "from|to" module pair, in
	// callEdges insertion order.
	callSym := make(map[string][]string)
	for _, ce := range callEdges {
		key := ce.From + "|" + ce.To
		syms := callSym[key]
		if len(syms) >= 4 || containsString(syms, ce.Symbol) {
			continue
		}
		callSym[key] = append(syms, ce.Symbol)
	}

	var out []model.SurprisingConnection
	seen := make(map[string]struct{})
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		a := moduleByID[e.From]
		b := moduleByID[e.To]
		if a == nil || b == nil {
			continue
		}
		ca, okA := clusterOf[e.From]
		cb, okB := clusterOf[e.To]
		if !okA || !okB || ca == cb {
			continue
		}

		pk := e.From + "→" + e.To
		if _, dup := seen[pk]; dup {
			continue
		}
		seen[pk] = struct{}{}

		score := 0
		var reasons []string

		if la, okLa := LayerRankInward[a.Layer]; okLa {
			if lb, okLb := LayerRankInward[b.Layer]; okLb && la > lb {
				score += 2
				reasons = append(reasons, a.Layer+"→"+b.Layer+" (outward)")
			}
		}
		if pairCount[ca+"|"+cb] <= 1 {
			score += 2
			reasons = append(reasons, "bridge")
		}
		ga, okGa := groupOfContainer[ContainerOf(a)]
		gb, okGb := groupOfContainer[ContainerOf(b)]
		if okGa && okGb && ga != gb {
			score += 1
			reasons = append(reasons, "cross-group")
		}
		if score <= 0 {
			continue
		}

		samples := callSym[e.From+"|"+e.To]
		if samples == nil {
			samples = []string{}
		}

		out = append(out, model.SurprisingConnection{
			From:          e.From,
			To:            e.To,
			Score:         float64(score),
			Reason:        strings.Join(reasons, ", "),
			SampleSymbols: samples,
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].From < out[j].From
	})

	if len(out) > SurprisingCap {
		out = out[:SurprisingCap]
	}
	return out
}

func containsString(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
