package kg

import (
	"encoding/json"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// graph.json IO
// ---------------------------------------------------------------------------

func outDir(root string) string {
	return filepath.Join(root, outDirname)
}

// jsNumber is `String(f)` / a number in a template string: integers without
// a decimal point, otherwise the shortest decimal that reads back as f, laid
// out as ECMAScript's Number::toString does.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// "d.ddde±XX": the shortest round-trip digits and the decimal exponent.
	s := strconv.FormatFloat(f, 'e', -1, 64)
	ePos := strings.IndexByte(s, 'e')
	digits := strings.Replace(s[:ePos], ".", "", 1)
	exp, _ := strconv.Atoi(s[ePos+1:])
	k, n := len(digits), exp+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	es := "+"
	if e < 0 {
		es = "-"
		e = -e
	}
	if k == 1 {
		return sign + digits + "e" + es + strconv.Itoa(e)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(e)
}

// jsToFixed is `x.toFixed(digits)`: the exact binary value rounded to
// `digits` decimals, a tie going away from zero (strconv rounds a tie to
// even: 0.03125 → "0.0312", where JavaScript prints "0.0313").
func jsToFixed(x float64, digits int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.IsInf(x, 0) || math.Abs(x) >= 1e21 {
		return jsNumber(x)
	}
	neg := x < 0
	if neg {
		x = -x
	}
	r := new(big.Rat).SetFloat64(x)
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	r.Mul(r, new(big.Rat).SetInt(scale))
	r.Add(r, big.NewRat(1, 2))
	s := new(big.Int).Quo(r.Num(), r.Denom()).String()
	if digits > 0 {
		if len(s) <= digits {
			s = strings.Repeat("0", digits+1-len(s)) + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// jsonWriter writes what `JSON.stringify(value, null, 1)` writes.
type jsonWriter struct {
	b     []byte
	first []bool
}

func (w *jsonWriter) open(c byte) {
	w.b = append(w.b, c)
	w.first = append(w.first, true)
}

// sep starts the next member or element of the innermost container.
func (w *jsonWriter) sep() {
	top := len(w.first) - 1
	if w.first[top] {
		w.first[top] = false
	} else {
		w.b = append(w.b, ',')
	}
	w.b = append(w.b, '\n')
	for i := 0; i <= top; i++ {
		w.b = append(w.b, ' ')
	}
}

func (w *jsonWriter) close(c byte) {
	top := len(w.first) - 1
	empty := w.first[top]
	w.first = w.first[:top]
	if !empty {
		w.b = append(w.b, '\n')
		for i := 0; i < top; i++ {
			w.b = append(w.b, ' ')
		}
	}
	w.b = append(w.b, c)
}

func (w *jsonWriter) key(k string) {
	w.sep()
	w.str(k)
	w.b = append(w.b, ':', ' ')
}

const jsonHex = "0123456789abcdef"

// str is JSON.stringify of a string: only `"`, `\` and the control
// characters below 0x20 are escaped.
func (w *jsonWriter) str(s string) {
	w.b = append(w.b, '"')
	from := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		w.b = append(w.b, s[from:i]...)
		from = i + 1
		switch c {
		case '"':
			w.b = append(w.b, '\\', '"')
		case '\\':
			w.b = append(w.b, '\\', '\\')
		case '\b':
			w.b = append(w.b, '\\', 'b')
		case '\f':
			w.b = append(w.b, '\\', 'f')
		case '\n':
			w.b = append(w.b, '\\', 'n')
		case '\r':
			w.b = append(w.b, '\\', 'r')
		case '\t':
			w.b = append(w.b, '\\', 't')
		default:
			w.b = append(w.b, '\\', 'u', '0', '0', jsonHex[c>>4], jsonHex[c&0xf])
		}
	}
	w.b = append(w.b, s[from:]...)
	w.b = append(w.b, '"')
}

func (w *jsonWriter) num(f float64) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		w.b = append(w.b, "null"...)
		return
	}
	w.b = append(w.b, jsNumber(f)...)
}

func (w *jsonWriter) integer(i int) { w.b = strconv.AppendInt(w.b, int64(i), 10) }

func (w *jsonWriter) boolean(v bool) { w.b = strconv.AppendBool(w.b, v) }

func (w *jsonWriter) kStr(k, v string)         { w.key(k); w.str(v) }
func (w *jsonWriter) kNum(k string, v float64) { w.key(k); w.num(v) }
func (w *jsonWriter) kInt(k string, v int)     { w.key(k); w.integer(v) }
func (w *jsonWriter) kBool(k string, v bool)   { w.key(k); w.boolean(v) }

// graphJSON is the text of graph.json for a graph.
func graphJSON(graph *Graph) []byte {
	w := &jsonWriter{b: make([]byte, 0, 256*(len(graph.Nodes)+len(graph.Edges))+1024)}
	w.open('{')
	w.kBool("directed", true)
	w.kBool("multigraph", false)
	w.key("graph")
	w.open('{')
	w.kStr("generated_by", "draht-tools kg build")
	w.kStr("schema", "graphify-node-link")
	w.key("communities")
	w.open('[')
	for _, c := range graph.Communities {
		w.sep()
		w.open('{')
		w.kInt("id", c.ID)
		w.kStr("name", c.Name)
		w.kInt("size", c.Size)
		w.kNum("cohesion", c.Cohesion)
		w.close('}')
	}
	w.close(']')
	w.close('}')
	w.key("nodes")
	w.open('[')
	for _, n := range graph.Nodes {
		w.sep()
		w.open('{')
		w.kStr("id", n.ID)
		w.kStr("label", n.Label)
		w.kStr("file_type", n.FileType)
		w.kStr("source_file", n.SourceFile)
		w.kStr("source_location", n.SourceLocation)
		if n.Type != "" {
			w.kStr("type", n.Type)
		}
		if n.Rationale != "" {
			w.kStr("rationale", n.Rationale)
		}
		if n.Terms != "" {
			w.kStr("terms", n.Terms)
			w.kInt("tokens", n.Tokens)
		}
		if n.HasCommunity {
			w.kInt("community", n.Community)
		}
		if n.CommunityName != "" {
			w.kStr("community_name", n.CommunityName)
		}
		w.kStr("norm_label", n.NormLabel)
		w.close('}')
	}
	w.close(']')
	w.key("edges")
	w.open('[')
	for _, e := range graph.Edges {
		w.sep()
		w.open('{')
		w.kStr("source", e.Source)
		w.kStr("target", e.Target)
		w.kStr("relation", e.Relation)
		w.kStr("confidence", e.Confidence)
		w.kNum("confidence_score", e.ConfidenceScore)
		if e.Context != "" {
			w.kStr("context", e.Context)
		}
		if e.SourceFile != "" {
			w.kStr("source_file", e.SourceFile)
		}
		if e.SourceLocation != "" {
			w.kStr("source_location", e.SourceLocation)
		}
		w.kNum("weight", e.Weight)
		if e.Deferred {
			w.kBool("deferred", true)
		}
		w.close('}')
	}
	w.close(']')
	w.key("hyperedges")
	w.open('[')
	w.close(']')
	w.close('}')
	return w.b
}

// writeGraph writes graph.json (only when its content changed) and returns
// its path.
func writeGraph(root string, graph *Graph) (string, error) {
	dir := outDir(root)
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return "", err
	}
	jsonPath := filepath.Join(dir, graphBasename)
	next := graphJSON(graph)
	prev, err := os.ReadFile(jsonPath)
	if err != nil || string(prev) != string(next) {
		if err := os.WriteFile(jsonPath, next, 0o666); err != nil {
			return jsonPath, err
		}
	}
	return jsonPath, nil
}

