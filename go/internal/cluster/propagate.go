package cluster

import "sort"

// MaxPasses is the hard-coded pass cap inside visPropagateLabels (cjs:1884).
const MaxPasses = 10

// PropagateLabels mirrors visPropagateLabels (cjs:1884-1904) exactly:
// sequential, in-place ("asynchronous") label propagation over `ids` sorted
// ascending, capped at MaxPasses passes, hub votes suppressed (hubs receive
// labels but never broadcast their own), ties broken by (count DESC, label
// ASC).
//
// Propagation is sequential, not synchronous: a module visited later in the
// same pass sees neighbours' labels as already updated earlier in that same
// pass. Visit order is `ids` sorted ascending — this is load-bearing for
// parity and must not be changed to, e.g., map iteration order.
//
// The per-node argmax (count DESC, label ASC) is computed with a plain Go
// map and a running-best fold. This is provably independent of Go's random
// map iteration order: the fold's comparator (`c > bestC || (c == bestC &&
// l < best)`) always keeps the true best-so-far candidate regardless of
// processing order, because it is a strict total order over (count, label)
// pairs and bestC starts at -1 (guaranteeing the first entry processed
// always wins the initial comparison). No insertion-order emulation is
// needed.
func PropagateLabels(ids []string, adj Adjacency, hubs map[string]struct{}, seedOf func(string) string) map[string]string {
	sortedIDs := append([]string(nil), ids...)
	sort.Strings(sortedIDs)

	label := make(map[string]string, len(sortedIDs))
	for _, id := range sortedIDs {
		label[id] = seedOf(id)
	}

	for pass := 0; pass < MaxPasses; pass++ {
		changed := false
		for _, id := range sortedIDs {
			nbrs := adj[id]
			if len(nbrs) == 0 {
				continue
			}

			freq := make(map[string]int)
			for n := range nbrs {
				l, ok := label[n]
				if !ok {
					// Neighbour outside this subgraph (recursive split).
					continue
				}
				if _, isHub := hubs[n]; isHub {
					// Hubs receive labels but never broadcast their own.
					continue
				}
				freq[l]++
			}
			if len(freq) == 0 {
				continue
			}

			best := label[id]
			bestC := -1
			for l, c := range freq {
				if c > bestC || (c == bestC && l < best) {
					best = l
					bestC = c
				}
			}
			if best != label[id] {
				label[id] = best
				changed = true
			}
		}
		if !changed {
			break
		}
	}

	return label
}
