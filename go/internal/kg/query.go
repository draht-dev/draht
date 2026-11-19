package kg

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/draht-dev/draht/go/internal/jsutil"
	"golang.org/x/text/unicode/norm"
)

// ---------------------------------------------------------------------------
// Query engine — ports of serve.py
// ---------------------------------------------------------------------------

// stripDiacritics: NFD, then the combining marks U+0300–U+036F removed.
func stripDiacritics(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	d := norm.NFD.String(s)
	var b strings.Builder
	b.Grow(len(d))
	for _, c := range d {
		if c >= 0x300 && c <= 0x36f {
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

// wordTokens is `s.match(/[\p{L}\p{N}_]+/gu) || []`.
func wordTokens(s string) []string {
	var out []string
	start := -1
	for i, c := range s {
		if c == '_' || unicode.IsLetter(c) || unicode.IsNumber(c) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			out = append(out, s[start:i])
			start = -1
		}
	}
	if start >= 0 {
		out = append(out, s[start:])
	}
	return out
}

func searchTokens(text string) []string {
	return wordTokens(strings.ToLower(stripDiacritics(text)))
}

func isSearchable(term string) bool {
	// /^[a-z]+$/
	if term == "" {
		return true
	}
	for i := 0; i < len(term); i++ {
		if term[i] < 'a' || term[i] > 'z' {
			return true
		}
	}
	return len(term) > 2
}

func queryTerms(question string) []string {
	var terms []string
	for _, raw := range strings.FieldsFunc(question, isSpace) {
		for _, tok := range wordTokens(strings.ToLower(raw)) {
			if isSearchable(tok) {
				terms = append(terms, tok)
			}
		}
	}
	var content []string
	for _, t := range terms {
		if !queryStopwords[t] {
			content = append(content, t)
		}
	}
	if len(content) > 0 {
		return content
	}
	return terms
}

func nodeNormLabel(n *Node) string {
	if n.NormLabel != "" {
		return n.NormLabel
	}
	return strings.ToLower(stripDiacritics(n.Label))
}

func computeIdf(graph *Graph, terms []string) map[string]float64 {
	nn := len(graph.Nodes)
	if nn == 0 {
		nn = 1
	}
	idf := make(map[string]float64, len(terms))
	for _, t := range terms {
		df := 0
		for _, n := range graph.Nodes {
			if strings.Contains(nodeNormLabel(n), t) {
				df++
			}
		}
		idf[t] = jsLog(1 + float64(nn)/float64(1+df))
	}
	return idf
}

// uniqueStrings is `[...new Set(list)]`.
func uniqueStrings(list []string) []string {
	seen := make(map[string]bool, len(list))
	var out []string
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// stripCallSuffix is `s.replace(/\(\)+$/, "")`: a trailing `(` + one or more `)`.
func stripCallSuffix(s string) string {
	i := len(s)
	for i > 0 && s[i-1] == ')' {
		i--
	}
	if i < len(s) && i > 0 && s[i-1] == '(' {
		return s[:i-1]
	}
	return s
}

// truthy is the JS truthiness of a number: not 0 and not NaN.
func truthy(f float64) bool { return f != 0 && !math.IsNaN(f) }

// scoredNode is one `[score, id]` pair of scoreNodes.
type scoredNode struct {
	Score float64
	ID    string
}

func scoreNodes(graph *Graph, terms []string) []scoredNode {
	var flat []string
	for _, t := range terms {
		flat = append(flat, searchTokens(t)...)
	}
	normTerms := uniqueStrings(flat)
	nTerms := len(normTerms)
	if nTerms == 0 {
		nTerms = 1
	}
	idf := computeIdf(graph, normTerms)
	idfOr1 := func(t string) float64 {
		if w := idf[t]; truthy(w) {
			return w
		}
		return 1.0
	}
	joined := strings.Join(normTerms, " ")
	joinedW := 1.0
	for _, t := range normTerms {
		joinedW = math.Max(joinedW, idfOr1(t))
	}
	var scored []scoredNode
	for _, n := range graph.Nodes {
		normLabel := nodeNormLabel(n)
		bareLabel := stripCallSuffix(normLabel)
		labelTokens := strings.Join(searchTokens(n.Label), " ")
		source := strings.ToLower(n.SourceFile)
		score := 0.0
		if joined != "" {
			nidLower := strings.ToLower(n.ID)
			if joined == normLabel || joined == bareLabel || joined == labelTokens || joined == nidLower {
				score += float64(exactMatchBonus * 10 * joinedW)
			} else if strings.HasPrefix(normLabel, joined) || strings.HasPrefix(bareLabel, joined) || strings.HasPrefix(labelTokens, joined) {
				score += float64(prefixMatchBonus * 10 * joinedW)
			}
		}
		matched := 0
		tiered := 0.0
		for _, t := range normTerms {
			w := idfOr1(t)
			if t == normLabel || t == bareLabel {
				tiered += float64(exactMatchBonus * w)
				matched++
			} else if strings.HasPrefix(normLabel, t) || strings.HasPrefix(bareLabel, t) {
				tiered += float64(prefixMatchBonus * w)
				matched++
			} else if strings.Contains(normLabel, t) {
				score += float64(substringMatchBonus * w)
				matched++
			}
			if strings.Contains(source, t) {
				score += float64(sourceMatchBonus * w)
			}
		}
		if truthy(tiered) {
			ratio := float64(matched) / float64(nTerms)
			score += float64(tiered * float64(ratio*ratio))
		}
		if score > 0 {
			scored = append(scored, scoredNode{score, n.ID})
		}
	}
	// (label || id).length, in UTF-16 units
	labelLen := make(map[string]int, len(graph.Nodes))
	for _, n := range graph.Nodes {
		l := n.Label
		if l == "" {
			l = n.ID
		}
		labelLen[n.ID] = jsutil.LenUTF16(l)
	}
	sort.SliceStable(scored, func(i, j int) bool {
		a, b := scored[i], scored[j]
		if d := b.Score - a.Score; truthy(d) {
			return d < 0
		}
		if la, lb := labelLen[a.ID], labelLen[b.ID]; la != lb {
			return la < lb
		}
		return a.ID < b.ID
	})
	return scored
}

// pickScoredEndpoint needs a non-empty `scored`, as the original does.
func pickScoredEndpoint(graph *Graph, scored []scoredNode, query string) string {
	qtokens := uniqueStrings(searchTokens(query))
	if len(qtokens) == 0 {
		return scored[0].ID
	}
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	for _, s := range scored {
		label := byID[s.ID].Label
		if label == "" {
			label = s.ID
		}
		ltokens := map[string]bool{}
		for _, t := range searchTokens(label) {
			ltokens[t] = true
		}
		all := true
		for _, t := range qtokens {
			if !ltokens[t] {
				all = false
				break
			}
		}
		if all {
			return s.ID
		}
	}
	return scored[0].ID
}

// undirected is what undirectedNeighbors returns: { nbrs, deg }.
type undirected struct {
	Nbrs *OMap[string, *OSet[string]]
	Deg  *OMap[string, int]
}

func undirectedNeighbors(graph *Graph) *undirected {
	nbrs := newOMap[string, *OSet[string]]()
	deg := newOMap[string, int]()
	for _, n := range graph.Nodes {
		nbrs.Set(n.ID, newOSet[string]())
		deg.Set(n.ID, 0)
	}
	for _, e := range graph.Edges {
		if !nbrs.Has(e.Source) || !nbrs.Has(e.Target) || e.Source == e.Target {
			continue
		}
		nbrs.G(e.Source).Add(e.Target)
		nbrs.G(e.Target).Add(e.Source)
	}
	for id, s := range nbrs.All() {
		deg.Set(id, s.Len())
	}
	return &undirected{Nbrs: nbrs, Deg: deg}
}

func hubThreshold(deg *OMap[string, int]) int {
	degrees := deg.Values()
	sort.Ints(degrees)
	if len(degrees) == 0 {
		return 50
	}
	p99 := degrees[min(len(degrees)-1, int(math.Floor(float64(len(degrees))*0.99)))]
	return max(50, p99)
}

// traversal is what traverse returns: { visited, edgesSeen, edges, deg }.
type traversal struct {
	Visited   *OSet[string]
	EdgesSeen [][2]string
	Edges     []*Edge
	Deg       *OMap[string, int]
}

// sortedItems is `[...set].sort()`.
func sortedItems(s *OSet[string]) []string {
	items := s.Items()
	sort.Strings(items)
	return items
}

// traverse: mode is "dfs" or anything else for breadth-first; contextFilter
// nil or empty for no filter.
func traverse(graph *Graph, startNodes []string, depth int, mode string, contextFilter []string) *traversal {
	edges := graph.Edges
	if len(contextFilter) > 0 {
		f := strSet(contextFilter...)
		var kept []*Edge
		for _, e := range edges {
			// an edge without a context is `undefined`, which no filter names
			if e.Context != "" && f[e.Context] {
				kept = append(kept, e)
			}
		}
		edges = kept
	}
	un := undirectedNeighbors(&Graph{Nodes: graph.Nodes, Edges: edges})
	nbrs, deg := un.Nbrs, un.Deg
	hub := hubThreshold(deg)
	seedSet := strSet(startNodes...)
	visited := newOSet(startNodes...)
	var edgesSeen [][2]string
	if mode == "dfs" {
		visited = newOSet[string]()
		type item struct {
			node string
			d    int
		}
		stack := make([]item, 0, len(startNodes))
		for i := len(startNodes) - 1; i >= 0; i-- {
			stack = append(stack, item{startNodes[i], 0})
		}
		for len(stack) > 0 {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			node, d := top.node, top.d
			if visited.Has(node) || d > depth {
				continue
			}
			visited.Add(node)
			if !seedSet[node] && deg.G(node) >= hub {
				continue
			}
			if set, ok := nbrs.Get(node); ok {
				for _, nb := range sortedItems(set) {
					if !visited.Has(nb) {
						stack = append(stack, item{nb, d + 1})
						edgesSeen = append(edgesSeen, [2]string{node, nb})
					}
				}
			}
		}
	} else {
		frontier := newOSet(startNodes...)
		for i := 0; i < depth; i++ {
			next := newOSet[string]()
			for _, n := range sortedItems(frontier) {
				if !seedSet[n] && deg.G(n) >= hub {
					continue
				}
				if set, ok := nbrs.Get(n); ok {
					for _, nb := range sortedItems(set) {
						if !visited.Has(nb) {
							next.Add(nb)
							edgesSeen = append(edgesSeen, [2]string{n, nb})
						}
					}
				}
			}
			for _, n := range next.Items() {
				visited.Add(n)
			}
			frontier = next
		}
	}
	return &traversal{Visited: visited, EdgesSeen: edgesSeen, Edges: edges, Deg: deg}
}

// edgeBetween returns an empty edge (the original's `{}`) when none joins u and v.
func edgeBetween(edges []*Edge, u, v string) *Edge {
	for _, e := range edges {
		if (e.Source == u && e.Target == v) || (e.Source == v && e.Target == u) {
			return e
		}
	}
	return &Edge{}
}

func subgraphToText(graph *Graph, visited *OSet[string], edgesSeen [][2]string, edges []*Edge, deg *OMap[string, int], tokenBudget int, seeds []string) string {
	charBudget := tokenBudget * 3
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	var lines []string
	seedSet := strSet(seeds...)
	var ordered []string
	for _, s := range seeds {
		if visited.Has(s) {
			ordered = append(ordered, s)
		}
	}
	var rest []string
	for _, n := range visited.Items() {
		if !seedSet[n] {
			rest = append(rest, n)
		}
	}
	sort.SliceStable(rest, func(i, j int) bool {
		a, b := rest[i], rest[j]
		if da, db := deg.G(a), deg.G(b); da != db {
			return da > db
		}
		return a < b
	})
	ordered = append(ordered, rest...)
	labelOf := func(id string) string {
		if n := byID[id]; n != nil && n.Label != "" {
			return n.Label
		}
		return id
	}
	for _, nid := range ordered {
		src, loc, community := "", "", ""
		if d := byID[nid]; d != nil {
			src, loc = d.SourceFile, d.SourceLocation
			if d.CommunityName != "" {
				community = d.CommunityName
			} else if d.HasCommunity {
				community = strconv.Itoa(d.Community)
			}
		}
		lines = append(lines, "NODE "+labelOf(nid)+" [src="+src+" loc="+loc+" community="+community+"]")
	}
	// index edges for fast lookup
	eIdx := make(map[string]*Edge, len(edges)*2)
	for _, e := range edges {
		eIdx[e.Source+" "+e.Target] = e
		if _, ok := eIdx[e.Target+" "+e.Source]; !ok {
			eIdx[e.Target+" "+e.Source] = e
		}
	}
	// EDGE lines always print the STORED direction (source -> target), never
	// the traversal direction: a search for a callee must not render
	// `callee --calls--> caller`.
	printed := map[string]bool{}
	pushEdge := func(e *Edge) {
		if e == nil || e.Relation == "" {
			return
		}
		k := e.Source + " " + e.Target + " " + e.Relation
		if printed[k] {
			return
		}
		printed[k] = true
		ctx := ""
		if e.Context != "" {
			ctx = " context=" + e.Context
		}
		lines = append(lines, "EDGE "+labelOf(e.Source)+" --"+e.Relation+" ["+e.Confidence+ctx+"]--> "+labelOf(e.Target))
	}
	// Edges between seeds first: both endpoints are pre-visited, so the
	// traversal itself never records them — yet the link between the queried
	// symbols is usually the answer.
	if len(uniqueStrings(seeds)) > 1 {
		for _, e := range edges {
			if e.Source != e.Target && seedSet[e.Source] && seedSet[e.Target] {
				pushEdge(e)
			}
		}
	}
	for _, uv := range edgesSeen {
		u, v := uv[0], uv[1]
		if !visited.Has(u) || !visited.Has(v) {
			continue
		}
		pushEdge(eIdx[u+" "+v])
	}
	output := strings.Join(lines, "\n")
	// The budget counts UTF-16 units, as `output.length` and `slice` do.
	if jsutil.LenUTF16(output) > charBudget {
		units := utf16.Encode([]rune(output))
		cutAt := -1
		for i := min(charBudget, len(units)) - 1; i >= 0; i-- {
			if units[i] == '\n' {
				cutAt = i
				break
			}
		}
		if cutAt <= 0 {
			cutAt = charBudget
		}
		if cutAt < 0 {
			cutAt = 0
		}
		totalNodes := 0
		for _, l := range lines {
			if strings.HasPrefix(l, "NODE ") {
				totalNodes++
			}
		}
		head := string(utf16.Decode(units[:min(cutAt, len(units))]))
		shownNodes := strings.Count(head, "\nNODE ")
		if strings.HasPrefix(head, "NODE ") {
			shownNodes++
		}
		output = head + "\n... (truncated — " + strconv.Itoa(totalNodes-shownNodes) + " more nodes cut by ~" + strconv.Itoa(tokenBudget) + "-token budget. Narrow with --context call or use kg explain for a specific symbol)"
	}
	return output
}

// ---------------------------------------------------------------------------
// File-first ranking for `kg query`
// ---------------------------------------------------------------------------

// Words of an identifier or a sentence: camelCase, PascalCase, ACRONYMWord,
// snake_case and punctuation all split; lowercased.
//
// A hand-written scan of /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g (the build
// runs it over every file's text).
func wordsOf(text string) []string {
	var out []string
	isUp := func(c byte) bool { return c >= 'A' && c <= 'Z' }
	isLow := func(c byte) bool { return c >= 'a' && c <= 'z' }
	isDig := func(c byte) bool { return c >= '0' && c <= '9' }
	n := len(text)
	for i := 0; i < n; {
		c := text[i]
		switch {
		case isUp(c):
			j := i
			for j < n && isUp(text[j]) {
				j++
			}
			if j < n && isLow(text[j]) {
				if j-i >= 2 {
					// [A-Z]+(?![a-z]) gives the last capital back to the next word
					j--
				} else {
					// [A-Z]?[a-z]+
					j++
					for j < n && isLow(text[j]) {
						j++
					}
				}
			}
			out = append(out, strings.ToLower(text[i:j]))
			i = j
		case isLow(c):
			j := i
			for j < n && isLow(text[j]) {
				j++
			}
			out = append(out, text[i:j])
			i = j
		case isDig(c):
			j := i
			for j < n && isDig(text[j]) {
				j++
			}
			out = append(out, text[i:j])
			i = j
		default:
			i++
		}
	}
	return out
}

const (
	keywordsPerFile = 100
	bm25K1          = 1.2
	bm25B           = 0.75
	// Signal weights: file text (BM25 over the stored keywords), the best symbol
	// label, the path. A label that IS the query outranks everything else.
	rankLabelWeight = 4
	rankPathWeight  = 2
	rankSubstring   = 0.35
	rankDemote      = 0.3
	rankFilesLimit  = 10 // RANK_FILES (rankFiles is the function)
)

var demotedPathRe = mustRE(`(\.test\.|\.spec\.|\.e2e\.|(^|\/)tests?\/|__tests__|(^|\/)testdata\/|(^|\/)fixtures?\/|(^|\/)examples?\/|(^|\/)benches\/|(^|\/)benchmarks?\/|_test\.go$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|(^|\/)vendor\/|\.min\.[cm]?js$|(^|\/)docs?\/|\.d\.[cm]?ts$)`, "")

var demoteExemptWords = strSet("test", "tests", "testing", "spec", "fixture", "fixtures", "example", "examples", "benchmark", "benchmarks", "vendor", "docs")

// The keywords `kg build` stores on a file node: its most distinctive words
// (term frequency × rarity across the repo), as "word:count" pairs.
func fileKeywords(tf *OMap[string, int], idfOf func(string) float64) string {
	type entry struct {
		t string
		c int
		w float64
	}
	list := make([]entry, 0, tf.Len())
	for t, c := range tf.All() {
		list = append(list, entry{t, c, float64(c) * idfOf(t)})
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if d := b.w - a.w; truthy(d) {
			return d < 0
		}
		return a.t < b.t
	})
	if len(list) > keywordsPerFile {
		list = list[:keywordsPerFile]
	}
	parts := make([]string, len(list))
	for i, e := range list {
		parts[i] = e.t + ":" + strconv.Itoa(e.c)
	}
	return strings.Join(parts, " ")
}

// jsToNumber is `+s` for the count of a stored "word:count" pair.
func jsToNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	body := strings.TrimPrefix(strings.TrimPrefix(s, "+"), "-")
	if body == "Infinity" {
		if s[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9') && c != '.' && c != 'e' && c != 'E' && c != '+' && c != '-' {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// rankedFile is one file of rankFiles. Nodes are the nodes the original
// names by id.
type rankedFile struct {
	Rel   string
	Score float64
	Nodes []*Node
}

type rankLabel struct {
	id     string
	words  []string // in order of first appearance (the Set's order)
	w      map[string]bool
	joined string
	n      int
	raw    string
	top    bool
}

type rankFileInfo struct {
	node      *Node
	labels    []*rankLabel
	pathWords *OSet[string]
	tf        *OMap[string, float64] // nil without stored keywords
	length    float64
}

// Files ranked for a question, best first: [{ rel, score, nodes }], where
// `nodes` are the file's symbols that match (best first) or its file node.
// Three signals per file — its text, its best-matching symbol label, its path
// — and one override: a symbol whose name is the whole query. Tests, docs,
// vendored and generated code rank below source unless the question names
// them.
func rankFiles(graph *Graph, question string) []rankedFile {
	allWords := wordsOf(question)
	var filtered []string
	for _, t := range allWords {
		if len(t) >= 2 && !queryStopwords[t] {
			filtered = append(filtered, t)
		}
	}
	terms := uniqueStrings(filtered)
	qs := terms
	if len(qs) == 0 {
		qs = uniqueStrings(allWords)
	}
	if len(qs) == 0 {
		return nil
	}
	joined := strings.Join(allWords, "")
	// /^\S+$/.test(question.trim()) ? question.trim().replace(/\(\)$/, "") : null
	rawQuery := ""
	if trimmed := jsTrim(question); trimmed != "" && strings.IndexFunc(trimmed, isSpace) < 0 {
		rawQuery = strings.TrimSuffix(trimmed, "()")
	}
	keepDemoted := false
	for _, q := range qs {
		if demoteExemptWords[q] {
			keepDemoted = true
			break
		}
	}

	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	files := newOMap[string, *rankFileInfo]() // rel -> { node, labels, pathWords, tf, len }
	fileOf := func(rel string) *rankFileInfo {
		f, ok := files.Get(rel)
		if !ok {
			f = &rankFileInfo{pathWords: newOSet(wordsOf(rel)...)}
			files.Set(rel, f)
		}
		return f
	}
	isFileHead := func(n *Node) bool {
		return n.SourceLocation == "L1" && n.Label == posixBasename(n.SourceFile)
	}
	topLevel := map[string]bool{}
	for _, e := range graph.Edges {
		if e.Relation != "contains" && e.Relation != "defines" {
			continue
		}
		a := byID[e.Source]
		if a != nil && a.SourceFile != "" && isFileHead(a) {
			topLevel[e.Target] = true
		}
	}
	for _, n := range graph.Nodes {
		if n.SourceFile == "" {
			continue
		}
		f := fileOf(n.SourceFile)
		if isFileHead(n) && f.node == nil {
			f.node = n
			if n.Terms != "" {
				f.tf = newOMap[string, float64]()
				for _, pair := range strings.Split(n.Terms, " ") {
					at := strings.LastIndexByte(pair, ':')
					if at > 0 {
						c := jsToNumber(pair[at+1:])
						if !truthy(c) {
							c = 1
						}
						f.tf.Set(pair[:at], c)
					}
				}
				f.length = float64(n.Tokens)
			}
			continue
		}
		raw := strings.TrimPrefix(strings.TrimSuffix(n.Label, "()"), ".")
		w := wordsOf(raw)
		if len(w) > 0 {
			words := uniqueStrings(w)
			f.labels = append(f.labels, &rankLabel{
				id: n.ID, words: words, w: strSet(words...), joined: strings.Join(w, ""), n: len(w), raw: raw,
				top: topLevel[n.ID] && n.Type != "impl",
			})
		}
	}
	// rarity of a word: over the stored keywords, else over labels and paths
	df := map[string]int{}
	withText := 0
	totalLen := 0.0
	for _, f := range files.Values() {
		seen := map[string]bool{}
		see := func(t string) {
			if !seen[t] {
				seen[t] = true
				df[t]++
			}
		}
		for _, t := range f.pathWords.Items() {
			see(t)
		}
		if f.tf != nil {
			withText++
			totalLen += f.length
			for _, t := range f.tf.Keys() {
				see(t)
			}
		}
		for _, l := range f.labels {
			for _, t := range l.words {
				see(t)
			}
		}
	}
	nFiles := float64(files.Len())
	if nFiles == 0 {
		nFiles = 1
	}
	avgLen := 1.0
	if withText > 0 {
		avgLen = totalLen / float64(withText)
	}
	idf := func(t string) float64 {
		d := float64(df[t])
		return jsLog(1 + (nFiles-d+0.5)/(d+0.5))
	}

	// Variables, so the arithmetic below is float64 arithmetic at run time
	// (Go folds constant expressions exactly); the float64() conversions keep
	// a product from being fused into the following addition.
	var k1, bb, labelWeight, pathWeight, substring, demote float64 = bm25K1, bm25B, rankLabelWeight, rankPathWeight, rankSubstring, rankDemote

	type hit struct {
		ex    float64
		value float64
		id    string
	}
	var ranked []rankedFile
	for rel, f := range files.All() {
		lex := 0.0
		if f.tf != nil {
			for _, q := range qs {
				tf := f.tf.G(q)
				if truthy(tf) {
					length := f.length
					if !truthy(length) {
						length = avgLen
					}
					num := float64(idf(q) * float64(tf*float64(k1+1)))
					den := tf + float64(k1*float64(float64(1-bb)+float64(float64(bb*length)/avgLen)))
					lex += num / den
				}
			}
		}
		best, exact := 0.0, 0.0
		var hits []hit
		for _, l := range f.labels {
			matched, weight := 0.0, 0.0
			for _, q := range qs {
				if l.w[q] {
					matched++
					weight += idf(q)
				} else if len(q) >= 4 && strings.Contains(l.joined, q) {
					matched += substring
					weight += float64(substring * idf(q))
				}
			}
			isExact := l.joined == joined
			if !truthy(matched) && !isExact {
				continue
			}
			coverage := matched / float64(len(qs))
			value := float64(float64(weight*coverage) * float64(0.5+float64(0.5*float64(matched/math.Max(float64(l.n), matched)))))
			ex := 0.0
			if isExact {
				ex = 0.5
				if l.top {
					ex = 1
				}
				if rawQuery != "" && l.raw == rawQuery {
					ex += 0.5
				}
			}
			if value > best {
				best = value
			}
			if ex > exact {
				exact = ex
			}
			hits = append(hits, hit{ex, value, l.id})
		}
		pathScore := 0.0
		for _, q := range qs {
			if f.pathWords.Has(q) {
				pathScore += idf(q)
			}
		}
		base := float64(lex+float64(labelWeight*best)) + float64(pathWeight*pathScore)
		score := base
		if truthy(exact) {
			score = float64(float64(1000*exact)-float64(float64(jsutil.LenUTF16(rel))*0.01)) + float64(base*0.001)
		}
		if score <= 0 {
			continue
		}
		if !keepDemoted && demotedPathRe.TestS(rel) {
			score = float64(score * demote)
		}
		sort.SliceStable(hits, func(i, j int) bool {
			a, b := hits[i], hits[j]
			if d := b.ex - a.ex; truthy(d) {
				return d < 0
			}
			if d := b.value - a.value; truthy(d) {
				return d < 0
			}
			return a.id < b.id
		})
		var nodes []*Node
		for i := 0; i < len(hits) && i < 2; i++ {
			nodes = append(nodes, byID[hits[i].id])
		}
		if len(nodes) == 0 && f.node != nil {
			nodes = append(nodes, f.node)
		}
		if len(nodes) > 0 {
			ranked = append(ranked, rankedFile{Rel: rel, Score: score, Nodes: nodes})
		}
	}
	relLen := make(map[string]int, len(ranked))
	for _, r := range ranked {
		relLen[r.Rel] = jsutil.LenUTF16(r.Rel)
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if d := b.Score - a.Score; truthy(d) {
			return d < 0
		}
		if la, lb := relLen[a.Rel], relLen[b.Rel]; la != lb {
			return la < lb
		}
		return a.Rel < b.Rel
	})
	return ranked
}

// jsLog is `Math.log(x)` as V8 computes it (fdlibm's __ieee754_log, the code
// of v8/src/base/ieee754.cc). Go's math.Log is the same algorithm without
// fdlibm's second evaluation branch, so the two differ in the last bit for
// some arguments — enough to change a printed score or flip a near tie in a
// ranking. The float64() conversions keep a product from being fused into
// the neighbouring addition on architectures with FMA.
func jsLog(x float64) float64 {
	const (
		ln2Hi = 6.93147180369123816490e-01 /* 3fe62e42 fee00000 */
		ln2Lo = 1.90821492927058770002e-10 /* 3dea39ef 35793c76 */
		two54 = 1.80143985094819840000e+16 /* 43500000 00000000 */
		lg1   = 6.666666666666735130e-01   /* 3FE55555 55555593 */
		lg2   = 3.999999999940941908e-01   /* 3FD99999 9997FA04 */
		lg3   = 2.857142874366239149e-01   /* 3FD24924 94229359 */
		lg4   = 2.222219843214978396e-01   /* 3FCC71C5 1D8E78AF */
		lg5   = 1.818357216161805012e-01   /* 3FC74664 96CB03DE */
		lg6   = 1.531383769920937332e-01   /* 3FC39A09 D078C69F */
		lg7   = 1.479819860511658591e-01   /* 3FC2F112 DF3E5244 */
	)
	bits := math.Float64bits(x)
	hx := int32(bits >> 32)
	lx := uint32(bits)

	k := int32(0)
	if hx < 0x00100000 { /* x < 2**-1022  */
		if (uint32(hx)&0x7fffffff)|lx == 0 {
			return math.Inf(-1) /* log(+-0)=-inf */
		}
		if hx < 0 {
			return math.NaN() /* log(-#) = NaN */
		}
		k -= 54
		x *= two54 /* subnormal number, scale up x */
		bits = math.Float64bits(x)
		hx = int32(bits >> 32)
	}
	if hx >= 0x7ff00000 {
		return x + x
	}
	k += (hx >> 20) - 1023
	hx &= 0x000fffff
	i := (hx + 0x95f64) & 0x100000
	/* normalize x or x/2 */
	x = math.Float64frombits(uint64(uint32(hx|(i^0x3ff00000)))<<32 | (bits & 0xffffffff))
	k += i >> 20
	f := x - 1.0
	if (0x000fffff & (2 + hx)) < 3 { /* -2**-20 <= f < 2**-20 */
		if f == 0 {
			if k == 0 {
				return 0
			}
			dk := float64(k)
			return float64(dk*ln2Hi) + float64(dk*ln2Lo)
		}
		r := float64(float64(f*f) * float64(0.5-float64(0.33333333333333333*f)))
		if k == 0 {
			return f - r
		}
		dk := float64(k)
		return float64(dk*ln2Hi) - ((r - float64(dk*ln2Lo)) - f)
	}
	s := f / (2.0 + f)
	dk := float64(k)
	z := float64(s * s)
	i = hx - 0x6147a
	w := float64(z * z)
	j := 0x6b851 - hx
	t1 := float64(w * float64(lg2+float64(w*float64(lg4+float64(w*lg6)))))
	t2 := float64(z * float64(lg1+float64(w*float64(lg3+float64(w*float64(lg5+float64(w*lg7)))))))
	i |= j
	r := t2 + t1
	if i > 0 {
		hfsq := float64(float64(0.5*f) * f)
		if k == 0 {
			return f - (hfsq - float64(s*float64(hfsq+r)))
		}
		return float64(dk*ln2Hi) - ((hfsq - float64(float64(s*float64(hfsq+r))+float64(dk*ln2Lo))) - f)
	}
	if k == 0 {
		return f - float64(s*float64(f-r))
	}
	return float64(dk*ln2Hi) - ((float64(s*float64(f-r)) - float64(dk*ln2Lo)) - f)
}
