package kg

import (
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// ---------------------------------------------------------------------------
// JavaScript-flavoured helpers the commands, the report and the exports share
// ---------------------------------------------------------------------------

// cmdLog is `console.log(s)` / `console.error(s)` on the given stream.
func cmdLog(w io.Writer, s string) {
	_, _ = io.WriteString(w, s+"\n")
}

// cmdNum prints a number as a JavaScript template literal does.
func cmdNum[T int | float64](v T) string {
	return jsNumber(float64(v))
}

// cmdLower is `s.toLowerCase()` (full Unicode lowercasing, final sigma included).
func cmdLower(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return cases.Lower(language.Und).String(s)
		}
	}
	return strings.ToLower(s)
}

// cmdSliceUTF16 is `s.slice(0, n)` as it reaches a stream or a file name: a
// surrogate pair cut in half leaves a lone surrogate, which Node writes as
// U+FFFD.
func cmdSliceUTF16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	units := utf16.Encode([]rune(s))
	if n >= len(units) {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// cmdLenUTF16 is `s.length`.
func cmdLenUTF16(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return len(utf16.Encode([]rune(s)))
		}
	}
	return len(s)
}

// cmdSplitSpace is `s.split(/\s+/)`: empty leading / trailing pieces are kept.
func cmdSplitSpace(s string) []string {
	out := []string{}
	r := []rune(s)
	start := 0
	for i := 0; i < len(r); {
		if !isSpace(r[i]) {
			i++
			continue
		}
		j := i
		for j < len(r) && isSpace(r[j]) {
			j++
		}
		out = append(out, string(r[start:i]))
		start = j
		i = j
	}
	return append(out, string(r[start:]))
}

// cmdParseInt is `parseInt(s, 10)`; ok is false for NaN.
func cmdParseInt(s string) (float64, bool) {
	r := []rune(s)
	i := 0
	for i < len(r) && isSpace(r[i]) {
		i++
	}
	neg := false
	if i < len(r) && (r[i] == '+' || r[i] == '-') {
		neg = r[i] == '-'
		i++
	}
	j := i
	for j < len(r) && r[j] >= '0' && r[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	// a digit run too long for a float64 is ±Infinity, as in JS
	v, _ := strconv.ParseFloat(string(r[i:j]), 64)
	if neg {
		v = -v
	}
	return v, true
}

// cmdBasename is `path.basename(p)` (POSIX) on a file system path.
func cmdBasename(p string) string {
	end := len(p)
	for end > 0 && p[end-1] == '/' {
		end--
	}
	if end == 0 {
		return ""
	}
	start := strings.LastIndexByte(p[:end], '/') + 1
	return p[start:end]
}

// cmdByID is `new Map(graph.nodes.map((n) => [n.id, n]))` (lookups only).
func cmdByID(graph *Graph) map[string]*Node {
	byID := make(map[string]*Node, len(graph.Nodes))
	for _, n := range graph.Nodes {
		byID[n.ID] = n
	}
	return byID
}

// cmdLabel is `(byId.get(id) || {}).label || id`.
func cmdLabel(byID map[string]*Node, id string) string {
	if n := byID[id]; n != nil && n.Label != "" {
		return n.Label
	}
	return id
}

// cmdCommunity is
// `d.community_name != null ? d.community_name : (d.community != null ? d.community : "")`.
func cmdCommunity(d *Node) string {
	if d.CommunityName != "" {
		return d.CommunityName
	}
	if d.HasCommunity {
		return strconv.Itoa(d.Community)
	}
	return ""
}

// cmdWriteFile is writeFileAtomic: the data goes to a temporary file in the
// same directory that is renamed into place, so an interrupted build leaves
// the previous file whole and a reader never sees a half-written one. The
// temporary name is short and does not build on the target's, which may
// already be as long as a name can be.
func cmdWriteFile(p, data string) error {
	tmp := filepath.Join(filepath.Dir(p), ".kg-"+strconv.Itoa(os.Getpid())+".tmp")
	if err := os.WriteFile(tmp, []byte(data), 0o666); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// cmdWriteIfChanged rewrites p only when its content differs.
func cmdWriteIfChanged(p, next string) error {
	prev, err := os.ReadFile(p)
	if err == nil && string(prev) == next {
		return nil
	}
	return cmdWriteFile(p, next)
}

// ---------------------------------------------------------------------------
// Ordered JSON values: `JSON.stringify(value, null, N)` byte for byte
// ---------------------------------------------------------------------------

// jsonValue is a JSON tree whose objects keep their insertion order.
type jsonValue interface {
	writeJSON(sb *strings.Builder, gap, cur string)
}

type (
	jvStr  string
	jvNum  float64
	jvBool bool
	jvNull struct{}
	jvArr  []jsonValue
)

// jvObj is an object literal: keys in insertion order, `undefined` never set.
type jvObj struct {
	keys []string
	vals []jsonValue
}

func newJvObj() *jvObj { return &jvObj{} }

// Set keeps the position of an existing key and returns the object.
func (o *jvObj) Set(k string, v jsonValue) *jvObj {
	for i, have := range o.keys {
		if have == k {
			o.vals[i] = v
			return o
		}
	}
	o.keys = append(o.keys, k)
	o.vals = append(o.vals, v)
	return o
}

// jvStrings is an array of strings.
func jvStrings(items []string) jvArr {
	arr := make(jvArr, 0, len(items))
	for _, s := range items {
		arr = append(arr, jvStr(s))
	}
	return arr
}

// jvQuote is JSON.stringify of a string: only `"`, `\` and control characters
// below 0x20 are escaped.
func jvQuote(sb *strings.Builder, s string) {
	const hex = "0123456789abcdef"
	sb.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			sb.WriteString(`\"`)
		case c == '\\':
			sb.WriteString(`\\`)
		case c == '\b':
			sb.WriteString(`\b`)
		case c == '\f':
			sb.WriteString(`\f`)
		case c == '\n':
			sb.WriteString(`\n`)
		case c == '\r':
			sb.WriteString(`\r`)
		case c == '\t':
			sb.WriteString(`\t`)
		case c < 0x20:
			sb.WriteString(`\u00`)
			sb.WriteByte(hex[c>>4])
			sb.WriteByte(hex[c&15])
		default:
			sb.WriteByte(c)
		}
	}
	sb.WriteByte('"')
}

