package cluster

import (
	"math"
	"regexp"
	"sort"

	"github.com/draht-dev/draht/go/internal/model"
)

// BarrelRe mirrors CLUSTER_BARREL_RE (cjs:1854): a module whose path ends in
// index.{ts,tsx,js,mjs,cjs} is always treated as a hub, regardless of its
// import degree.
var BarrelRe = regexp.MustCompile(`(^|/)index\.(ts|tsx|js|mjs|cjs)$`)

// Adjacency is the undirected import graph: id -> set of neighbour ids. A
// module with no import edges has NO entry — a nil map lookup returns an
// empty (nil) neighbour set, which behaves identically to an explicit empty
// set for every consumer in this package (len() and range both treat a nil
// map as empty), reproducing the JS `adj.has(id)` distinction without extra
// bookkeeping: adjacency entries are only ever created with >=1 member
// (link() is never called to produce an empty set), so "absent" and
// "present but empty" never diverge here.
type Adjacency map[string]map[string]struct{}

// BuildAdjacency builds the undirected, import-only, Set-deduped adjacency
// used by clustering (cjs:1859-1867). Self-loops are dropped. Both edge
// endpoints must be known module ids; edges referencing an unknown module
// are skipped. Only edges with Kind == "import" contribute (re-export and
// external edges are excluded).
func BuildAdjacency(modules []model.Module, edges []model.Edge) Adjacency {
	known := make(map[string]struct{}, len(modules))
	for i := range modules {
		known[modules[i].ID] = struct{}{}
	}

	adj := make(Adjacency)
	link := func(a, b string) {
		if a == b {
			return
		}
		nbrs := adj[a]
		if nbrs == nil {
			nbrs = make(map[string]struct{})
			adj[a] = nbrs
		}
		nbrs[b] = struct{}{}
	}

	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		if _, ok := known[e.From]; !ok {
			continue
		}
		if _, ok := known[e.To]; !ok {
			continue
		}
		link(e.From, e.To)
		link(e.To, e.From)
	}
	return adj
}

// HubSet returns the 95th-percentile-degree union barrel-file hub set
// (cjs:1869-1882). ids MUST be sorted ascending (the sort order does not
// affect the returned set's contents, only iteration determinism for
// callers building on top of the result). threshold is the degree value at
// the clamped 95th-percentile index; membership requires a degree strictly
// greater than threshold, OR a barrel-file path match.
func HubSet(ids []string, adj Adjacency) (hubs map[string]struct{}, threshold int) {
	degrees := make([]int, len(ids))
	for i, id := range ids {
		degrees[i] = len(adj[id])
	}
	sort.Ints(degrees)

	if len(degrees) > 0 {
		idx := int(math.Floor(0.95 * float64(len(degrees))))
		if idx > len(degrees)-1 {
			idx = len(degrees) - 1
		}
		threshold = degrees[idx]
	}

	hubs = make(map[string]struct{})
	for _, id := range ids {
		deg := len(adj[id])
		if deg > threshold || BarrelRe.MatchString(id) {
			hubs[id] = struct{}{}
		}
	}
	return hubs, threshold
}
