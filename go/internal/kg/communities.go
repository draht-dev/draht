package kg

import (
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Communities — deterministic LPA + graphify cluster.py post-processing
// ---------------------------------------------------------------------------

func computeCommunities(nodes []*Node, edges []*Edge) (communityOf map[string]int, communities []*Community) {
	adj := newOMap[string, *OSet[string]]()
	for _, n := range nodes {
		adj.Set(n.ID, newOSet[string]())
	}
	for _, e := range edges {
		if e.Source == e.Target {
			continue
		}
		adj.G(e.Source).Add(e.Target)
		adj.G(e.Target).Add(e.Source)
	}
	ids := make([]string, len(nodes)) // already sorted
	for i, n := range nodes {
		ids[i] = n.ID
	}
	// The neighbour lists in insertion order (the iteration order of each Set).
	nbrsOf := make(map[string][]string, len(ids))
	for _, id := range ids {
		nbrsOf[id] = adj.G(id).Items()
	}
	label := make(map[string]string, len(ids))
	for _, id := range ids {
		label[id] = id
	}
	for pass := 0; pass < 10; pass++ {
		changed := false
		for _, id := range ids {
			nbrs := nbrsOf[id]
			if len(nbrs) == 0 {
				continue
			}
			counts := make(map[string]int, len(nbrs))
			for _, nb := range nbrs {
				counts[label[nb]]++
			}
			// JS: entries sorted by label, the first highest count wins — the
			// smallest label among the highest counts.
			best, bestC := "", -1
			for _, nb := range nbrs {
				l := label[nb]
				c := counts[l]
				if c > bestC || (c == bestC && l < best) {
					best, bestC = l, c
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
	groups := newOMap[string, []string]()
	for _, id := range ids {
		l := label[id]
		groups.Set(l, append(groups.G(l), id))
	}
	// graphify: oversized (>25% of graph, min 10) and low-cohesion (<0.05, >=50)
	// communities are re-split. Splitter: two-level source-dir prefix (deterministic).
	nodeByID := make(map[string]*Node, len(nodes))
	for _, n := range nodes {
		nodeByID[n.ID] = n
	}
	intraEdges := func(members []string) int {
		s := make(map[string]bool, len(members))
		for _, id := range members {
			s[id] = true
		}
		c := 0
		for _, id := range members {
			for _, nb := range nbrsOf[id] {
				if s[nb] && id < nb {
					c++
				}
			}
		}
		return c
	}
	cohesion := func(members []string) float64 {
		n := len(members)
		if n < 2 {
			return 0
		}
		return float64(intraEdges(members)) / (float64(n*(n-1)) / 2)
	}
	// In a monorepo a 2-segment prefix is just "packages/<pkg>", which can still be
	// a third of the graph — recurse deeper (up to 6 segments) until no subgroup
	// stays oversized. Deterministic: prefix-sorted, fixed depth cap.
	total := len(nodes)
	if total == 0 {
		total = 1
	}
	oversized := func(members []string) bool {
		return float64(len(members)) > float64(total)*0.25 && len(members) >= 10
	}
	var splitByDir func(members []string, depth int) [][]string
	splitByDir = func(members []string, depth int) [][]string {
		if depth > 6 {
			return [][]string{members}
		}
		sub := newOMap[string, []string]()
		for _, id := range members {
			src := nodeByID[id].SourceFile
			if src == "" {
				src = "(external)"
			}
			segs := strings.Split(src, "/")
			if len(segs) > depth {
				segs = segs[:depth]
			}
			key := strings.Join(segs, "/")
			sub.Set(key, append(sub.G(key), id))
		}
		if sub.Len() == 1 {
			return splitByDir(members, depth+1)
		}
		keys := sub.Keys()
		sort.SliceStable(keys, func(i, j int) bool { return keys[i] < keys[j] })
		var out [][]string
		for _, k := range keys {
			v := sub.G(k)
			if oversized(v) {
				out = append(out, splitByDir(v, depth+1)...)
			} else {
				out = append(out, v)
			}
		}
		return out
	}
	var finalGroups [][]string
	for _, members := range groups.Values() {
		if oversized(members) || (len(members) >= 50 && cohesion(members) < 0.05) {
			finalGroups = append(finalGroups, splitByDir(members, 2)...)
		} else {
			finalGroups = append(finalGroups, members)
		}
	}
	// re-index by size desc, tiebreak on sorted member tuple (cluster.py)
	for i, m := range finalGroups {
		c := append([]string(nil), m...)
		sort.Strings(c)
		finalGroups[i] = c
	}
	sort.SliceStable(finalGroups, func(i, j int) bool {
		a, b := finalGroups[i], finalGroups[j]
		if len(a) != len(b) {
			return len(a) > len(b)
		}
		return a[0] < b[0]
	})
	communityOf = make(map[string]int, len(ids))
	degree := make(map[string]int, len(ids))
	for _, id := range ids {
		degree[id] = len(nbrsOf[id])
	}
	communities = make([]*Community, 0, len(finalGroups))
	for idx, members := range finalGroups {
		for _, id := range members {
			communityOf[id] = idx
		}
		// hub label: highest-degree member (label_communities_by_hub), lexicographic tiebreak
		hub := members[0]
		for _, id := range members {
			if degree[id] > degree[hub] || (degree[id] == degree[hub] && id < hub) {
				hub = id
			}
		}
		// +cohesion(members).toFixed(4)
		coh, _ := strconv.ParseFloat(jsToFixed(cohesion(members), 4), 64)
		communities = append(communities, &Community{
			ID:       idx,
			Name:     nodeByID[hub].Label,
			Size:     len(members),
			Cohesion: coh,
			Members:  members,
		})
	}
	return communityOf, communities
}
