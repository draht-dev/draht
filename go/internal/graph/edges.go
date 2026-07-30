package graph

import (
	"path"
	"regexp"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// ModuleImports pairs one TS/JS module's repo-relative path with its raw
// parsed import records, in the parser's own emission order (design D3:
// edges are built from TS/JS modules only; the caller is responsible for
// filtering to those languages before calling BuildEdges).
type ModuleImports struct {
	Path    string
	Imports []parse.Import
}

// ResolvedImport pairs one raw import record with its resolution outcome.
// When Resolved is false, Target holds the raw specifier (unresolved
// relative AND bare specifiers both surface this way — design Spike 4 §A4:
// the CJS engine reports both as "external", not as a distinct kind).
type ResolvedImport struct {
	Import   parse.Import
	Target   string
	Resolved bool
}

// ResolveImports resolves every import in imports against resolver, using
// fromDir as the importing module's directory. Order is preserved from the
// input slice (never re-sorted — see parse.Result's ordering contract).
func ResolveImports(imports []parse.Import, fromDir string, resolver *Resolver) []ResolvedImport {
	out := make([]ResolvedImport, len(imports))
	for i, imp := range imports {
		if target, ok := resolver.Resolve(imp.Specifier, fromDir); ok {
			out[i] = ResolvedImport{Import: imp, Target: target, Resolved: true}
		} else {
			out[i] = ResolvedImport{Import: imp, Target: imp.Specifier, Resolved: false}
		}
	}
	return out
}

// EdgesForModule builds model.Edge records for one module's already-resolved
// imports (draht-tools.cjs:2296-2299): one edge per import record,
// "re-export" kind for parse.KindReExport, unresolved => kind "external"
// with To set to the raw specifier and Resolved pointing at false. No dedup
// (design D6 — duplicate specifiers legitimately produce duplicate edges).
func EdgesForModule(fromID string, resolved []ResolvedImport) []model.Edge {
	edges := make([]model.Edge, 0, len(resolved))
	for _, ri := range resolved {
		if !ri.Resolved {
			edges = append(edges, model.Edge{
				From:       fromID,
				To:         ri.Target,
				Kind:       model.EdgeKindExternal,
				Confidence: model.ConfidenceExtracted,
				Resolved:   model.Bool(false),
			})
			continue
		}
		kind := model.EdgeKindImport
		if ri.Import.Kind == parse.KindReExport {
			kind = model.EdgeKindReExport
		}
		edges = append(edges, model.Edge{
			From:       fromID,
			To:         ri.Target,
			Kind:       kind,
			Confidence: model.ConfidenceExtracted,
		})
	}
	return edges
}

// BuildEdges constructs model.Edge records from TS/JS modules only (design
// D3). mi MUST already be in the module's final deterministic order
// (repo-relative path ascending, matching scan.Discover's sort) — BuildEdges
// iterates it as given and never re-sorts.
func BuildEdges(mi []ModuleImports, resolver *Resolver) []model.Edge {
	edges := make([]model.Edge, 0)
	for _, m := range mi {
		fromDir := path.Dir(m.Path)
		resolved := ResolveImports(m.Imports, fromDir, resolver)
		edges = append(edges, EdgesForModule(m.Path, resolved)...)
	}
	return edges
}

// UsedLocal is a local binding introduced by a resolved, non-re-export
// import — the unit CallConfidence/BuildCallEdges scan the raw source for
// (design Spike 4 §A2 "usedLocals").
type UsedLocal struct {
	// Local is the name bound in the importing module's scope (the
	// binding actually referenced at call sites).
	Local string
	// ImportedName is the symbol name as declared by the exporting module:
	// "default" for a default import, "*" for a namespace import, or the
	// imported (not local/aliased) name for a named import.
	ImportedName string
	// Target is the resolved module id the import came from.
	Target string
}

// CollectUsedLocals extracts the UsedLocal set from one module's already-
// resolved imports, in encounter order (draht-tools.cjs:2302-2307).
// Re-export imports never contribute (a barrel does not introduce local
// usage). A local name that recurs keeps its FIRST encounter position but
// its LAST target/importedName — mirroring a JS Map's `.set()`, which
// updates a key's value in place without moving it.
func CollectUsedLocals(resolved []ResolvedImport) []UsedLocal {
	var order []string
	byLocal := make(map[string]UsedLocal)
	add := func(local, importedName, target string) {
		if local == "" {
			return
		}
		if _, exists := byLocal[local]; !exists {
			order = append(order, local)
		}
		byLocal[local] = UsedLocal{Local: local, ImportedName: importedName, Target: target}
	}
	for _, ri := range resolved {
		if !ri.Resolved || ri.Import.Kind == parse.KindReExport {
			continue
		}
		if ri.Import.Default != "" {
			add(ri.Import.Default, "default", ri.Target)
		}
		if ri.Import.Namespace != "" {
			add(ri.Import.Namespace, "*", ri.Target)
		}
		for _, n := range ri.Import.Names {
			local := n.Local
			if local == "" {
				local = n.Imported
			}
			add(local, n.Imported, ri.Target)
		}
	}
	out := make([]UsedLocal, len(order))
	for i, l := range order {
		out[i] = byLocal[l]
	}
	return out
}

// callRegexEscape ports `/[.*+?^${}()|[\]\\]/g` — the character class of
// regex metacharacters draht-tools.cjs escapes before building a per-local
// call-site regex.
var callRegexEscape = regexp.MustCompile(`[.*+?^${}()|[\]\\]`)

func escapeForCallRegex(name string) string {
	return callRegexEscape.ReplaceAllString(name, `\$0`)
}

// CallConfidence classifies one symbol's call-site usage
// (draht-tools.cjs:2318-2321): INFERRED when the local name was seen at
// least once as a direct call (`name(`); AMBIGUOUS when it was seen only as
// a member call (`name.member(`) — the actual symbol invoked is uncertain.
func CallConfidence(hasDirectCall bool) string {
	if hasDirectCall {
		return model.ConfidenceInferred
	}
	return model.ConfidenceAmbiguous
}

// callSiteMaxCount is the CJS engine's per-local call-site scan cap
// (draht-tools.cjs:2316 `if (count > 100) break`), which stops counting
// after the 101st match.
const callSiteMaxCount = 101

// BuildCallEdges scans rawContent — the module's UNSTRIPPED source, exactly
// as cjs:2311 reads `file.content` (design §R10: this intentionally still
// sees comments/strings; do not "fix" this by stripping first) — for call
// sites of each UsedLocal, in the given order (see CollectUsedLocals). A
// local with zero call-site hits produces no CallEdge. Counting is capped
// at callSiteMaxCount.
//
// NOT currently invoked by the Phase-1 pipeline: design D3 keeps
// callEdges[] a Phase-1-deferred, always-empty top-level array (computing
// it for real requires keeping each module's raw source available at the
// assemble stage, which the extraction cache deliberately does not
// persist). Provided here as a tested, Phase-2-ready building block that
// implements the full EXTRACTED/INFERRED/AMBIGUOUS confidence contract.
func BuildCallEdges(fromID string, rawContent []byte, locals []UsedLocal) []model.CallEdge {
	if len(locals) == 0 {
		return nil
	}
	text := string(rawContent)
	out := make([]model.CallEdge, 0, len(locals))
	for _, l := range locals {
		safe := escapeForCallRegex(l.Local)
		callRe := regexp.MustCompile(`\b` + safe + `\s*(?:\.[A-Za-z_$][\w$]*\s*)?\(`)
		count := len(callRe.FindAllStringIndex(text, callSiteMaxCount))
		if count == 0 {
			continue
		}
		directRe := regexp.MustCompile(`\b` + safe + `\s*\(`)
		out = append(out, model.CallEdge{
			From:       fromID,
			To:         l.Target,
			Symbol:     l.ImportedName,
			Count:      count,
			Confidence: CallConfidence(directRe.MatchString(text)),
		})
	}
	return out
}
