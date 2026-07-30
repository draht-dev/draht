package query

import (
	"fmt"
	"io"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// neighbor is one adjacency-list entry for the call+import graph used by
// graph-callers/graph-callees. Symbol is nil for edges derived from
// map.edges (kind=="import"); it is always non-nil for edges derived from
// map.callEdges, matching the CJS's `symbol: null` for import-only edges.
type neighbor struct {
	To     string
	Symbol *string
}

// buildCallAdj ports the adjacency build inside graphCallDir
// (draht-tools.cjs:5463-5466). Order matters: map.callEdges are consumed
// FIRST, then map.edges (kind=="import" ONLY — re-export is excluded here,
// unlike BuildImportAdj). This is why the same file can report a different
// importer count from graph-context (import+re-export) than from
// graph-callers (import only), and why call-edge neighbours appear before
// import-only neighbours in the rendered hop lists.
func buildCallAdj(m *model.Map) (fwd, rev map[string][]neighbor) {
	fwd = map[string][]neighbor{}
	rev = map[string][]neighbor{}
	push := func(mp map[string][]neighbor, k string, v neighbor) {
		for _, x := range mp[k] {
			if x.To == v.To && symEq(x.Symbol, v.Symbol) {
				return
			}
		}
		mp[k] = append(mp[k], v)
	}
	for _, ce := range m.CallEdges {
		sym1, sym2 := ce.Symbol, ce.Symbol
		push(fwd, ce.From, neighbor{To: ce.To, Symbol: &sym1})
		push(rev, ce.To, neighbor{To: ce.From, Symbol: &sym2})
	}
	for _, e := range m.Edges {
		if e.Kind != "import" {
			continue
		}
		push(fwd, e.From, neighbor{To: e.To, Symbol: nil})
		push(rev, e.To, neighbor{To: e.From, Symbol: nil})
	}
	return fwd, rev
}

func symEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Callers renders `graph-callers <file> [--depth N] [--json]`.
func Callers(m *model.Map, argv []string, w io.Writer) int {
	return callDir(m, argv, "callers", w)
}

// Callees renders `graph-callees <file> [--depth N] [--json]`.
func Callees(m *model.Map, argv []string, w io.Writer) int {
	return callDir(m, argv, "callees", w)
}

// callDir ports graphCallDir (draht-tools.cjs:5457-5480), shared by both
// graph-callers and graph-callees; direction is interpolated verbatim into
// the usage/header lines and selects which adjacency (rev for callers, fwd
// for callees) drives the BFS.
func callDir(m *model.Map, argv []string, direction string, w io.Writer) int {
	args := ParseArgs(argv, "depth")
	if len(args.Files) == 0 {
		fmt.Fprintf(w, "usage: graph-%s <file> [--depth N] [--json]\n", direction)
		return 0
	}
	depth := max(1, args.IntOr("depth", 1))

	resolver := NewResolver(m)
	r := resolver.Resolve(args.Files[0])
	if r == nil {
		fmt.Fprintf(w, "%s: not found in map\n", args.Files[0])
		return 0
	}

	fwd, rev := buildCallAdj(m)
	adj := fwd
	if direction == "callers" {
		adj = rev
	}

	level := map[string]int{r.ID: 0}
	queue := []string{r.ID}
	var hops []Hop
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if level[id] >= depth {
			continue
		}
		for _, nb := range adj[id] {
			if _, ok := level[nb.To]; !ok {
				level[nb.To] = level[id] + 1
				queue = append(queue, nb.To)
			}
			if level[nb.To] == level[id]+1 {
				hops = append(hops, Hop{From: id, To: nb.To, Symbol: nb.Symbol, Hop: level[id] + 1})
			}
		}
	}

	if args.Bool("json") {
		payload := CallDirJSON{Target: r.ID, Direction: direction, Hops: nonNilHops(hops)}
		b, err := MarshalPretty(payload)
		if err != nil {
			fmt.Fprintln(w, "{}")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	total := len(level) - 1
	hopWord := "hop"
	if depth > 1 {
		hopWord = "hops"
	}
	fmt.Fprintf(w, "%s of %s — %d within %d %s\n", direction, r.ID, total, depth, hopWord)

	byHop := map[int][]Hop{}
	for _, h := range hops {
		byHop[h.Hop] = append(byHop[h.Hop], h)
	}
	for d := 1; d <= depth; d++ {
		arr := byHop[d]
		if len(arr) == 0 {
			continue
		}
		fmt.Fprintf(w, "  hop %d:\n", d)
		seenNode := map[string]bool{}
		for _, h := range arr {
			node := h.To
			if seenNode[node] {
				continue
			}
			seenNode[node] = true
			var syms []string
			seenSym := map[string]bool{}
			for _, x := range arr {
				if x.To == node && x.Symbol != nil && *x.Symbol != "" {
					if !seenSym[*x.Symbol] {
						seenSym[*x.Symbol] = true
						syms = append(syms, *x.Symbol)
					}
				}
			}
			if len(syms) > 4 {
				syms = syms[:4]
			}
			if len(syms) > 0 {
				fmt.Fprintf(w, "    %s  [%s]\n", node, strings.Join(syms, ", "))
			} else {
				fmt.Fprintf(w, "    %s\n", node)
			}
		}
	}
	return 0
}

func nonNilHops(xs []Hop) []Hop {
	if xs == nil {
		return []Hop{}
	}
	return xs
}
