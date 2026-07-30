package flow

import "github.com/draht-dev/draht/go/internal/rawobj"

// Caps mirrored verbatim from the CJS engine (draht-tools.cjs:2615-2617,
// 2652, 2742/2776's "stepN > 26" checks, and the "calls.slice(0, 8)" calls).
const (
	// MaxModulesPerFlow bounds the BFS's visitedModules set
	// (draht-tools.cjs:2615).
	MaxModulesPerFlow = 32
	// MaxStepsPerFlow is the hard cap on the BFS (entry + call) step
	// counter (draht-tools.cjs:2616). No call step ever carries n > 18.
	MaxStepsPerFlow = 18
	// MaxReExportFanout bounds how many re-export targets a transparent
	// barrel hop expands to (draht-tools.cjs:2617).
	MaxReExportFanout = 6
	// MaxBFSDepth is the BFS depth ceiling: nodes queued past this depth
	// are dropped without expansion (draht-tools.cjs:2652).
	MaxBFSDepth = 6
	// SinkStepCeiling is the total step-counter ceiling once the sink
	// phase starts (18 BFS steps + 8 sink steps, draht-tools.cjs:2742-2799).
	SinkStepCeiling = MaxStepsPerFlow + 8
	// MaxCallsPerNode caps how many outgoing calls (or fallback imports)
	// are expanded per BFS-queue pop (draht-tools.cjs:2663, "calls.slice(0, 8)").
	MaxCallsPerNode = 8
)

// FlowsFileName is the curation file consulted under
// <root>/.planning/codebase/ (draht-tools.cjs:2821).
const FlowsFileName = "FLOWS.json"

// SinkLabel maps a sink kind to its short display label
// (draht-tools.cjs:2539-2544).
var SinkLabel = map[string]string{
	"fs:write":     "Filesystem",
	"fs:read":      "Filesystem",
	"net:fetch":    "Network",
	"net:http":     "Network",
	"db:sql":       "Database",
	"db:orm":       "Database",
	"cli:io":       "Stdout",
	"process:exec": "Subprocess",
	"process:exit": "Process",
	"ai:call":      "AI provider",
	"env:read":     "Environment",
}

// SinkPhrase maps a sink kind to the human-readable phrase used in flow-step
// descriptions (draht-tools.cjs:2578-2589).
var SinkPhrase = map[string]string{
	"fs:write":     "writes to the filesystem",
	"fs:read":      "reads from the filesystem",
	"net:fetch":    "calls an external HTTP API",
	"net:http":     "issues an HTTP request",
	"db:sql":       "runs a SQL query",
	"db:orm":       "issues an ORM database call",
	"cli:io":       "writes to stdout/stderr",
	"process:exec": "spawns a subprocess",
	"process:exit": "terminates the process",
	"ai:call":      "calls an AI provider",
	"env:read":     "reads environment variables",
}

// SinkBoxID mirrors `"sink:" + (SinkLabel[kind] || kind)` (draht-tools.cjs:2545).
func SinkBoxID(kind string) string {
	if label, ok := SinkLabel[kind]; ok {
		return "sink:" + label
	}
	return "sink:" + kind
}

// SinkSite is the flow-step-embedded sink call site
// (draht-tools.cjs:2752-2757). Note the JSON key is "fn", not "inFunction".
type SinkSite struct {
	File    string  `json:"file"`
	Line    int     `json:"line"`
	Fn      *string `json:"fn"`
	Snippet string  `json:"snippet"`
}

// stepKind selects which of the four CJS flow-step JSON shapes FlowStep
// marshals to (draht-tools.cjs:2591-2606 entry, 2699-2712 call, 2760-2769
// concrete sink, 2789-2797 aggregated-fallback sink).
type stepKind int

const (
	stepEntry stepKind = iota
	stepCall
	stepSink
	stepSinkFallback
)

// FlowStep is one numbered step within a Flow. Which fields are meaningful
// (and the emitted JSON key order) depends on Kind; see MarshalJSON.
type FlowStep struct {
	Kind        stepKind
	N           int
	From        string
	To          string
	BoxFrom     string
	BoxTo       string
	Title       string
	Description string
	// Symbol, FromFile, ToFile: call steps only (FromFile is also set, to
	// nil, on the synthetic entry step).
	Symbol   string
	FromFile *string
	ToFile   *string
	// SinkKind, SinkSite: sink steps only. SinkSite is nil for the
	// aggregated-fallback sink shape.
	SinkKind string
	SinkSite *SinkSite
}

