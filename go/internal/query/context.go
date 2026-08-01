package query

import (
	"fmt"
	"io"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Context ports commands["graph-context"] (draht-tools.cjs:5389-5417):
// "where am I" — package, layer, cluster, importers/imports, exports,
// sinks, rationale for one or more files. The whole text buffer is joined
// with "\n" and printed via a SINGLE write, so there is exactly one
// trailing newline regardless of how many lines/files were rendered
// (matching the CJS's single `console.log(L.join("\n"))`).
func Context(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv)
	if len(args.Files) == 0 {
		fmt.Fprintln(w, "usage: graph-context <file...> [--json]")
		return 0
	}

	adj := BuildImportAdj(m)
	resolver := NewResolver(m)
	clusterByID := clusterIndex(m)

	var lines []string
	jsonOut := []ContextJSON{}

	for _, f := range args.Files {
		r := resolver.Resolve(f)
		if r == nil {
			lines = append(lines, fmt.Sprintf("%s: not found in map", f))
			continue
		}
		mod := resolver.ModuleByID(r.ID)
		if mod == nil {
			// Unreachable given a real MAP.json (the resolver only ever
			// returns ids it found in m.Modules), kept defensive.
			lines = append(lines, fmt.Sprintf("%s: not found in map", f))
			continue
		}
		if !r.Exact {
			lines = append(lines, fmt.Sprintf("resolved '%s' → %s", f, mod.ID))
		}

		var cl *model.Cluster
		if mod.Cluster != nil {
			cl = clusterByID[*mod.Cluster]
		}
		clLabel, clSize := "-", 0
		var clLabelPtr *string
		if cl != nil {
			clLabel = cl.Label
			clSize = cl.Size
			l := cl.Label
			clLabelPtr = &l
		}

		exps, sigs := exportNamesAndSignatures(mod)
		ins := adj.Rev[mod.ID]
		outs := adj.Fwd[mod.ID]
		ratAll := rationaleForFile(m, mod.ID)
		rat := ratAll
		if len(rat) > 4 {
			rat = rat[:4]
		}

		pkg := "-"
		if mod.Package != nil {
			pkg = *mod.Package
		}
		entryKind := "no"
		if mod.EntryPoint != nil {
			entryKind = mod.EntryPoint.Kind
		}

		lines = append(lines, fmt.Sprintf("%s  ·  pkg:%s  ·  layer:%s  ·  cluster:%s(%d)  ·  entry:%s",
			mod.Path, pkg, mod.Layer, clLabel, clSize, entryKind))
		if sigs != nil {
			// Signatures are far too wide to comma-join onto one line, so
			// they get a block — same 8-entry cap as the inline form.
			lines = append(lines, fmt.Sprintf("  exports(%d):", len(exps)))
			for i := 0; i < len(exps) && i < 8; i++ {
				lines = append(lines, "    "+exportDisplay(exps, sigs, i))
			}
			if len(exps) > 8 {
				lines = append(lines, fmt.Sprintf("    (+%d more)", len(exps)-8))
			}
		} else {
			lines = append(lines, fmt.Sprintf("  exports(%d): %s", len(exps), joinCapped(exps, 8, "…")))
		}
		lines = append(lines, fmt.Sprintf("  importers(%d): %s", len(ins), joinCappedShort(ins, 5)))
		lines = append(lines, fmt.Sprintf("  imports(%d): %s", len(outs), joinCappedShort(outs, 5)))
		if len(mod.Sinks) > 0 {
			lines = append(lines, "  sinks: "+strings.Join(mod.Sinks, ", "))
		}
		if len(rat) > 0 {
			ratStrs := make([]string, len(rat))
			for i, x := range rat {
				ratStrs[i] = fmt.Sprintf("%s:%d %s", x.Tag, x.Line, SliceUTF16(x.Text, 40))
			}
			lines = append(lines, fmt.Sprintf("  rationale(%d): %s", len(rat), strings.Join(ratStrs, " · ")))
		}

		jsonOut = append(jsonOut, ContextJSON{
			ID:           mod.ID,
			Package:      mod.Package,
			Layer:        mod.Layer,
			Cluster:      derefStr(mod.Cluster),
			ClusterLabel: clLabelPtr,
			EntryPoint:   mod.EntryPoint,
			Exports:      nonNilStrs(exps),
			Importers:    nonNilStrs(ins),
			Imports:      nonNilStrs(outs),
			Sinks:        nonNilStrs(mod.Sinks),
			Rationale:    nonNilRationale(ratAll),
			Signatures:   sigs,
		})
	}

	if args.Bool("json") {
		b, err := MarshalPretty(jsonOut)
		if err != nil {
			// MarshalPretty only fails for un-marshalable types, which
			// ContextJSON never is; kept defensive rather than panicking.
			fmt.Fprintln(w, "[]")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	fmt.Fprintln(w, strings.Join(lines, "\n"))
	return 0
}

// clusterIndex builds an id -> *Cluster lookup.
func clusterIndex(m *model.Map) map[string]*model.Cluster {
	idx := make(map[string]*model.Cluster, len(m.Clusters))
	for i := range m.Clusters {
		idx[m.Clusters[i].ID] = &m.Clusters[i]
	}
	return idx
}

// exportNames ports `(m.symbols.length ? m.symbols.filter(exported) :
// m.exports).map(name)`.
func exportNames(mod *model.Module) []string {
	names, _ := exportNamesAndSignatures(mod)
	return names
}

// exportNamesAndSignatures returns exportNames' list plus the parallel
// declaration-text list (same length, same order). sigs is nil unless the
// map was built with --symbol-signatures AND at least one exported symbol
// actually rendered a signature — so every map produced before the flag
// existed, and every map produced without it, takes the name-only path and
// renders exactly as it did before.
func exportNamesAndSignatures(mod *model.Module) (names, sigs []string) {
	if len(mod.Symbols) > 0 {
		var any bool
		for _, s := range mod.Symbols {
			if !s.Exported {
				continue
			}
			names = append(names, s.Name)
			sigs = append(sigs, s.Signature)
			any = any || s.Signature != ""
		}
		if !any {
			return names, nil
		}
		return names, sigs
	}
	names = make([]string, len(mod.Exports))
	for i, e := range mod.Exports {
		names[i] = e.Name
	}
	return names, nil
}

// exportDisplay picks the declaration text when one was recorded and falls
// back to the bare name otherwise (a symbol whose signature could not be
// rendered still has to appear in the list).
func exportDisplay(names, sigs []string, i int) string {
	if i < len(sigs) && sigs[i] != "" {
		return sigs[i]
	}
	return names[i]
}

// rationaleForFile ports `map.rationaleIndex.filter(x => x.file === id)`
// (the UNCAPPED list — callers cap for text display separately).
func rationaleForFile(m *model.Map, id string) []model.RationaleEntry {
	var out []model.RationaleEntry
	for _, x := range m.RationaleIndex {
		if x.File == id {
			out = append(out, x)
		}
	}
	return out
}

// joinCapped renders "a, b, c" for the first cap elements of xs, "-" when
// empty, with a trailing " <ellipsis>" when xs has more than cap elements.
func joinCapped(xs []string, limit int, ellipsis string) string {
	if len(xs) == 0 {
		return "-"
	}
	n := len(xs)
	if n > limit {
		n = limit
	}
	s := strings.Join(xs[:n], ", ")
	if len(xs) > limit {
		s += " " + ellipsis
	}
	return s
}

// joinCappedShort renders the graph-context importers/imports shape: first
// limit elements via Short(), "-" when empty, "(+K more)" suffix when
// truncated.
func joinCappedShort(xs []string, limit int) string {
	if len(xs) == 0 {
		return "-"
	}
	n := len(xs)
	if n > limit {
		n = limit
	}
	shorts := make([]string, n)
	for i := 0; i < n; i++ {
		shorts[i] = Short(xs[i])
	}
	s := strings.Join(shorts, ", ")
	if len(xs) > limit {
		s += fmt.Sprintf(" (+%d more)", len(xs)-limit)
	}
	return s
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func nonNilStrs(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

func nonNilRationale(xs []model.RationaleEntry) []model.RationaleEntry {
	if xs == nil {
		return []model.RationaleEntry{}
	}
	return xs
}