func (v jvStr) writeJSON(sb *strings.Builder, gap, cur string) { jvQuote(sb, string(v)) }

func (v jvNum) writeJSON(sb *strings.Builder, gap, cur string) {
	f := float64(v)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		sb.WriteString("null")
		return
	}
	sb.WriteString(jsNumber(f))
}

func (v jvBool) writeJSON(sb *strings.Builder, gap, cur string) {
	if v {
		sb.WriteString("true")
	} else {
		sb.WriteString("false")
	}
}

func (jvNull) writeJSON(sb *strings.Builder, gap, cur string) { sb.WriteString("null") }

func (v jvArr) writeJSON(sb *strings.Builder, gap, cur string) {
	if len(v) == 0 {
		sb.WriteString("[]")
		return
	}
	inner := cur + gap
	sb.WriteByte('[')
	for i, item := range v {
		if i > 0 {
			sb.WriteByte(',')
		}
		if gap != "" {
			sb.WriteByte('\n')
			sb.WriteString(inner)
		}
		if item == nil {
			sb.WriteString("null")
		} else {
			item.writeJSON(sb, gap, inner)
		}
	}
	if gap != "" {
		sb.WriteByte('\n')
		sb.WriteString(cur)
	}
	sb.WriteByte(']')
}

func (o *jvObj) writeJSON(sb *strings.Builder, gap, cur string) {
	if o == nil {
		sb.WriteString("null")
		return
	}
	if len(o.keys) == 0 {
		sb.WriteString("{}")
		return
	}
	inner := cur + gap
	sb.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		if gap != "" {
			sb.WriteByte('\n')
			sb.WriteString(inner)
		}
		jvQuote(sb, k)
		sb.WriteByte(':')
		if gap != "" {
			sb.WriteByte(' ')
		}
		if o.vals[i] == nil {
			sb.WriteString("null")
		} else {
			o.vals[i].writeJSON(sb, gap, inner)
		}
	}
	if gap != "" {
		sb.WriteByte('\n')
		sb.WriteString(cur)
	}
	sb.WriteByte('}')
}