// MarshalJSON emits the exact CJS key order for each of the four step
// shapes (see internal/flow doc comment table in the design notes).
func (s FlowStep) MarshalJSON() ([]byte, error) {
	switch s.Kind {
	case stepEntry:
		return rawobj.MarshalNoEscape(struct {
			N           int     `json:"n"`
			From        string  `json:"from"`
			To          string  `json:"to"`
			Title       string  `json:"title"`
			Description string  `json:"description"`
			FromFile    *string `json:"fromFile"`
			ToFile      *string `json:"toFile"`
			BoxFrom     string  `json:"boxFrom"`
			BoxTo       string  `json:"boxTo"`
		}{s.N, s.From, s.To, s.Title, s.Description, s.FromFile, s.ToFile, s.BoxFrom, s.BoxTo})
	case stepSink:
		return rawobj.MarshalNoEscape(struct {
			N           int       `json:"n"`
			From        string    `json:"from"`
			To          string    `json:"to"`
			BoxFrom     string    `json:"boxFrom"`
			BoxTo       string    `json:"boxTo"`
			Title       string    `json:"title"`
			Description string    `json:"description"`
			SinkKind    string    `json:"sinkKind"`
			SinkSite    *SinkSite `json:"sinkSite"`
		}{s.N, s.From, s.To, s.BoxFrom, s.BoxTo, s.Title, s.Description, s.SinkKind, s.SinkSite})
	case stepSinkFallback:
		return rawobj.MarshalNoEscape(struct {
			N           int    `json:"n"`
			From        string `json:"from"`
			To          string `json:"to"`
			BoxFrom     string `json:"boxFrom"`
			BoxTo       string `json:"boxTo"`
			Title       string `json:"title"`
			Description string `json:"description"`
			SinkKind    string `json:"sinkKind"`
		}{s.N, s.From, s.To, s.BoxFrom, s.BoxTo, s.Title, s.Description, s.SinkKind})
	default: // stepCall
		return rawobj.MarshalNoEscape(struct {
			N           int     `json:"n"`
			From        string  `json:"from"`
			To          string  `json:"to"`
			BoxFrom     string  `json:"boxFrom"`
			BoxTo       string  `json:"boxTo"`
			Title       string  `json:"title"`
			Description string  `json:"description"`
			Symbol      string  `json:"symbol"`
			FromFile    *string `json:"fromFile"`
			ToFile      *string `json:"toFile"`
		}{s.N, s.From, s.To, s.BoxFrom, s.BoxTo, s.Title, s.Description, s.Symbol, s.FromFile, s.ToFile})
	}
}

// Flow is one named dataflow scenario rooted at a single entry point
// (draht-tools.cjs:2806-2818).
type Flow struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Description    string     `json:"description"`
	Entry          string     `json:"entry"`
	EntryKind      string     `json:"entryKind"`
	EntryContainer string     `json:"entryContainer"`
	Steps          []FlowStep `json:"steps"`
}

// Box is one swim-lane layout node: the single actor box, one box per
// container ("package" kind), or one box per distinct sink kind reached by
// any flow ("sink" kind, duplicate ids allowed — draht-tools.cjs:2848-2884).
type Box struct {
	ID          string
	Lane        string
	Title       string
	Sublabel    string
	Color       string
	Kind        string // "" (actor), "package", or "sink"
	ModuleCount int
	HasEntry    bool
	Sinks       []string
}

// MarshalJSON emits 5 keys for the actor box, 9 for a package box, and 6 for
// a sink box, matching the three CJS record shapes exactly.
func (b Box) MarshalJSON() ([]byte, error) {
	switch b.Kind {
	case "package":
		return rawobj.MarshalNoEscape(struct {
			ID          string   `json:"id"`
			Lane        string   `json:"lane"`
			Title       string   `json:"title"`
			Sublabel    string   `json:"sublabel"`
			Color       string   `json:"color"`
			Kind        string   `json:"kind"`
			ModuleCount int      `json:"moduleCount"`
			HasEntry    bool     `json:"hasEntry"`
			Sinks       []string `json:"sinks"`
		}{b.ID, b.Lane, b.Title, b.Sublabel, b.Color, b.Kind, b.ModuleCount, b.HasEntry, b.Sinks})
	case "sink":
		return rawobj.MarshalNoEscape(struct {
			ID       string `json:"id"`
			Lane     string `json:"lane"`
			Title    string `json:"title"`
			Sublabel string `json:"sublabel"`
			Color    string `json:"color"`
			Kind     string `json:"kind"`
		}{b.ID, b.Lane, b.Title, b.Sublabel, b.Color, b.Kind})
	default: // actor
		return rawobj.MarshalNoEscape(struct {
			ID       string `json:"id"`
			Lane     string `json:"lane"`
			Title    string `json:"title"`
			Sublabel string `json:"sublabel"`
			Color    string `json:"color"`
		}{b.ID, b.Lane, b.Title, b.Sublabel, b.Color})
	}
}
