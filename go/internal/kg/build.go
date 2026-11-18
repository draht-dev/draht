package kg

import "strconv"

// importedName is what a local name was imported as (perFile.importedNames):
// { rel, name, nid, external, cjs }. Compared by identity, so always a pointer.
type importedName struct {
	Rel      string // "" when the module is outside the repo
	Name     string // the imported name; "default"; "*" for a namespace
	Nid      string
	External bool
	Cjs      bool
}

// fileInfo is the per-file state of a build (`perFile.get(rel)`, `pf`).
type fileInfo struct {
	Rel           string
	Lang          string
	Decls         *Decls
	Stripped      []rune // decls.callText
	LocalDefs     *OMap[string, string]
	DefaultNid    string
	ImportedNames *OMap[string, *importedName]
	FileNid       string
	LineOf        func(int) int

	// Go
	GoScope   *GoScope
	GoImports *OMap[string, *GoScope] // local name -> package scope; nil value for a package outside the repo
	GoDot     []*GoScope

	// Python
	ScopedImports []*scopedImport
	StarImports   []string
}

// scopedImport is the import bindings of one Python def body.
type scopedImport struct {
	Start int
	End   int
	Map   *OMap[string, *importedName]
}

// edgeOpts are the optional attributes of addEdge.
type edgeOpts struct {
	Confidence string // "" → EXTRACTED
	Score      float64
	HasScore   bool
	Context    string
	File       string
	Line       int
	Deferred   bool
}

// builder holds the state buildGraph's closures share in the original.
type builder struct {
	root     string
	nodes    []*Node
	nodeByID map[string]*Node
	edges    []*Edge
	perFile  *OMap[string, *fileInfo]

	idCollisions    []IDCollision
	methodLimitHits []MethodLimitHit

	classMembers *OMap[string, *OMap[string, string]] // class node id -> method name -> node id
	baseOf       *OMap[string, []string]              // class node id -> node ids of the classes it extends

	goState *goBuild
	rsState *rsBuild
	res     *resolver

	methodsByName map[string]map[string]*OSet[string] // language family -> method name -> method node ids
}

// addNode keeps the first node of an id (ids.py canonicalization can
// collide); a collision between two files is counted.
func (b *builder) addNode(n *Node) *Node {
	if existing, ok := b.nodeByID[n.ID]; ok {
		if existing.SourceFile != "" && n.SourceFile != "" && existing.SourceFile != n.SourceFile {
			b.idCollisions = append(b.idCollisions, IDCollision{ID: n.ID, Kept: existing.SourceFile, Dropped: n.SourceFile})
		}
		return existing
	}
	b.nodeByID[n.ID] = n
	b.nodes = append(b.nodes, n)
	return n
}

func (b *builder) hasNode(id string) bool {
	_, ok := b.nodeByID[id]
	return ok
}

// codeNode is the node literal every declaration uses:
// { id, label, file_type: "code", source_file, source_location: "L" + line }.
func codeNode(id, label, rel string, line int) *Node {
	return &Node{ID: id, Label: label, FileType: "code", SourceFile: rel, SourceLocation: "L" + strconv.Itoa(line)}
}

func (b *builder) addEdge(source, target, relation string, o edgeOpts) {
	confidence := o.Confidence
	if confidence == "" {
		confidence = "EXTRACTED"
	}
	score := confidenceScoreDefaults[confidence]
	if o.HasScore {
		score = o.Score
	}
	loc := ""
	if o.Line != 0 {
		loc = "L" + strconv.Itoa(o.Line)
	}
	b.edges = append(b.edges, &Edge{
		Source: source, Target: target, Relation: relation, Confidence: confidence,
		ConfidenceScore: score, Context: o.Context, SourceFile: o.File, SourceLocation: loc,
		Weight: 1.0, Deferred: o.Deferred,
	})
}