// The shapes loadGraph reads. A pointer tells an absent key from a zero.
type graphFileNode struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	FileType       string   `json:"file_type"`
	SourceFile     string   `json:"source_file"`
	SourceLocation string   `json:"source_location"`
	Type           string   `json:"type"`
	Rationale      string   `json:"rationale"`
	Terms          string   `json:"terms"`
	Tokens         float64  `json:"tokens"`
	Community      *float64 `json:"community"`
	CommunityName  string   `json:"community_name"`
	NormLabel      string   `json:"norm_label"`
}

type graphFileEdge struct {
	Source          string  `json:"source"`
	Target          string  `json:"target"`
	Relation        string  `json:"relation"`
	Confidence      string  `json:"confidence"`
	ConfidenceScore float64 `json:"confidence_score"`
	Context         string  `json:"context"`
	SourceFile      string  `json:"source_file"`
	SourceLocation  string  `json:"source_location"`
	Weight          float64 `json:"weight"`
	Deferred        bool    `json:"deferred"`
}

type graphFileCommunity struct {
	ID       float64         `json:"id"`
	Name     string          `json:"name"`
	Size     float64         `json:"size"`
	Cohesion float64         `json:"cohesion"`
	Members  json.RawMessage `json:"members"`
}

type graphFile struct {
	Graph *struct {
		Communities []*graphFileCommunity `json:"communities"`
	} `json:"graph"`
	Nodes []*graphFileNode  `json:"nodes"`
	Edges *[]*graphFileEdge `json:"edges"`
	Links *[]*graphFileEdge `json:"links"`
}

