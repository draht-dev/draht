package cluster

import (
	"sort"
	"strconv"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Constants mirroring the CJS clustering block (cjs:1851-1854).
const (
	// SeedDepth is CLUSTER_SEED_DEPTH: the directory-prefix depth used to
	// seed the first label-propagation pass.
	SeedDepth = 4
	// MaxShare is CLUSTER_MAX_SHARE: a group larger than total*MaxShare is
	// a candidate for recursive splitting.
	MaxShare = 0.25
	// MaxRecursion is CLUSTER_MAX_RECURSION: the oversize-split recursion
	// cap. At this depth an oversized group is returned unsplit (the cap
	// is best-effort, not guaranteed).
	MaxRecursion = 5
	// SurprisingCap is the cap on the surprisingConnections list.
	SurprisingCap = 20
)

// Cluster is the full 7-field clustering record. See the package doc for
// why this is a package-local type rather than model.Cluster.
type Cluster struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	Size            int      `json:"size"`
	Members         []string `json:"members"`
	DominantPackage *string  `json:"dominantPackage"`
	DominantLayer   string   `json:"dominantLayer"`
	Packages        []string `json:"packages"`
}

// ToModel converts a Cluster to the wire model.Cluster (now the full
// 7-field shape — see the integrator's note in the package doc).
func (c Cluster) ToModel() model.Cluster {
	return model.Cluster{
		ID:              c.ID,
		Label:           c.Label,
		Size:            c.Size,
		Members:         c.Members,
		DominantPackage: c.DominantPackage,
		DominantLayer:   c.DominantLayer,
		Packages:        c.Packages,
	}
}

// Result is the whole clustering output.
type Result struct {
	// Clusters is sorted size DESC, id ASC.
	Clusters []Cluster
	// ClusterOf maps module id -> cluster id; total over modules (every
	// module lands in exactly one cluster).
	ClusterOf map[string]string
}

