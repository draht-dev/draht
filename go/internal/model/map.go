package model

import (
	"encoding/json"
)

// Map is the schemaVersion-5 MAP.json wire format. Field order below is the
// declaration/emission order (28 top-level keys). Construct via NewMap();
// never build a &Map{...} literal directly (see design §R5 — every top-level
// array field must be a non-nil empty slice, not nil, even when empty).
type Map struct {
	SchemaVersion int       `json:"schemaVersion"`
	GeneratedAt   string    `json:"generatedAt"`
	BuildMs       int       `json:"buildMs"`
	Root          string    `json:"root"`
	Stats         Stats     `json:"stats"`
	Assets        Assets    `json:"assets"`
	Packages      []Package `json:"packages"`
	// Groups is an ordered list of raw (unmarshalled-key-order-preserving)
	// JSON objects, not a typed []Group: the GROUPS.json curation merge
	// (Object.assign semantics) must round-trip arbitrary unknown user keys,
	// which a typed struct would silently drop. See internal/container's
	// RawObject / ApplyGroupsCuration.
	Groups          []json.RawMessage `json:"groups"`
	Containers      []Container       `json:"containers"`
	BoundedContexts []Container       `json:"boundedContexts"` // aliases Containers at assembly time
	Modules         []Module          `json:"modules"`
	Edges           []Edge            `json:"edges"`
	CallEdges       []CallEdge        `json:"callEdges"`
	ContainerEdges  []ContainerEdge   `json:"containerEdges"`
	EntryPoints     []EntryPointRef   `json:"entryPoints"`
	Sinks           []SinkModule      `json:"sinks"`
	// Flows is pre-marshaled JSON (see Groups' comment — internal/flow's
	// FLOWS.json curation has the identical Object.assign contract).
	Flows []json.RawMessage `json:"flows"`
	Lanes []Lane            `json:"lanes"`
	// Boxes is pre-marshaled JSON: internal/flow.Box has 3 distinct JSON key
	// orders (actor/package/sink) via its own MarshalJSON, and model must
	// not import internal/flow (model has zero non-stdlib imports by
	// design).
	Boxes                 []json.RawMessage      `json:"boxes"`
	SymbolIndex           []SymbolIndexEntry     `json:"symbolIndex"`
	SymbolIndexTruncated  bool                   `json:"symbolIndexTruncated"`
	Hotspots              Hotspots               `json:"hotspots"`
	Clusters              []Cluster              `json:"clusters"`
	SurprisingConnections []SurprisingConnection `json:"surprisingConnections"`
	RationaleIndex        []RationaleEntry       `json:"rationaleIndex"`
	Tests                 Tests                  `json:"tests"`
	Planning              Planning               `json:"planning"`
	AgentHints            AgentHints             `json:"agentHints"`
}

// Module is one code-file node in the graph.
type Module struct {
	ID         string            `json:"id"`
	Path       string            `json:"path"`
	Language   string            `json:"language"`
	Size       int64             `json:"size"`
	Loc        int               `json:"loc"`
	IsTest     bool              `json:"isTest"`
	Package    *string           `json:"package"`
	Exports    []Export          `json:"exports"`
	Symbols    []Symbol          `json:"symbols"`
	Sinks      []string          `json:"sinks"`
	SinkSites  []SinkSite        `json:"sinkSites"`
	Routes     []Route           `json:"routes"`
	EntryPoint *ModuleEntryPoint `json:"entryPoint"`
	Layer      string            `json:"layer"`
	// Depth is the multi-source BFS distance from the nearest entry point
	// (nil/null when unreachable). Cluster is this module's structural
	// (import-topology) neighborhood id (nil/null only when the module was
	// never assigned one — unreachable in practice, every module lands in
	// exactly one cluster).
	Depth   *int    `json:"depth"`
	Cluster *string `json:"cluster"`
}

// Export is one exported declaration (model-local; decoupled from
// extract.Export by design so model has zero non-stdlib imports).
type Export struct {
	Name string  `json:"name"`
	Kind string  `json:"kind"`
	Line int     `json:"line"`
	Doc  *string `json:"doc"`
}

// Symbol is one symbol-level node.
type Symbol struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Line     int    `json:"line"`
	Exported bool   `json:"exported"`
	// Signature is the declaration as written in the source (parameter list
	// and return type included, body excluded), capped at
	// extract.SignatureCap runes. Populated only when map-graph runs with
	// --symbol-signatures; the omitempty is load-bearing, since an omitted
	// key is what keeps MAP.json byte-identical to the CJS engine's by
	// default. MUST stay the last field for the same reason: encoding/json
	// emits struct fields in declaration order.
	Signature string `json:"signature,omitempty"`
}

