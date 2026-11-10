package query

import (
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

var scopedPkgPrefix = regexp.MustCompile(`^@[^/]+/`)

// Impact ports commands["graph-impact"] (draht-tools.cjs:5419-5452): the
// reverse-transitive blast radius of one or more files — every module that
// (transitively) imports a target, the entry points that reach it, the
// sinks it can reach, and any surprising-connection warnings that touch the
// impacted set.
func Impact(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv)
	if len(args.Files) == 0 {
		fmt.Fprintln(w, "usage: graph-impact <file...> [--json]")
		return 0
	}

	resolver := NewResolver(m)
	adj := BuildImportAdj(m)

	var targets []string // raw, WITH duplicates, in argv order — feeds both the header and the JSON payload
	var notes []string
	for _, f := range args.Files {
		r := resolver.Resolve(f)
		if r != nil {
			if !r.Exact {
				notes = append(notes, fmt.Sprintf("resolved '%s' → %s", f, r.ID))
			}
			targets = append(targets, r.ID)
		} else {
			notes = append(notes, fmt.Sprintf("%s: not found", f))
		}
	}
	if len(targets) == 0 {
		if len(notes) > 0 {
			fmt.Fprintln(w, strings.Join(notes, "\n"))
		} else {
			fmt.Fprintln(w, "no targets resolved")
		}
		return 0
	}

	// seed = new Set(targets): dedup, first-occurrence order.
	seeded := map[string]bool{}
	var seedOrder []string
	for _, t := range targets {
		if !seeded[t] {
			seeded[t] = true
			seedOrder = append(seedOrder, t)
		}
	}

	seen := map[string]bool{}
	var order []string // targets-then-BFS-discovery insertion order
	for _, t := range seedOrder {
		seen[t] = true
		order = append(order, t)
	}
	queue := append([]string{}, seedOrder...)
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, dep := range adj.Rev[id] {
			if !seen[dep] {
				seen[dep] = true
				order = append(order, dep)
				queue = append(queue, dep)
			}
		}
	}

	targetSet := map[string]bool{}
	for _, t := range targets {
		targetSet[t] = true
	}

	var impactedIDs []string
	for _, id := range order {
		if !targetSet[id] {
			impactedIDs = append(impactedIDs, id)
		}
	}
	impactedSet := map[string]bool{}
	for _, id := range impactedIDs {
		impactedSet[id] = true
	}

	var impacted []*model.Module
	for _, id := range impactedIDs {
		if mod := resolver.ModuleByID(id); mod != nil {
			impacted = append(impacted, mod)
		}
	}

	var eps []model.EntryPointRef
	for _, ep := range m.EntryPoints {
		if impactedSet[ep.ID] {
			eps = append(eps, ep)
		}
	}

	byPkg := NewOrderedStrSlices()
	for _, mod := range impacted {
		pkg := "(root)"
		if mod.Package != nil && *mod.Package != "" {
			pkg = *mod.Package
		}
		byPkg.Append(pkg, mod.Path)
	}

	clusterLabel := map[string]string{}
	for _, c := range m.Clusters {
		clusterLabel[c.ID] = c.Label
	}
	seenCls := map[string]bool{}
	var cls []string
	for _, mod := range impacted {
		if mod.Cluster == nil || *mod.Cluster == "" {
			continue
		}
		c := *mod.Cluster
		if !seenCls[c] {
			seenCls[c] = true
			cls = append(cls, c)
		}
	}

	seenSink := map[string]bool{}
	var sinkKinds []string
	for _, t := range targets {
		mod := resolver.ModuleByID(t)
		if mod == nil {
			continue
		}
		for _, s := range mod.Sinks {
			if !seenSink[s] {
				seenSink[s] = true
				sinkKinds = append(sinkKinds, s)
			}
		}
	}

	var warns []model.SurprisingConnection
	for _, x := range m.SurprisingConnections {
		if impactedSet[x.From] || impactedSet[x.To] || targetSet[x.To] {
			warns = append(warns, x)
			if len(warns) == 5 {
				break
			}
		}
	}

	var L []string
	L = append(L, notes...)

	sinksStr := "none"
	if len(sinkKinds) > 0 {
		sinksStr = strings.Join(sinkKinds, ", ")
	}
	// Full resolved paths in the header (CJS parity) — a bare `index.ts` is
	// ambiguous in a monorepo full of them.
	L = append(L, fmt.Sprintf("impact %s — %d modules · %d packages · %d entry points · sinks: %s",
		strings.Join(targets, ", "), len(impactedIDs), byPkg.Len(), len(eps), sinksStr))
	// A barrel with no importers still fronts a public API — say so instead of
	// a bare zero (CJS parity).
	if len(impactedIDs) == 0 {
		for _, t := range targets {
			tm := resolver.ModuleByID(t)
			if tm == nil {
				continue
			}
			reexp := 0
			for _, e := range tm.Exports {
				if e.Kind == "re-export" {
					reexp++
				}
			}
			if reexp > 0 {
				pkg := "this package"
				if tm.Package != nil {
					pkg = *tm.Package
				}
				L = append(L, fmt.Sprintf("note: %s is a barrel (re-exports %d symbols) with no direct importers — changes only affect external consumers of %s", t, reexp, pkg))
			}
		}
	}

	if len(eps) > 0 {
		n := len(eps)
		show := n
		if show > 8 {
			show = 8
		}
		labels := make([]string, show)
		for i := 0; i < show; i++ {
			labels[i] = epLabel(eps[i])
		}
		suffix := ""
		if n > 8 {
			suffix = " …"
		}
		L = append(L, fmt.Sprintf("entry points reaching it (%d): %s%s", n, strings.Join(labels, ", "), suffix))
	}

	pkgKeys := append([]string{}, byPkg.Keys()...)
	sort.SliceStable(pkgKeys, func(i, j int) bool {
		li, lj := len(byPkg.Get(pkgKeys[i])), len(byPkg.Get(pkgKeys[j]))
		if li != lj {
			return li > lj
		}
		return LessJS(pkgKeys[i], pkgKeys[j])
	})
	if len(pkgKeys) > 0 {
		L = append(L, "by package:")
	}
	show := len(pkgKeys)
	if show > 8 {
		show = 8
	}
	for i := 0; i < show; i++ {
		p := pkgKeys[i]
		files := byPkg.Get(p)
		fn := len(files)
		fshow := fn
		if fshow > 5 {
			fshow = 5
		}
		names := make([]string, fshow)
		for j := 0; j < fshow; j++ {
			names[j] = lastPathSegment(files[j])
		}
		suffix := ""
		if fn > 5 {
			suffix = fmt.Sprintf(" (+%d)", fn-5)
		}
		L = append(L, fmt.Sprintf("  %s(%d): %s%s", scopedPkgPrefix.ReplaceAllString(p, ""), fn, strings.Join(names, " "), suffix))
	}
	if len(pkgKeys) > 8 {
		L = append(L, fmt.Sprintf("  … +%d more packages", len(pkgKeys)-8))
	}

	if len(cls) > 0 {
		clsShow := cls
		if len(clsShow) > 8 {
			clsShow = clsShow[:8]
		}
		labels := make([]string, len(clsShow))
		for i, c := range clsShow {
			if lbl, ok := clusterLabel[c]; ok {
				labels[i] = lbl
			} else {
				labels[i] = c
			}
		}
		L = append(L, "clusters affected: "+strings.Join(labels, ", "))
	}

	for _, wc := range warns {
		L = append(L, fmt.Sprintf("⚠ %s: %s → %s", wc.Reason, Short(wc.From), Short(wc.To)))
	}

	if args.Bool("json") {
		payload := ImpactJSON{
			Targets:     nonNilStrs(targets),
			Impacted:    nonNilStrs(impactedIDs),
			EntryPoints: epIDs(eps),
			ByPackage:   byPkg,
			Clusters:    nonNilStrs(cls),
			Sinks:       nonNilStrs(sinkKinds),
			Warnings:    nonNilWarns(warns),
		}
		b, err := MarshalPretty(payload)
		if err != nil {
			fmt.Fprintln(w, "{}")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	fmt.Fprintln(w, strings.Join(L, "\n"))
	return 0
}

// epLabel ports the `epLabel` closure (draht-tools.cjs:5432).
func epLabel(e model.EntryPointRef) string {
	name := ""
	if e.Name != nil {
		name = *e.Name
	}
	switch e.Kind {
	case "cli":
		return "cli:" + name
	case "http":
		if len(e.Routes) > 0 {
			return "http:" + e.Routes[0].Method + " " + e.Routes[0].Path
		}
		return "http:"
	default:
		if name != "" {
			return "lib:" + name
		}
		return "lib:" + lastPathSegment(e.Path)
	}
}

func epIDs(eps []model.EntryPointRef) []string {
	out := make([]string, len(eps))
	for i, e := range eps {
		out[i] = e.ID
	}
	return nonNilStrs(out)
}

func nonNilWarns(xs []model.SurprisingConnection) []model.SurprisingConnection {
	if xs == nil {
		return []model.SurprisingConnection{}
	}
	return xs
}