// stringifyJSON is `JSON.stringify(v, null, indent)`; indent 0 is the compact form.
func stringifyJSON(v jsonValue, indent int) string {
	if indent > 10 {
		indent = 10
	}
	if indent < 0 {
		indent = 0
	}
	var sb strings.Builder
	if v == nil {
		return "null"
	}
	v.writeJSON(&sb, strings.Repeat(" ", indent), "")
	return sb.String()
}

// ---------------------------------------------------------------------------

func findNode(graph *Graph, label string) []string {
	term := strings.Join(searchTokens(label), " ")
	if term == "" {
		return []string{}
	}
	var bySource, exact, prefix, substr []string
	labelLower := cmdLower(label)
	for _, n := range graph.Nodes {
		normLabel := nodeNormLabel(n)
		tokens := strings.Join(searchTokens(n.Label), " ")
		if cmdLower(n.SourceFile) == labelLower {
			bySource = append(bySource, n.ID)
		} else if term == normLabel || term == tokens || term == cmdLower(n.ID) {
			exact = append(exact, n.ID)
		} else if strings.HasPrefix(normLabel, term) || strings.HasPrefix(tokens, term) {
			prefix = append(prefix, n.ID)
		} else if strings.Contains(normLabel, term) {
			substr = append(substr, n.ID)
		}
	}
	out := make([]string, 0, len(bySource)+len(exact)+len(prefix)+len(substr))
	out = append(out, bySource...)
	out = append(out, exact...)
	out = append(out, prefix...)
	out = append(out, substr...)
	return out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// A bad command line: reported with the usage text and a non-zero exit.
type kgUsageError struct{ message string }

func (e *kgUsageError) Error() string { return e.message }

// kgFlag is one entry of the JS `flags` object: `true`, a string, or an array
// of strings (a value flag given more than once).
type kgFlag struct {
	isBool bool
	isArr  bool
	s      string
	arr    []string
}

// truthy is the JS truthiness of the flag value; a missing flag is nil.
func (f *kgFlag) truthy() bool {
	if f == nil {
		return false
	}
	return f.isBool || f.isArr || f.s != ""
}

// list is `[].concat(value)`.
func (f *kgFlag) list() []string {
	if f.isArr {
		return append([]string{}, f.arr...)
	}
	return []string{f.s}
}

// parseInt is `parseInt(value, 10)`; ok is false for NaN.
func (f *kgFlag) parseInt() (float64, bool) {
	if f == nil || f.isBool {
		return 0, false
	}
	if f.isArr {
		return cmdParseInt(strings.Join(f.arr, ","))
	}
	return cmdParseInt(f.s)
}

// intOr is `parseInt(value, 10) || def`.
func (f *kgFlag) intOr(def float64) float64 {
	v, ok := f.parseInt()
	if !ok || v == 0 {
		return def
	}
	return v
}

// A value flag must be followed by its value (never by another flag); a
// missing one used to leave `true` behind for the command to choke on.
func parseFlags(args []string, valueFlags []string) (map[string]*kgFlag, []string, error) {
	flags := map[string]*kgFlag{}
	positional := []string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "--") {
			name := a[2:]
			isValue := false
			for _, v := range valueFlags {
				if v == name {
					isValue = true
					break
				}
			}
			if isValue {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
					return nil, nil, &kgUsageError{"--" + name + " requires a value"}
				}
				i++
				if prev := flags[name]; prev.truthy() {
					flags[name] = &kgFlag{isArr: true, arr: append(prev.list(), args[i])}
				} else {
					flags[name] = &kgFlag{s: args[i]}
				}
			} else {
				flags[name] = &kgFlag{isBool: true}
			}
		} else {
			positional = append(positional, a)
		}
	}
	return flags, positional, nil
}

func requireGraph(root string, stdout io.Writer) *Graph {
	g := loadGraph(root)
	if g == nil {
		cmdLog(stdout, "no graph — run `draht-tools kg build` first")
		return nil
	}
	return g
}

// kgCommand runs one command. It returns the exit code (the original's
// commands never call process.exit, so 0) or the error the original throws:
// a *kgUsageError, or anything else for an uncaught exception.
type kgCommand func(root string, args []string, stdout, stderr io.Writer) (int, error)