// SinkSite is one concrete call site for a detected sink kind.
type SinkSite struct {
	Kind       string  `json:"kind"`
	Line       int     `json:"line"`
	Snippet    string  `json:"snippet"`
	InFunction *string `json:"inFunction"`
}

// Route is one detected HTTP route declaration.
type Route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// ModuleEntryPoint is the module[*].entryPoint shape — NOT the same struct
// as the top-level EntryPointRef (which additionally carries id/path/package).
type ModuleEntryPoint struct {
	Kind   string  `json:"kind"`
	Name   string  `json:"name,omitempty"`
	Routes []Route `json:"routes,omitempty"`
}

// Edge is one import-derived dependency edge (TS/JS modules only in Phase 1;
// see design D3). Duplicate edges are preserved (design D6): no dedup here.
type Edge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Kind       string `json:"kind"`
	Confidence string `json:"confidence"`
	// Resolved stays *bool with omitempty: bool+omitempty would drop the
	// only value the field ever has (false).
	Resolved *bool `json:"resolved,omitempty"`
}

// CallEdge is one symbol-level call inference: caller-file uses callee-
// file's Symbol (draht-tools.cjs:2288-2327).
type CallEdge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Symbol     string `json:"symbol"`
	Count      int    `json:"count"`
	Confidence string `json:"confidence"`
}

// ContainerEdge is one cross-package dataflow edge (draht-tools.cjs:2422-
// 2496). There is deliberately no "confidence" field on this record.
type ContainerEdge struct {
	From          string   `json:"from"`
	To            string   `json:"to"`
	Count         int      `json:"count"`
	CallCount     int      `json:"callCount"`
	Label         string   `json:"label"`
	Labels        []string `json:"labels"`
	SymbolSamples []string `json:"symbolSamples"`
}

// EntryPointRef is one top-level entryPoints[] item.
type EntryPointRef struct {
	ID      string  `json:"id"`
	Path    string  `json:"path"`
	Package *string `json:"package"`
	Kind    string  `json:"kind"`
	Name    *string `json:"name"`
	// Routes keeps NO omitempty: nil marshals to null, matching the CJS
	// output for non-http entries (design §3 item 4).
	Routes []Route `json:"routes"`
}

// SinkModule is one top-level sinks[] item.
type SinkModule struct {
	ID      string   `json:"id"`
	Path    string   `json:"path"`
	Package *string  `json:"package"`
	Sinks   []string `json:"sinks"`
}

// Lane is one swim-lane layout row.
type Lane struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// SymbolIndexEntry is one repo-wide symbol index item.
type SymbolIndexEntry struct {
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Line     int     `json:"line"`
	File     string  `json:"file"`
	Package  *string `json:"package"`
	Exported bool    `json:"exported"`
}

// Hotspots groups the four ranked hotspot lists.
type Hotspots struct {
	GodNodes       []GodNode `json:"godNodes"`
	MostDependedOn []GodNode `json:"mostDependedOn"`
	Orchestrators  []GodNode `json:"orchestrators"`
	Largest        []GodNode `json:"largest"`
}

// GodNode is one ranked-hotspot entry (same shape across all 4 lists).
type GodNode struct {
	ID        string  `json:"id"`
	Path      string  `json:"path"`
	Package   *string `json:"package"`
	InDegree  int     `json:"inDegree"`
	OutDegree int     `json:"outDegree"`
	Loc       int     `json:"loc"`
	Score     float64 `json:"score"`
	Reason    string  `json:"reason"`
}

// Cluster is one structural (import-topology) neighborhood.
type Cluster struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	Size            int      `json:"size"`
	Members         []string `json:"members"`
	DominantPackage *string  `json:"dominantPackage"` // nil -> null (only for an empty group; unreachable in practice)
	DominantLayer   string   `json:"dominantLayer"`   // default "support"
	Packages        []string `json:"packages"`        // sorted ASC, never nil (emit [] not null)
}

// SurprisingConnection flags an import edge that bridges distant clusters,
// crosses functional groups, or violates layer direction.
type SurprisingConnection struct {
	From          string   `json:"from"`
	To            string   `json:"to"`
	Score         float64  `json:"score"`
	Reason        string   `json:"reason"`
	SampleSymbols []string `json:"sampleSymbols"`
}

// RationaleEntry is one tagged-comment (e.g. SECURITY:) hit.
type RationaleEntry struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Tag  string `json:"tag"`
	Text string `json:"text"`
}

// Tests summarizes test-file counts.
type Tests struct {
	Total       int            `json:"total"`
	ByContainer *OrderedCounts `json:"byContainer"`
}