// loadGraph reads graph.json back; nil when it is missing or unreadable.
func loadGraph(root string) *Graph {
	jsonPath := filepath.Join(outDir(root), graphBasename)
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil
	}
	var raw graphFile
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	// raw.edges || raw.links || []
	var rawEdges []*graphFileEdge
	if raw.Edges != nil {
		rawEdges = *raw.Edges
	} else if raw.Links != nil {
		rawEdges = *raw.Links
	}
	g := &Graph{Path: jsonPath}
	g.Edges = make([]*Edge, 0, len(rawEdges))
	for _, e := range rawEdges {
		if e == nil {
			continue
		}
		g.Edges = append(g.Edges, &Edge{
			Source: e.Source, Target: e.Target, Relation: e.Relation, Confidence: e.Confidence,
			ConfidenceScore: e.ConfidenceScore, Context: e.Context, SourceFile: e.SourceFile,
			SourceLocation: e.SourceLocation, Weight: e.Weight, Deferred: e.Deferred,
		})
	}
	// writeGraph strips each community's `members` from graph.json (they are
	// derivable); rebuild them from node.community so `kg report` and
	// `kg export wiki` work from a loaded graph. Nodes are sorted by id in
	// the file, so the rebuilt lists are deterministic.
	byIdx := map[float64]*Community{}
	if raw.Graph != nil {
		for _, c := range raw.Graph.Communities {
			if c == nil {
				continue
			}
			com := &Community{ID: int(c.ID), Name: c.Name, Size: int(c.Size), Cohesion: c.Cohesion}
			// if (!Array.isArray(c.members)) c.members = []
			var members []string
			if len(c.Members) > 0 && json.Unmarshal(c.Members, &members) == nil {
				com.Members = members
			}
			g.Communities = append(g.Communities, com)
			byIdx[c.ID] = com
		}
	}
	g.Nodes = make([]*Node, 0, len(raw.Nodes))
	for _, n := range raw.Nodes {
		if n == nil {
			continue
		}
		node := &Node{
			ID: n.ID, Label: n.Label, FileType: n.FileType, SourceFile: n.SourceFile,
			SourceLocation: n.SourceLocation, Type: n.Type, Rationale: n.Rationale,
			Terms: n.Terms, Tokens: int(n.Tokens), CommunityName: n.CommunityName, NormLabel: n.NormLabel,
		}
		if n.Community != nil {
			node.Community = int(*n.Community)
			node.HasCommunity = true
			if c := byIdx[*n.Community]; c != nil {
				c.Members = append(c.Members, n.ID)
			}
		}
		g.Nodes = append(g.Nodes, node)
	}
	return g
}