// Compute is the pure port of visComputeClusters (cjs:1909-2027).
// Deterministic for identical input; performs no I/O and touches no global
// state.
func Compute(modules []model.Module, edges []model.Edge) Result {
	moduleByID := make(map[string]*model.Module, len(modules))
	ids := make([]string, 0, len(modules))
	for i := range modules {
		moduleByID[modules[i].ID] = &modules[i]
		ids = append(ids, modules[i].ID)
	}
	sort.Strings(ids)

	total := len(ids)
	if total == 0 {
		total = 1
	}

	adj := BuildAdjacency(modules, edges)
	hubs, _ := HubSet(ids, adj)

	seedAtDepth := func(depth int) func(string) string {
		return func(id string) string {
			s := Seed(id, depth)
			if s == "" {
				return ContainerOf(moduleByID[id])
			}
			return s
		}
	}

	// §1.6 first-level grouping.
	label := PropagateLabels(ids, adj, hubs, seedAtDepth(SeedDepth))
	byLabel := make(map[string][]string)
	for _, id := range ids {
		m := moduleByID[id]
		hasEdges := len(adj[id]) > 0
		var key string
		if hasEdges {
			key = label[id]
		} else {
			key = ContainerOf(m)
		}
		byLabel[key] = append(byLabel[key], id)
	}

	// §1.7 recursive oversize split.
	var splitOversized func(memberIDs []string, depth, recursion int) [][]string
	splitOversized = func(memberIDs []string, depth, recursion int) [][]string {
		if float64(len(memberIDs)) <= float64(total)*MaxShare || recursion >= MaxRecursion {
			sorted := append([]string(nil), memberIDs...)
			sort.Strings(sorted)
			return [][]string{sorted}
		}

		memberSet := make(map[string]struct{}, len(memberIDs))
		for _, id := range memberIDs {
			memberSet[id] = struct{}{}
		}
		subAdj := make(Adjacency)
		for _, id := range memberIDs {
			nbrs := adj[id]
			if len(nbrs) == 0 {
				continue
			}
			filtered := make(map[string]struct{})
			for n := range nbrs {
				if _, ok := memberSet[n]; ok {
					filtered[n] = struct{}{}
				}
			}
			if len(filtered) > 0 {
				subAdj[id] = filtered
			}
		}

		subLabel := PropagateLabels(memberIDs, subAdj, hubs, seedAtDepth(depth))
		groups := make(map[string][]string)
		for _, id := range memberIDs {
			l := subLabel[id]
			groups[l] = append(groups[l], id)
		}
		if len(groups) <= 1 {
			groups = make(map[string][]string)
			for _, id := range memberIDs {
				groups[id] = []string{id}
			}
		}

		var out [][]string
		for _, k := range sortedStringKeys(groups) {
			out = append(out, splitOversized(groups[k], depth+2, recursion+1)...)
		}
		return out
	}

	var finalGroups [][]string
	for _, key := range sortedStringKeys(byLabel) {
		finalGroups = append(finalGroups, splitOversized(byLabel[key], SeedDepth+2, 0)...)
	}

	// §1.8 cluster identity, record shape, ordering.
	sortedGroups := make([][]string, len(finalGroups))
	for i, members := range finalGroups {
		s := append([]string(nil), members...)
		sort.Strings(s)
		sortedGroups[i] = s
	}
	sort.SliceStable(sortedGroups, func(i, j int) bool {
		if len(sortedGroups[i]) != len(sortedGroups[j]) {
			return len(sortedGroups[i]) > len(sortedGroups[j])
		}
		return sortedGroups[i][0] < sortedGroups[j][0]
	})

	usedIDs := make(map[string]struct{})
	fallbackOrdinal := make(map[string]int)
	clusters := make([]Cluster, 0, len(sortedGroups))
	clusterOf := make(map[string]string, len(ids))

	for _, sorted := range sortedGroups {
		pkgCount := make(map[string]int)
		layerCount := make(map[string]int)
		for _, id := range sorted {
			m := moduleByID[id]
			var p string
			if m.Package != nil && *m.Package != "" {
				p = *m.Package
			} else {
				p = strings.TrimPrefix(ContainerOf(m), "dir:")
			}
			pkgCount[p]++
			layerCount[m.Layer]++
		}

		var dominantPackage *string
		if key, ok := pickDominantKey(pkgCount); ok {
			k := key
			dominantPackage = &k
		}
		dominantLayer := "support"
		if key, ok := pickDominantKey(layerCount); ok {
			dominantLayer = key
		}
		packages := sortedStringKeys(pkgCount)

		prefix := LongestCommonDirPrefix(sorted)
		var cid, clabel string
		if prefix != "" {
			cid = "cluster:" + prefix
			segs := strings.Split(prefix, "/")
			if len(segs) > 2 {
				segs = segs[len(segs)-2:]
			}
			clabel = strings.Join(segs, "/")
		} else {
			rawPkg := "root"
			if dominantPackage != nil {
				rawPkg = *dominantPackage
			}
			base := "cluster:" + rawPkg
			n := fallbackOrdinal[base] + 1
			fallbackOrdinal[base] = n
			if n == 1 {
				cid = base
			} else {
				cid = base + ":" + strconv.Itoa(n)
			}

			namePart := "root"
			if dominantPackage != nil {
				namePart = stripScope(*dominantPackage)
			}
			clabel = namePart
			if len(packages) > 1 {
				clabel += " · " + dominantLayer
			}
		}

		if _, exists := usedIDs[cid]; exists {
			n := 2
			for {
				candidate := cid + ":" + strconv.Itoa(n)
				if _, exists := usedIDs[candidate]; !exists {
					cid = candidate
					break
				}
				n++
			}
		}
		usedIDs[cid] = struct{}{}
		for _, id := range sorted {
			clusterOf[id] = cid
		}

		clusters = append(clusters, Cluster{
			ID:              cid,
			Label:           clabel,
			Size:            len(sorted),
			Members:         sorted,
			DominantPackage: dominantPackage,
			DominantLayer:   dominantLayer,
			Packages:        packages,
		})
	}

	sort.SliceStable(clusters, func(i, j int) bool {
		if clusters[i].Size != clusters[j].Size {
			return clusters[i].Size > clusters[j].Size
		}
		return clusters[i].ID < clusters[j].ID
	})

	return Result{Clusters: clusters, ClusterOf: clusterOf}
}

// ApplyClusters back-fills modules[i].Cluster from clusterOf (nil when the
// module id is absent from clusterOf — never happens for a well-formed
// Compute result, since every module lands in exactly one cluster).
func ApplyClusters(modules []model.Module, clusterOf map[string]string) {
	for i := range modules {
		if cid, ok := clusterOf[modules[i].ID]; ok {
			v := cid
			modules[i].Cluster = &v
		} else {
			modules[i].Cluster = nil
		}
	}
}

// pickDominantKey returns the key with the highest count, tie-broken by the
// lexicographically smallest key (count DESC, key ASC). ok is false when
// counts is empty. Like PropagateLabels' inner argmax, this fold is
// order-invariant over Go's random map iteration: the comparator is a
// strict total order and bestC starts unset, so the first entry processed
// always establishes the initial candidate correctly.
func pickDominantKey(counts map[string]int) (best string, ok bool) {
	bestC := -1
	for k, c := range counts {
		if !ok || c > bestC || (c == bestC && k < best) {
			best = k
			bestC = c
			ok = true
		}
	}
	return best, ok
}

// stripScope mirrors JS `pkg.replace(/^@[^/]+\//, "")`: strips a leading
// "@scope/" segment from a package name.
func stripScope(pkg string) string {
	if strings.HasPrefix(pkg, "@") {
		if idx := strings.IndexByte(pkg, '/'); idx >= 0 {
			return pkg[idx+1:]
		}
	}
	return pkg
}

// sortedStringKeys returns the keys of a map[string][]string or
// map[string]int sorted ascending. Used everywhere a Go map's random
// iteration order must not leak into emitted content ordering (the actual
// group *contents* are always deterministic; this only fixes the order in
// which independent groups are visited/emitted before the final sort).
func sortedStringKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