// Planning mirrors the .planning/ directory's presence + current state.
//
// CurrentState is a *string because the CJS emits literal null (not "") when
// STATE.md is absent or empty — `planning.state ? …slice(0,2000) : null`
// (draht-tools.cjs:2986). A plain string would serialize as "" and break
// byte-parity on every repo without a STATE.md.
type Planning struct {
	HasProject   bool    `json:"hasProject"`
	HasRoadmap   bool    `json:"hasRoadmap"`
	HasDomain    bool    `json:"hasDomain"`
	CurrentState *string `json:"currentState"`
}

// AgentHints is the verbatim literal block guiding LLM consumers of
// MAP.json.
type AgentHints struct {
	Description string   `json:"description"`
	HowToUse    []string `json:"howToUse"`
}

// Package is one packages[] item (manifest summary).
type Package struct {
	Name              string   `json:"name"`
	Version           *string  `json:"version"`
	Path              string   `json:"path"`
	Description       *string  `json:"description"`
	Dependencies      []string `json:"dependencies"`
	DevDependencies   []string `json:"devDependencies"`
	PeerDependencies  []string `json:"peerDependencies"`
	WorkspaceDeps     []string `json:"workspaceDeps"`
	WorkspacePatterns []string `json:"workspacePatterns,omitempty"` // root manifest only
}

// Group partitions packages into a functional container (Frontend, Core, ...).
type Group struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Color       string   `json:"color"`
	Description string   `json:"description"`
	Members     []string `json:"members"`
	Source      string   `json:"source"`
	ModuleCount int      `json:"moduleCount"`
}

// Container describes one package/bounded-context.
type Container struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	Kind        string    `json:"kind"`
	Description *string   `json:"description"`
	ModuleCount int       `json:"moduleCount"`
	GroupID     string    `json:"groupId"`
	TopFiles    []TopFile `json:"topFiles"`
}

// TopFile is one of a Container's most-relevant source files.
type TopFile struct {
	Path   string  `json:"path"`
	Reason string  `json:"reason"`
	Score  float64 `json:"score"`
	Loc    int     `json:"loc"`
}

// Stats is the top-level stats{} rollup. Languages/Layers use OrderedCounts
// (NOT map[string]int) to preserve JS-object insertion order — see design
// §R4.
type Stats struct {
	Files          int            `json:"files"`
	TotalLoc       int            `json:"totalLoc"`
	Languages      *OrderedCounts `json:"languages"`
	Packages       int            `json:"packages"`
	Containers     int            `json:"containers"`
	Groups         int            `json:"groups"`
	Edges          int            `json:"edges"`
	CallEdges      int            `json:"callEdges"`
	ContainerEdges int            `json:"containerEdges"`
	EntryPoints    int            `json:"entryPoints"`
	SinkModules    int            `json:"sinkModules"`
	Layers         *OrderedCounts `json:"layers"`
	Truncated      bool           `json:"truncated"`
}

// Assets is the top-level assets{} rollup (non-code files).
type Assets struct {
	Total      int            `json:"total"`
	ByLanguage *OrderedCounts `json:"byLanguage"`
}

// NewMap returns a Map with schemaVersion 5 and all 13 deferred array
// fields pre-initialized to non-nil empty slices (design §R5: a nil
// top-level slice marshals to null and crashes the unmodified MAP.html
// viewer). graph/pipeline.go MUST build every Map through NewMap(), never
// via a &Map{...} literal.
func NewMap() *Map {
	return &Map{
		SchemaVersion:         5,
		Packages:              []Package{},
		Groups:                []json.RawMessage{},
		Containers:            []Container{},
		BoundedContexts:       []Container{},
		Modules:               []Module{},
		Edges:                 []Edge{},
		CallEdges:             []CallEdge{},
		ContainerEdges:        []ContainerEdge{},
		EntryPoints:           []EntryPointRef{},
		Sinks:                 []SinkModule{},
		Flows:                 []json.RawMessage{},
		Boxes:                 []json.RawMessage{},
		SymbolIndex:           []SymbolIndexEntry{},
		Clusters:              []Cluster{},
		SurprisingConnections: []SurprisingConnection{},
		RationaleIndex:        []RationaleEntry{},
		Stats: Stats{
			Languages: NewOrderedCounts(),
			Layers:    NewOrderedCounts(),
		},
		Assets:     Assets{ByLanguage: NewOrderedCounts()},
		Tests:      Tests{ByContainer: NewOrderedCounts()},
		Lanes:      DefaultLanes(),
		AgentHints: DefaultAgentHints(),
	}
}

