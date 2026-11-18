package kg

// Shapes shared by the declaration parsers (phase 1) and the graph build.
// They mirror the object literals of draht-kg.cjs field for field. JS `null` /
// `undefined` map to the zero value: "" for a name, 0 for a line (lines are
// 1-based), -1 where the original itself uses -1 for "no offset", nil for a
// list or map.

// Func is a function, a method, a Go method or a Rust fn. One value is shared
// by every list that names it (JS object identity), so it is always a pointer.
type Func struct {
	Name      string
	Line      int
	End       int // 0: unknown
	Start     int // Python: first decorator line
	IsDefault bool
	Property  bool // TS: function-valued class property
	DeclStart int  // Go / Rust: offset of the declaration
	BodyStart int  // offset of the body's `{`, -1 without a body
	BodyEnd   int  // offset of the body's `}` (or the end of a brace-less arrow body), -1 without

	// Go
	Params   []GoParam
	Result   string // first result type, "" when unknown
	HasRecv  bool
	RecvName string // "" for none or `_`
	RecvType string

	// Rust
	Inl   string // inline module path of the declaration ("" at file level)
	Owner string // impl / trait type name, "" for a free fn

	// Set by the build.
	Nid      string
	OwnerNid string
}

// GoParam is one named Go parameter with its lookup type ("" when unknown).
type GoParam struct {
	Name string
	Type string
}

// PyBase is one Python base class expression: `module.Name`.
type PyBase struct {
	Module string
	Name   string
}

// Class is a class, a Go named type, or a Rust struct / enum / union / trait.
type Class struct {
	Name             string
	Line             int
	End              int    // 0: unknown
	Start            int    // Python: first decorator line
	Kind             string // "" (a plain class), "struct", "interface", "type", "trait", "enum"
	IsDefault        bool
	Extends          string
	Implements       []string
	Methods          []*Func
	MethodsOverLimit int
	Fields           *OMap[string, string] // nil until a field is recorded
	Embeds           []string              // Go
	Underlying       string                // Go: `type A B`
	Bases            []PyBase              // Python
	Inl              string                // Rust
	BodyStart        int
	BodyEnd          int

	// Set by the build.
	MethodIds *OMap[string, string]
}

// TypeDecl is everything else a file declares: constants, type aliases,
// interfaces, enums, namespaces, macros.
type TypeDecl struct {
	Name       string
	Line       int
	Kind       string
	Extends    string
	ExtendsAll []string
	Inl        string // Rust
}

// ImportName is one imported binding: `imported as local`.
type ImportName struct {
	Imported string
	Local    string
}

// Import is one import statement (or one `use` leaf, one `require`).
type Import struct {
	Spec      string
	Default   string
	Namespace string
	Names     []ImportName
	ReExport  bool
	Dynamic   bool
	Cjs       bool
	Line      int

	GoAlias string // "" for none, else the alias as written ("_" and "." included)

	RsInl  string
	RsSegs []string
	RsGlob bool

	// Set by the build.
	GoScope *GoScope
	GoLocal string
}

// Nested is a declaration below top level (TS/JS).
type Nested struct {
	Name string
	Kind string
	Line int
}

// RsNested is a fn / struct / enum declared inside a Rust fn body.
type RsNested struct {
	Name   string
	Kind   string // "fn", "struct", "enum"
	Line   int
	End    int
	Parent *Func
}

// LocalExport is one `export { local as exported }` without a source.
type LocalExport struct {
	Local    string
	Exported string
}

// GoVar is a package-level Go variable or constant declared alone.
type GoVar struct {
	Type string // "" when not written
	Init string
	Rel  string // set by the build
}

// RsItem is one named item of a Rust module.
type RsItem struct {
	Kind string // "fn", "struct", "enum", "trait", "type", "const", "macro"
	Name string

	// Set by the build.
	Rel string
	Nid string
}

// RsModDecl is a `mod name;` declaration.
type RsModDecl struct {
	Name string
	Line int
}