var kgCommands = map[string]kgCommand{
	"build":    kgBuild,
	"query":    kgQuery,
	"explain":  kgExplain,
	"path":     kgPath,
	"affected": kgAffected,
	"stats":    kgStats,
	"report":   kgReport,
	"export":   kgExport,
}

// cmdConfidencePct is the `pct` closure of build and report:
// `graph.edges.length ? Math.round((byConf[k] / graph.edges.length) * 100) : 0`.
func cmdConfidencePct(graph *Graph) func(k string) string {
	byConf := map[string]int{"EXTRACTED": 0, "INFERRED": 0, "AMBIGUOUS": 0}
	for _, e := range graph.Edges {
		byConf[e.Confidence]++
	}
	return func(k string) string {
		if len(graph.Edges) == 0 {
			return "0"
		}
		return jsNumber(math.Round((float64(byConf[k]) / float64(len(graph.Edges))) * 100))
	}
}

func kgBuild(root string, args []string, stdout, stderr io.Writer) (int, error) {
	flags, _, err := parseFlags(args, nil)
	if err != nil {
		return 0, err
	}
	t0 := time.Now()
	graph := buildGraph(root)
	jsonPath, err := writeGraph(root, graph)
	if err != nil {
		return 0, err
	}
	reportPath, err := writeReport(root, graph)
	if err != nil {
		return 0, err
	}
	codeNodes := 0
	for _, n := range graph.Nodes {
		if n.SourceFile != "" {
			codeNodes++
		}
	}
	if !flags["quiet"].truthy() {
		cmdLog(stdout, fmt.Sprintf("kg build: %d nodes (%d in-repo) · %d edges · %d communities · %dms",
			len(graph.Nodes), codeNodes, len(graph.Edges), len(graph.Communities), time.Since(t0).Milliseconds()))
		pct := cmdConfidencePct(graph)
		cmdLog(stdout, "confidence: "+pct("EXTRACTED")+"% EXTRACTED · "+pct("INFERRED")+"% INFERRED · "+pct("AMBIGUOUS")+"% AMBIGUOUS")
		if len(graph.IDCollisions) > 0 {
			cmdLog(stdout, fmt.Sprintf("warning: %d id collision(s) — graphify ids.py canonicalization merges these (first wins):", len(graph.IDCollisions)))
			for i, c := range graph.IDCollisions {
				if i >= 5 {
					break
				}
				cmdLog(stdout, "  "+c.ID+": kept "+c.Kept+", merged "+c.Dropped)
			}
			if len(graph.IDCollisions) > 5 {
				cmdLog(stdout, fmt.Sprintf("  … and %d more", len(graph.IDCollisions)-5))
			}
		}
		if len(graph.MethodLimitHits) > 0 {
			cmdLog(stdout, fmt.Sprintf("warning: %d class(es) declare more than %d methods — the rest are not indexed:", len(graph.MethodLimitHits), maxMethodsPerClass))
			for i, c := range graph.MethodLimitHits {
				if i >= 5 {
					break
				}
				cmdLog(stdout, fmt.Sprintf("  %s: %s (%d methods)", c.File, c.Name, c.Declared))
			}
			if len(graph.MethodLimitHits) > 5 {
				cmdLog(stdout, fmt.Sprintf("  … and %d more", len(graph.MethodLimitHits)-5))
			}
		}
		cmdLog(stdout, "→ "+jsonPath+"\n→ "+reportPath)
	}
	return 0, nil
}

// cmdRankedNodeIDs is `f.nodes` of one rankFiles entry, as node ids.
func cmdRankedNodeIDs(f rankedFile) []string {
	ids := make([]string, 0, len(f.Nodes))
	for _, n := range f.Nodes {
		ids = append(ids, n.ID)
	}
	return ids
}

// cmdRankFilesLimit is RANK_FILES: how many ranked files lead `kg query`.
const cmdRankFilesLimit = 10