// DefaultLanes returns the 6 hardcoded swim-lanes (actor / presentation /
// application / domain / infrastructure / sinks), verbatim from
// draht-tools.cjs:2840.
func DefaultLanes() []Lane {
	return []Lane{
		{ID: "actor", Name: "Actors", Color: "#ff9bd4"},
		{ID: "presentation", Name: "Presentation", Color: "#79c0ff"},
		{ID: "application", Name: "Application", Color: "#7ee787"},
		{ID: "domain", Name: "Domain", Color: "#d2a8ff"},
		{ID: "infrastructure", Name: "Infrastructure", Color: "#f0883e"},
		{ID: "sinks", Name: "Sinks", Color: "#ff7b72"},
	}
}

// DefaultAgentHints returns the fixed agentHints{} literal (verbatim from
// draht-tools.cjs:2987-3011) that guides LLM consumers of MAP.json.
func DefaultAgentHints() AgentHints {
	return AgentHints{
		Description: "Architecture map of this codebase. Read this BEFORE walking the file tree.",
		HowToUse: []string{
			"Schema v5 noise policy: `modules`/`edges`/`clusters`/`hotspots` only cover CODE files (ts/js/py/go/rust/java/kotlin/swift/ruby/php/csharp/c/cpp/shell) — docs/config/lockfiles never become graph nodes. `stats.languages` still counts EVERY scanned file (incl. markdown/json/yaml), and `assets.byLanguage`/`assets.total` rolls up the excluded ones so you can see they were seen, just not graphed. `stats.files` = code module count.",
			"`groups` partitions packages into functional containers (Frontend, CLI & Runtime, Core, Domain Services, Workflows & Infra). Each group's `members` array lists `pkg:NAME` ids. Overridable via `.planning/codebase/GROUPS.json`.",
			"`containers[*].groupId` links a package to its functional group; `containers[*].topFiles` is the 3-5 most relevant source files in the package (with a `reason` tag like `CLI entry` / `most depended-on` / `HTTP handler`).",
			"`containerEdges[*].label` is the relationship verb between two packages (Calls / Uses / Sends Events / Renders / Updates / Reads State / Configures / Analyzes / Executes Actions / Persists). `containerEdges[*].symbolSamples` shows the top imported symbol names.",
			"`entryPoints` lists every CLI command, HTTP route, and library main — these are where data flows in.",
			"`sinks` lists modules that hit FS, network, DB, stdout, or run subprocesses — where data flows out.",
			"`containers` describes packages/bounded contexts. `containerEdges` shows cross-package dataflow.",
			"`callEdges` is symbol-level: each entry means caller-file uses callee-file's <symbol>.",
			"`flows` is a list of named scenarios (CLI invocation, HTTP request, library call). Each flow has numbered `steps` going from `from` box → `to` box with a `description`. Boxes are packages (`pkg:NAME`), sinks (`sink:KIND`), or `actor:user`.",
			"`lanes` + `boxes` give you swim-lane layout coordinates: each box belongs to a lane (presentation / application / domain / infrastructure / sinks / actors).",
			"To curate flows or groups: write `.planning/codebase/FLOWS.json` or `.planning/codebase/GROUPS.json` — entries with matching `id` override auto-generated ones; new ids are appended.",
			"`modules[*].layer` classifies each file as presentation / application / domain / infrastructure / support.",
			"`modules[*].symbols` are symbol-level nodes ({name,kind,line,exported}); `modules[*].cluster` is the structural neighborhood id.",
			"`hotspots` ranks god-nodes / most-depended-on / orchestrators / largest (non-test import degree).",
			"`clusters` are STRUCTURAL (import-topology) neighborhoods — not semantic bounded contexts; confirm with a human before equating a cluster with a context. Non-JS/TS packages degenerate to one cluster per package.",
			"`surprisingConnections` flags import edges that bridge distant clusters, cross functional groups, or violate layer direction — review these.",
			"`rationaleIndex` collects inline NOTE/WHY/HACK/TODO/FIXME/SECURITY notes ({file,line,tag,text}).",
			"`edges[*].confidence` / `callEdges[*].confidence` ∈ EXTRACTED (literal in source) / INFERRED (regex call heuristic) / AMBIGUOUS (member-call, imported symbol uncertain).",
			"`stats.truncated` is true if the scan hit the file cap (rare, huge repos only). `symbolIndexTruncated` is true if `symbolIndex` was cut — when it is, the surviving entries are ranked by import in-degree so the most-depended-on modules' symbols are kept.",
			"Query the map with `draht-tools graph-context|graph-impact|graph-query|graph-callers|graph-callees|graph-path|graph-hotspots|graph-clusters` instead of reading this whole file or grepping.",
		},
	}
}

// Str/Int/Bool are pointer constructors for optional JSON fields.
func Str(s string) *string { return &s }
func Int(n int) *int       { return &n }
func Bool(b bool) *bool    { return &b }