// RsFileScope is one module of a Rust file as the parser sees it: the file
// itself (Inl "") or an inline `mod a { … }` ("a", "a::b").
type RsFileScope struct {
	Inl       string
	Items     *OMap[string, *RsItem]
	Mods      *OMap[string, string] // name -> inline path of the module
	ModDecls  []RsModDecl
	Uses      *OMap[string, [][]string] // alias -> candidate paths
	Globs     [][]string
	HasParent bool // false for the file-level module
	Parent    string
}

// RsImpl is an impl block, or a trait's own method list (IsTrait).
type RsImpl struct {
	Inl       string
	TypeName  string
	TypeSegs  []string
	TraitSegs []string // nil without a trait
	Line      int
	Methods   []*Func
	IsTrait   bool

	// Set by the build.
	OwnerNid string
}

// Decls is what parseDecls returns for one file.
type Decls struct {
	Classes   []*Class
	Functions []*Func
	Types     []*TypeDecl
	Imports   []*Import
	Docstring string
	Masked    []rune
	CallText  []rune

	// Go
	GoPackage string
	GoMethods []*Func
	GoVars    *OMap[string, *GoVar]

	// Rust
	RsScopes *OMap[string, *RsFileScope]
	RsImpls  []*RsImpl
	RsNested []*RsNested
	RsFns    []*Func
	RsSkip   [][2]int

	// TS / JS
	Nested       []Nested
	CjsFunctions []*Func
	LocalExports []LocalExport
	DefaultName  string
}

// Node is a graph node. Field order is the key order of graph.json.
type Node struct {
	ID             string
	Label          string
	FileType       string
	SourceFile     string
	SourceLocation string
	Type           string // omitted when ""
	Rationale      string // omitted when ""
	Terms          string // omitted when ""
	Tokens         int    // omitted when Terms is ""
	Community      int
	CommunityName  string // omitted when ""
	NormLabel      string

	Callable     bool // `_callable`: never written
	HasCommunity bool
}

// Edge is a graph edge. Field order is the key order of graph.json.
type Edge struct {
	Source          string
	Target          string
	Relation        string
	Confidence      string
	ConfidenceScore float64
	Context         string // omitted when ""
	SourceFile      string // omitted when ""
	SourceLocation  string // omitted when ""
	Weight          float64
	Deferred        bool // written as `deferred: true` when set
}

// Community is one cluster of the graph.
type Community struct {
	ID       int
	Name     string
	Size     int
	Cohesion float64
	Members  []string // not written to graph.json; rebuilt on load
}

// IDCollision records two files whose nodes share an id.
type IDCollision struct {
	ID      string
	Kept    string
	Dropped string
}

// MethodLimitHit records a class that declares more methods than are kept.
type MethodLimitHit struct {
	File     string
	Name     string
	Declared int
}

// Graph is a built or loaded graph.
type Graph struct {
	Nodes           []*Node
	Edges           []*Edge
	Communities     []*Community
	IDCollisions    []IDCollision
	MethodLimitHits []MethodLimitHit
	Path            string // set by LoadGraph
}

// GoEntry is a Go function or method known to a package scope.
type GoEntry struct {
	Nid string
	Fn  *Func
	Rel string
}

// GoTypeEntry is a named Go type known to a package scope.
type GoTypeEntry struct {
	Nid   string
	Cls   *Class
	Rel   string
	Scope *GoScope
}

// GoValueEntry is a package-level Go constant or variable node.
type GoValueEntry struct {
	Nid string
	Rel string
}

// GoScope is one Go package: every file of a directory with one package clause.
type GoScope struct {
	Dir     string
	Name    string
	Files   []string
	Funcs   *OMap[string, *GoEntry]
	Types   *OMap[string, *GoTypeEntry]
	Values  *OMap[string, *GoValueEntry]
	Vars    *OMap[string, *GoVar]
	Methods *OMap[string, *OMap[string, *GoEntry]] // type name -> method name -> entry
}
