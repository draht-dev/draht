package model

// Confidence values for Edge.Confidence and CallEdge.Confidence (design
// Spike 4 §A6 / cjs:3007).
const (
	// ConfidenceExtracted marks a fact literal in source (the specifier
	// text of an import/re-export/external edge). This is the ONLY value
	// edges[] ever emits.
	ConfidenceExtracted = "EXTRACTED"
	// ConfidenceInferred marks a callEdges[] entry where the imported
	// local was seen at least once as a direct call (`name(`).
	ConfidenceInferred = "INFERRED"
	// ConfidenceAmbiguous marks a callEdges[] entry where the imported
	// local was seen ONLY as a member call (`name.member(`) — the actual
	// symbol invoked is uncertain.
	ConfidenceAmbiguous = "AMBIGUOUS"
)

// Edge.Kind values.
const (
	EdgeKindImport   = "import"
	EdgeKindReExport = "re-export"
	// EdgeKindExternal also covers unresolvable relative specifiers (design
	// Spike 4 §A4/§A5 — the CJS engine mislabels these as external too).
	EdgeKindExternal = "external"
)

// Module.Layer values (design Spike 2 / cjs:1573-1584).
const (
	LayerPresentation   = "presentation"
	LayerApplication    = "application"
	LayerDomain         = "domain"
	LayerInfrastructure = "infrastructure"
	LayerSupport        = "support"
)

// EntryPoint.Kind values.
const (
	EntryKindCLI     = "cli"
	EntryKindHTTP    = "http"
	EntryKindLibrary = "library"
)

// Sink kinds (Module.Sinks, SinkSite.Kind).
const (
	SinkFSWrite     = "fs:write"
	SinkFSRead      = "fs:read"
	SinkNetFetch    = "net:fetch"
	SinkNetHTTP     = "net:http"
	SinkDBSQL       = "db:sql"
	SinkDBORM       = "db:orm"
	SinkCLIIO       = "cli:io"
	SinkProcessExec = "process:exec"
	SinkProcessExit = "process:exit"
	SinkAICall      = "ai:call"
	SinkEnvRead     = "env:read"
)