func cmdContains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func kgQuery(root string, args []string, stdout, stderr io.Writer) (int, error) {
	flags, positional, err := parseFlags(args, []string{"depth", "budget", "context"})
	if err != nil {
		return 0, err
	}
	question := strings.Join(positional, " ")
	if question == "" {
		cmdLog(stdout, `usage: kg query "<question>" [--dfs] [--depth N] [--budget N] [--context C]`)
		return 0, nil
	}
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	// The files that answer the question lead the output, best first, each
	// through its matching symbols; the traversal then starts from the best
	// three and adds what they connect to.
	ranked := rankFiles(graph, question)
	if len(ranked) > cmdRankFilesLimit {
		ranked = ranked[:cmdRankFilesLimit]
	}
	seeds := []string{}
	for _, f := range ranked {
		for _, nid := range cmdRankedNodeIDs(f) {
			if !cmdContains(seeds, nid) {
				seeds = append(seeds, nid)
			}
		}
	}
	if len(seeds) == 0 {
		cmdLog(stdout, "No matching nodes found.")
		return 0, nil
	}
	startNodes := []string{}
	for i, f := range ranked {
		if i >= 3 {
			break
		}
		for _, nid := range cmdRankedNodeIDs(f) {
			if !cmdContains(startNodes, nid) {
				startNodes = append(startNodes, nid)
			}
		}
	}
	mode := "bfs"
	if flags["dfs"].truthy() {
		mode = "dfs"
	}
	depth := math.Min(6, flags["depth"].intOr(2))
	budget := flags["budget"].intOr(2000)
	var contextFilter []string // nil: null
	if flags["context"].truthy() {
		contextFilter = flags["context"].list()
	}
	// Every negative depth traverses nothing; a budget beyond any text length
	// never truncates. Both are clamped to fit an int.
	depthInt := int(math.Max(depth, -1))
	budgetInt := int(math.Max(-1e15, math.Min(1e15, budget)))
	t := traverse(graph, startNodes, depthInt, mode, contextFilter)
	for _, nid := range seeds {
		t.Visited.Add(nid)
	}
	byID := cmdByID(graph)
	startLabels := make([]string, 0, len(startNodes))
	for _, s := range startNodes {
		startLabels = append(startLabels, cmdLabel(byID, s))
	}
	headerParts := []string{"Traversal: " + strings.ToUpper(mode) + " depth=" + jsNumber(depth), "Start: [" + strings.Join(startLabels, ", ") + "]"}
	if contextFilter != nil {
		headerParts = append(headerParts, "Context: "+strings.Join(contextFilter, ", "))
	}
	headerParts = append(headerParts, strconv.Itoa(t.Visited.Len())+" nodes found")
	cmdLog(stdout, strings.Join(headerParts, " | ")+"\n")
	cmdLog(stdout, subgraphToText(graph, t.Visited, t.EdgesSeen, t.Edges, t.Deg, budgetInt, seeds))
	return 0, nil
}

// cmdConnection is one `[arrow, neighbor id, edge]` triple.
type cmdConnection struct {
	arrow string
	nb    string
	e     *Edge
}

func kgExplain(root string, args []string, stdout, stderr io.Writer) (int, error) {
	_, positional, err := parseFlags(args, nil)
	if err != nil {
		return 0, err
	}
	label := strings.Join(positional, " ")
	if label == "" {
		cmdLog(stdout, `usage: kg explain "<node>"`)
		return 0, nil
	}
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	matches := findNode(graph, label)
	if len(matches) == 0 {
		cmdLog(stdout, "No node matching '"+label+"' found.")
		return 0, nil
	}
	byID := cmdByID(graph)
	nid := matches[0]
	d := byID[nid]
	adj := buildAdjacency(graph)
	name := d.Label
	if name == "" {
		name = nid
	}
	cmdLog(stdout, "Node: "+name)
	cmdLog(stdout, "  ID:        "+nid)
	cmdLog(stdout, strings.TrimRightFunc("  Source:    "+d.SourceFile+" "+d.SourceLocation, isSpace))
	typ := d.Type
	if typ == "" {
		typ = d.FileType
	}
	cmdLog(stdout, "  Type:      "+typ)
	cmdLog(stdout, "  Community: "+cmdCommunity(d))
	cmdLog(stdout, "  Degree:    "+strconv.Itoa(adj.deg.G(nid)))
	connections := []cmdConnection{}
	for _, e := range adj.out.G(nid) {
		connections = append(connections, cmdConnection{"-->", e.Target, e})
	}
	for _, e := range adj.inn.G(nid) {
		connections = append(connections, cmdConnection{"<--", e.Source, e})
	}
	if len(connections) > 0 {
		cmdLog(stdout, fmt.Sprintf("\nConnections (%d):", len(connections)))
		sort.SliceStable(connections, func(i, j int) bool {
			a, b := connections[i], connections[j]
			da, db := adj.deg.G(a.nb), adj.deg.G(b.nb)
			if da != db {
				return db < da
			}
			return a.nb < b.nb
		})
		for i, c := range connections {
			if i >= 20 {
				break
			}
			cmdLog(stdout, "  "+c.arrow+" "+cmdLabel(byID, c.nb)+" ["+c.e.Relation+"] ["+c.e.Confidence+"]")
		}
		if len(connections) > 20 {
			cmdLog(stdout, fmt.Sprintf("  ... and %d more", len(connections)-20))
		}
	}
	if d.Rationale != "" {
		cmdLog(stdout, "\nRationale: "+cmdSliceUTF16(d.Rationale, 300))
	}
	return 0, nil
}

