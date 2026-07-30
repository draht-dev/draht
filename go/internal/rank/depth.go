package rank

import "github.com/draht-dev/draht/go/internal/model"

// Depths runs the multi-source FIFO BFS that fills modules[*].depth
// (draht-tools.cjs:2515-2531). The adjacency it walks is DIRECTED
// (from -> to only) and includes both "import" AND "re-export" edges
// (re-exports are reachability edges, unlike clustering's undirected,
// import-only adjacency); "external" edges are excluded. Duplicate edges
// are harmless — the BFS visits each id at most once.
//
// Every entry point seeds depth 0. Because all seeds are enqueued before
// the BFS starts and it proceeds breadth-first, the resulting distances
// are true shortest paths and are independent of entry-point order or
// per-node adjacency-list order — no explicit sort is needed for
// determinism here.
//
// modules is accepted for signature symmetry with the rest of this
// package's API (and so a future caller can validate ids against it) but
// is not otherwise consulted: only edges and entryPoints drive the BFS.
// Modules unreachable from every entry point are simply absent from the
// returned map; ApplyDepths treats that absence as depth == null.
func Depths(modules []model.Module, edges []model.Edge, entryPoints []model.EntryPointRef) map[string]int {
	_ = modules

	adj := make(map[string][]string)
	for _, e := range edges {
		if e.Kind != model.EdgeKindImport && e.Kind != model.EdgeKindReExport {
			continue
		}
		adj[e.From] = append(adj[e.From], e.To)
	}

	depth := make(map[string]int, len(entryPoints))
	queue := make([]string, 0, len(entryPoints))
	for _, ep := range entryPoints {
		if _, seeded := depth[ep.ID]; seeded {
			continue
		}
		depth[ep.ID] = 0
		queue = append(queue, ep.ID)
	}

	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		d := depth[id]
		for _, next := range adj[id] {
			if _, visited := depth[next]; !visited {
				depth[next] = d + 1
				queue = append(queue, next)
			}
		}
	}

	return depth
}

// ApplyDepths back-fills modules[i].Depth from depths: present -> a
// pointer to the BFS distance, absent -> nil (JSON null), mirroring
// `m.depth = depth.has(m.id) ? depth.get(m.id) : null`.
func ApplyDepths(modules []model.Module, depths map[string]int) {
	for i := range modules {
		if d, ok := depths[modules[i].ID]; ok {
			modules[i].Depth = model.Int(d)
		} else {
			modules[i].Depth = nil
		}
	}
}
