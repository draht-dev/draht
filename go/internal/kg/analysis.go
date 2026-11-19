package kg

import (
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Analysis — ports of analyze.py
// ---------------------------------------------------------------------------

// adjacency is what buildAdjacency returns: the edges out of and into each
// node, and its degree (every edge end counts).
type adjacency struct {
	out, inn *OMap[string, []*Edge]
	deg      *OMap[string, int]
}

func buildAdjacency(graph *Graph) *adjacency {
	out, inn, deg := newOMap[string, []*Edge](), newOMap[string, []*Edge](), newOMap[string, int]()
	for _, n := range graph.Nodes {
		out.Set(n.ID, nil)
		inn.Set(n.ID, nil)
		deg.Set(n.ID, 0)
	}
	for _, e := range graph.Edges {
		if !out.Has(e.Source) || !inn.Has(e.Target) {
			continue
		}
		out.Set(e.Source, append(out.G(e.Source), e))
		inn.Set(e.Target, append(inn.G(e.Target), e))
		deg.Set(e.Source, deg.G(e.Source)+1)
		deg.Set(e.Target, deg.G(e.Target)+1)
	}
	return &adjacency{out: out, inn: inn, deg: deg}
}

// posixBasename is `path.posix.basename(p)` for a non-empty path.
func posixBasename(p string) string {
	end := len(p)
	for end > 0 && p[end-1] == '/' {
		end--
	}
	p = p[:end]
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func isFileNode(n *Node) bool {
	return n.SourceFile != "" && posixBasename(n.SourceFile) == n.Label
}

func isConceptNode(n *Node) bool {
	if n.SourceFile == "" {
		return true
	}
	last := n.SourceFile
	if i := strings.LastIndexByte(last, '/'); i >= 0 {
		last = last[i+1:]
	}
	return !strings.Contains(last, ".")
}

// godNode is one entry of godNodes:
// { id, label, degree, source_file, community }.
type godNode struct {
	ID           string
	Label        string
	Degree       int
	SourceFile   string
	Community    int
	HasCommunity bool
}

// godNodes: the JS default of topN is 10.
func godNodes(graph *Graph, adj *adjacency, topN int) []godNode {
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	type entry struct {
		id  string
		deg int
	}
	sorted := make([]entry, 0, adj.deg.Len())
	for id, d := range adj.deg.All() {
		sorted = append(sorted, entry{id, d})
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.deg != b.deg {
			return a.deg > b.deg
		}
		return a.id < b.id
	})
	var result []godNode
	for _, e := range sorted {
		n := byID[e.id]
		if isFileNode(n) || isConceptNode(n) {
			continue
		}
		if builtinNoiseLabels[n.Label] {
			continue
		}
		if strings.HasSuffix(n.Label, "()") && e.deg <= 1 {
			continue
		}
		result = append(result, godNode{ID: e.id, Label: n.Label, Degree: e.deg, SourceFile: n.SourceFile, Community: n.Community, HasCommunity: n.HasCommunity})
		if len(result) >= topN {
			break
		}
	}
	return result
}

// surprise is one entry of surprisingConnections:
// { score, source, target, source_id, target_id, relation, confidence, reasons }.
type surprise struct {
	Score      int
	Source     string
	Target     string
	SourceID   string
	TargetID   string
	Relation   string
	Confidence string
	Reasons    []string
}

var surprisingSkipRel = strSet("imports", "imports_from", "contains", "method", "defines")

// surprisingConnections: the JS default of topN is 10.
func surprisingConnections(graph *Graph, adj *adjacency, topN int) []surprise {
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	var scored []surprise
	for _, e := range graph.Edges {
		if surprisingSkipRel[e.Relation] {
			continue
		}
		u, v := byID[e.Source], byID[e.Target]
		if u == nil || v == nil || isConceptNode(u) || isConceptNode(v) || isFileNode(u) || isFileNode(v) {
			continue
		}
		if u.SourceFile == v.SourceFile {
			continue
		}
		score := 0
		var reasons []string
		confBonus := 1
		switch e.Confidence {
		case "AMBIGUOUS":
			confBonus = 3
		case "INFERRED":
			confBonus = 2
		}
		score += confBonus
		if e.Confidence == "AMBIGUOUS" || e.Confidence == "INFERRED" {
			reasons = append(reasons, strings.ToLower(e.Confidence)+" connection - not explicitly stated in source")
		}
		topU, topV := strings.Split(u.SourceFile, "/")[0], strings.Split(v.SourceFile, "/")[0]
		if topU != topV {
			score += 2
			reasons = append(reasons, "connects across different repos/directories")
		}
		if u.HasCommunity && v.HasCommunity && u.Community != v.Community {
			score++
			reasons = append(reasons, "bridges separate communities")
		}
		degU, degV := adj.deg.G(e.Source), adj.deg.G(e.Target)
		if min(degU, degV) <= 2 && max(degU, degV) >= 5 {
			score++
			reasons = append(reasons, "peripheral node connects to a hub")
		}
		if score >= 3 {
			scored = append(scored, surprise{Score: score, Source: u.Label, Target: v.Label, SourceID: e.Source, TargetID: e.Target, Relation: e.Relation, Confidence: e.Confidence, Reasons: reasons})
		}
	}
	// JS: b.score - a.score || (a.source_id < b.source_id ? -1 : 1) || (target…):
	// the source comparison is never 0, so the target tiebreak is never
	// reached and entries with one source keep their edge order.
	sort.SliceStable(scored, func(i, j int) bool {
		a, b := scored[i], scored[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.SourceID < b.SourceID
	})
	// dedupe: one per community pair
	seenPair := map[string]bool{}
	var out []surprise
	for _, s := range scored {
		nu, nv := byID[s.SourceID], byID[s.TargetID]
		// Math.min / Math.max of an undefined community is NaN.
		key := "NaN:NaN"
		if nu.HasCommunity && nv.HasCommunity {
			key = strconv.Itoa(min(nu.Community, nv.Community)) + ":" + strconv.Itoa(max(nu.Community, nv.Community))
		}
		if seenPair[key] {
			continue
		}
		seenPair[key] = true
		out = append(out, s)
		if len(out) >= topN {
			break
		}
	}
	return out
}

func suggestQuestions(graph *Graph, adj *adjacency, communities []*Community, gods []godNode) []string {
	var q []string
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	// `byId.get(id)?.label` in a template string: "undefined" for a missing node.
	labelOf := func(id string) string {
		if n := byID[id]; n != nil {
			return n.Label
		}
		return "undefined"
	}
	ambiguous := 0
	for _, e := range graph.Edges {
		if e.Confidence != "AMBIGUOUS" {
			continue
		}
		if ambiguous >= 3 {
			break
		}
		ambiguous++
		q = append(q, "Is the "+e.Relation+" edge "+labelOf(e.Source)+" → "+labelOf(e.Target)+" real? (marked AMBIGUOUS)")
	}
	for i, g := range gods {
		if i >= 3 {
			break
		}
		inferredCount := 0
		for _, e := range adj.out.G(g.ID) {
			if e.Confidence == "INFERRED" {
				inferredCount++
			}
		}
		for _, e := range adj.inn.G(g.ID) {
			if e.Confidence == "INFERRED" {
				inferredCount++
			}
		}
		if inferredCount >= 2 {
			q = append(q, "`"+g.Label+"` has "+strconv.Itoa(inferredCount)+" inferred edges — verify how it is actually used.")
		} else {
			q = append(q, "Why does `"+g.Label+"` have "+strconv.Itoa(g.Degree)+" connections — is it doing too much?")
		}
	}
	isolated := 0
	for _, n := range graph.Nodes {
		if adj.deg.G(n.ID) != 0 || isConceptNode(n) {
			continue
		}
		if isolated >= 2 {
			break
		}
		isolated++
		q = append(q, "`"+n.Label+"` ("+n.SourceFile+") has no connections — dead code or missed extraction?")
	}
	for _, c := range communities {
		if c.Size >= 5 && c.Cohesion < 0.15 {
			q = append(q, `Community "`+c.Name+`" (`+strconv.Itoa(c.Size)+" nodes) has low cohesion "+jsNumber(c.Cohesion)+" — is it really one concept?")
			break
		}
	}
	if len(q) > 8 {
		q = q[:8]
	}
	return q
}

// Strongly connected components (iterative Tarjan): node id → component id,
// and component sizes. A cycle lives entirely inside one component, so the
// bounded path search below never leaves it — and never starts at all in an
// acyclic graph, where it would otherwise walk every path up to maxLen.
func stronglyConnected(adj *OMap[string, []string]) (comp map[string]int, size []int) {
	index, low := map[string]int{}, map[string]int{}
	comp = map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	counter := 0
	type frame struct {
		v string
		i int
	}
	visit := func(root string) {
		work := []frame{{root, 0}}
		index[root] = counter
		low[root] = counter
		counter++
		stack = append(stack, root)
		onStack[root] = true
		for len(work) > 0 {
			fr := &work[len(work)-1]
			v := fr.v
			nbrs := adj.G(v)
			if fr.i < len(nbrs) {
				w := nbrs[fr.i]
				fr.i++
				if _, seen := index[w]; !seen {
					index[w] = counter
					low[w] = counter
					counter++
					stack = append(stack, w)
					onStack[w] = true
					work = append(work, frame{w, 0})
				} else if onStack[w] {
					low[v] = min(low[v], index[w])
				}
				continue
			}
			work = work[:len(work)-1]
			if len(work) > 0 {
				parent := work[len(work)-1].v
				low[parent] = min(low[parent], low[v])
			}
			if low[v] == index[v] {
				id := len(size)
				n := 0
				for {
					w := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					delete(onStack, w)
					comp[w] = id
					n++
					if w == v {
						break
					}
				}
				size = append(size, n)
			}
		}
	}
	for _, v := range adj.Keys() {
		if _, seen := index[v]; !seen {
			visit(v)
		}
	}
	return comp, size
}

// importCycles: the JS default of maxLen is 5.
func importCycles(graph *Graph, maxLen int) [][]string {
	// file-level digraph over imports_from/re_exports, excluding deferred (dynamic) imports
	adj := newOMap[string, []string]()
	// The original tests `e._deferred`, which only a built graph carries: a
	// graph read back from graph.json has `deferred` instead, so its dynamic
	// imports are NOT excluded. graph.Path is set by loadGraph alone.
	built := graph.Path == ""
	for _, e := range graph.Edges {
		if e.Relation != "imports_from" && e.Relation != "re_exports" {
			continue
		}
		if built && e.Deferred {
			continue
		}
		adj.Set(e.Source, append(adj.G(e.Source), e.Target))
	}
	comp, size := stronglyConnected(adj)
	var cycles [][]string
	seen := map[string]bool{}
	nodes := adj.Keys()
	sort.Strings(nodes)
	type item struct {
		cur  string
		path []string
	}
	for _, start := range nodes {
		home := comp[start]
		if size[home] < 2 {
			continue
		}
		stack := []item{{start, []string{start}}}
		for len(stack) > 0 && len(cycles) < 20 {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			cur, pathArr := top.cur, top.path
			for _, nb := range adj.G(cur) {
				if c, ok := comp[nb]; !ok || c != home {
					continue
				}
				if nb == start && len(pathArr) > 1 {
					minIdx := 0
					for i, p := range pathArr {
						if p < pathArr[minIdx] {
							minIdx = i
						}
					}
					rot := append(append([]string(nil), pathArr[minIdx:]...), pathArr[:minIdx]...)
					canon := strings.Join(rot, "→")
					if !seen[canon] {
						seen[canon] = true
						cycles = append(cycles, append(append([]string(nil), pathArr...), start))
					}
				} else if !containsStr(pathArr, nb) && len(pathArr) < maxLen {
					stack = append(stack, item{nb, append(append([]string(nil), pathArr...), nb)})
				}
			}
		}
	}
	if len(cycles) > 10 {
		cycles = cycles[:10]
	}
	return cycles
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