func kgPath(root string, args []string, stdout, stderr io.Writer) (int, error) {
	_, positional, err := parseFlags(args, nil)
	if err != nil {
		return 0, err
	}
	if len(positional) < 2 {
		cmdLog(stdout, `usage: kg path "<source>" "<target>"`)
		return 0, nil
	}
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	srcLabel, tgtLabel := positional[0], positional[1]
	srcScored := scoreNodes(graph, cmdSplitSpace(cmdLower(srcLabel)))
	tgtScored := scoreNodes(graph, cmdSplitSpace(cmdLower(tgtLabel)))
	if len(srcScored) == 0 {
		cmdLog(stdout, "No node matching '"+srcLabel+"' found.")
		return 0, nil
	}
	if len(tgtScored) == 0 {
		cmdLog(stdout, "No node matching '"+tgtLabel+"' found.")
		return 0, nil
	}
	src := pickScoredEndpoint(graph, srcScored, srcLabel)
	tgt := pickScoredEndpoint(graph, tgtScored, tgtLabel)
	if src == tgt {
		cmdLog(stdout, "'"+srcLabel+"' and '"+tgtLabel+"' both resolved to the same node '"+src+"'. Use a more specific label.")
		return 0, nil
	}
	nbrs := undirectedNeighbors(graph).Nbrs
	// External module nodes (no source_file) are import hubs shared by everything —
	// a "path" through node:fs connects nothing meaningfully, so they can't be transit.
	byIDT := cmdByID(graph)
	isTransit := func(id string) bool {
		if id == src || id == tgt {
			return true
		}
		n := byIDT[id]
		return n != nil && n.SourceFile != ""
	}
	prev := map[string]string{src: ""} // src maps to null: the chain stops there
	q := []string{src}
	for len(q) > 0 {
		cur := q[0]
		q = q[1:]
		if cur == tgt {
			break
		}
		if !isTransit(cur) {
			continue
		}
		sorted := nbrs.G(cur).Items()
		sort.Strings(sorted)
		for _, nb := range sorted {
			if _, ok := prev[nb]; !ok {
				prev[nb] = cur
				q = append(q, nb)
			}
		}
	}
	if _, ok := prev[tgt]; !ok {
		cmdLog(stdout, "No path found between '"+srcLabel+"' and '"+tgtLabel+"'.")
		return 0, nil
	}
	chain := []string{}
	for x := tgt; ; x = prev[x] {
		chain = append(chain, x)
		if x == src {
			break
		}
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	byID := cmdByID(graph)
	// directed arrow recovery per hop
	dirEdge := make(map[string]*Edge, len(graph.Edges))
	for _, e := range graph.Edges {
		dirEdge[e.Source+" "+e.Target] = e
	}
	line := cmdLabel(byID, chain[0])
	for i := 0; i < len(chain)-1; i++ {
		fwd := dirEdge[chain[i]+" "+chain[i+1]]
		rev := dirEdge[chain[i+1]+" "+chain[i]]
		e := fwd
		if e == nil {
			e = rev
		}
		relation, confidence := "undefined", "undefined"
		if e != nil {
			relation, confidence = e.Relation, e.Confidence
		}
		var arrow string
		if fwd != nil {
			arrow = "--" + relation + " [" + confidence + "]-->"
		} else {
			arrow = "<--" + relation + " [" + confidence + "]--"
		}
		line += " " + arrow + " " + cmdLabel(byID, chain[i+1])
	}
	cmdLog(stdout, fmt.Sprintf("Shortest path (%d hops): %s", len(chain)-1, line))
	return 0, nil
}

// cmdAffectedHit is one `{ id, depth, via }` of `kg affected`.
type cmdAffectedHit struct {
	id    string
	depth int
	via   string
}

func kgAffected(root string, args []string, stdout, stderr io.Writer) (int, error) {
	flags, positional, err := parseFlags(args, []string{"depth", "relation"})
	if err != nil {
		return 0, err
	}
	label := strings.Join(positional, " ")
	if label == "" {
		cmdLog(stdout, `usage: kg affected "<node>" [--depth N] [--relation R]`)
		return 0, nil
	}
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	matches := findNode(graph, label)
	if len(matches) == 0 {
		cmdLog(stdout, "No node matching '"+label+"' found.")
		return 0, nil
	}
	start := matches[0]
	depth := flags["depth"].intOr(2)
	relationList := defaultAffectedRelations
	if flags["relation"].truthy() {
		relationList = flags["relation"].list()
	}
	relations := make(map[string]bool, len(relationList))
	for _, r := range relationList {
		relations[r] = true
	}
	// reverse traversal: who depends on start (edges pointing AT the affected set)
	rin := map[string][]*Edge{}
	for _, e := range graph.Edges {
		if !relations[e.Relation] {
			continue
		}
		rin[e.Target] = append(rin[e.Target], e)
	}
	byID := cmdByID(graph)
	hits := []cmdAffectedHit{}
	seen := map[string]bool{start: true}
	frontier := []string{start}
	for d := 1; float64(d) <= depth && len(frontier) > 0; d++ {
		next := []string{}
		for _, nid := range frontier {
			for _, e := range rin[nid] {
				if seen[e.Source] {
					continue
				}
				seen[e.Source] = true
				hits = append(hits, cmdAffectedHit{id: e.Source, depth: d, via: e.Relation})
				next = append(next, e.Source)
			}
		}
		frontier = next
	}
	cmdLog(stdout, "Affected by changes to '"+cmdLabel(byID, start)+"' (depth "+jsNumber(depth)+"): "+strconv.Itoa(len(hits))+" nodes")
	curDepth := 0
	for _, h := range hits {
		if h.depth != curDepth {
			curDepth = h.depth
			cmdLog(stdout, fmt.Sprintf("\n  depth %d:", curDepth))
		}
		sourceFile, loc := "", ""
		if n := byID[h.id]; n != nil {
			sourceFile = n.SourceFile
			if n.SourceLocation != "" {
				loc = ":" + n.SourceLocation
			}
		}
		cmdLog(stdout, "    "+cmdLabel(byID, h.id)+" [via "+h.via+"] ("+sourceFile+loc+")")
	}
	return 0, nil
}

func kgStats(root string, args []string, stdout, stderr io.Writer) (int, error) {
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	byConf, byRel := newOMap[string, int](), newOMap[string, int]()
	for _, e := range graph.Edges {
		byConf.Set(e.Confidence, byConf.G(e.Confidence)+1)
		byRel.Set(e.Relation, byRel.G(e.Relation)+1)
	}
	cmdLog(stdout, fmt.Sprintf("nodes: %d · edges: %d · communities: %d", len(graph.Nodes), len(graph.Edges), len(graph.Communities)))
	// `Object.entries(byConf).sort()` compares the entries as strings: "key,count".
	conf := []string{}
	confKey := map[string]string{}
	for k, v := range byConf.All() {
		pair := k + "=" + strconv.Itoa(v)
		conf = append(conf, pair)
		confKey[pair] = k + "," + strconv.Itoa(v)
	}
	sort.SliceStable(conf, func(i, j int) bool { return confKey[conf[i]] < confKey[conf[j]] })
	cmdLog(stdout, "confidence: "+strings.Join(conf, " · "))
	cmdLog(stdout, "relations:")
	rels := byRel.Keys()
	sort.SliceStable(rels, func(i, j int) bool { return byRel.G(rels[j]) < byRel.G(rels[i]) })
	for _, k := range rels {
		cmdLog(stdout, "  "+k+": "+strconv.Itoa(byRel.G(k)))
	}
	return 0, nil
}

func kgReport(root string, args []string, stdout, stderr io.Writer) (int, error) {
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	p, err := writeReport(root, graph)
	if err != nil {
		return 0, err
	}
	cmdLog(stdout, "→ "+p)
	return 0, nil
}

// ---------------------------------------------------------------------------
// Exports: tree html / wiki / graphml
// ---------------------------------------------------------------------------

func kgExport(root string, args []string, stdout, stderr io.Writer) (int, error) {
	flags, positional, err := parseFlags(args, []string{"output"})
	if err != nil {
		return 0, err
	}
	format := ""
	if len(positional) > 0 {
		format = positional[0]
	}
	graph := requireGraph(root, stdout)
	if graph == nil {
		return 0, nil
	}
	// A repeated `--output` keeps the last one.
	output := ""
	if f := flags["output"]; f != nil {
		if f.isArr {
			output = f.arr[len(f.arr)-1]
		} else {
			output = f.s
		}
	}
	var p string
	switch format {
	case "tree":
		p, err = exportTree(root, graph, output)
	case "wiki":
		p, err = exportWiki(root, graph)
	case "graphml":
		p, err = exportGraphml(root, graph, output)
	default:
		cmdLog(stdout, "usage: kg export tree|wiki|graphml [--output path]")
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	cmdLog(stdout, "→ "+p)
	return 0, nil
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const kgHelp = `draht-kg — graphify-parity symbol-level knowledge graph (deterministic, no LLM)

Usage: draht-tools kg <command> [args]

  build [--quiet]                 Index the repo → .planning/codebase/graph.json + KG_REPORT.md
  query "<question>" [--dfs] [--depth N] [--budget N] [--context C]
                                  Best files for the question first, then a BFS/DFS subgraph from them (NODE/EDGE output)
  explain "<node>"                Node dump: id, source, community, degree, connections
  path "<a>" "<b>"                Shortest path with directed arrows and confidence
  affected "<node>" [--depth N] [--relation R]
                                  Reverse blast-radius over calls/imports/inherits/…
  stats                           Node/edge/relation/confidence counts
  report                          Regenerate KG_REPORT.md
  export tree|wiki|graphml        GRAPH_TREE.html / kg-wiki/ / graph.graphml

Languages: TypeScript, JavaScript, Python, Go, Rust. Nodes are symbols (files,
classes, functions(), methods(), types, constants); edges carry graphify's
relation set with EXTRACTED/INFERRED/AMBIGUOUS confidence. graph.json is
node-link format, directed — loadable by graphify's own tooling.`

// `kgCommands` is a plain object in the original, so a command named after an
// Object.prototype member is "found" there. These run without output …
var kgPrototypeNoops = strSet("constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
	"toLocaleString", "toString", "valueOf", "__lookupGetter__", "__lookupSetter__")

// … and these throw a TypeError when called.
var kgPrototypeThrows = strSet("__proto__", "__defineGetter__", "__defineSetter__")

// Main is kgMain: argv is what follows `kg` on the command line; the result
// is the process exit code.
func Main(argv []string, stdout, stderr io.Writer) int {
	cmd := ""
	var args []string
	if len(argv) > 0 {
		cmd, args = argv[0], argv[1:]
	}
	if cmd == "" || cmd == "help" || cmd == "--help" || cmd == "-h" {
		cmdLog(stdout, kgHelp)
		return 0
	}
	run, ok := kgCommands[cmd]
	if !ok {
		if kgPrototypeNoops[cmd] {
			return 0
		}
		if kgPrototypeThrows[cmd] {
			cmdLog(stderr, "TypeError: kgCommands[cmd] is not a function")
			return 1
		}
		cmdLog(stderr, "unknown kg command: "+cmd+"\n")
		cmdLog(stdout, kgHelp)
		return 1
	}
	cwd, err := os.Getwd()
	if err != nil {
		cmdLog(stderr, err.Error())
		return 1
	}
	root := findRepoRoot(cwd)
	code, err := run(root, args, stdout, stderr)
	if err != nil {
		if usage, isUsage := err.(*kgUsageError); isUsage {
			cmdLog(stderr, "kg "+cmd+": "+usage.message+"\n")
			cmdLog(stdout, kgHelp)
			return 1
		}
		// an uncaught exception in the original
		cmdLog(stderr, err.Error())
		return 1
	}
	return code
}
