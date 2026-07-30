package container

import (
	"regexp"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Container-edge classification regexes, verbatim from
// classifyContainerEdge (draht-tools.cjs:2454-2486). Regexes carrying a
// JS `/i` flag get a Go `(?i)` prefix; the rest are case-sensitive exactly
// as written in the CJS source — do not add case-insensitivity to those.
var (
	reUppercaseSymbol  = regexp.MustCompile(`^[A-Z]`)
	reSendsEvents      = regexp.MustCompile(`(?i)^(emit|dispatch|publish|broadcast|notify|fire|trigger)|sendEvent|EventBus|EventEmitter|MessageBus|^bus$|^events?$|subscribe|onEvent`)
	reUpdatesSymbol    = regexp.MustCompile(`^(set|update|mutate|patch|put|replace|remove|delete)[A-Z]|^use[A-Z]\w*State$`)
	reReadsStateSymbol = regexp.MustCompile(`^(get|read|fetch|load|find|list|query|select)[A-Z]`)
	reConfiguresSymbol = regexp.MustCompile(`(?i)^(config|configure|setup|init|initialize|register|bootstrap|provide|wire)`)
	reAnalyzesSymbol   = regexp.MustCompile(`(?i)^(analyz|inspect|check|validat|verify|audit|lint|scan)`)
	reExecutesSymbol   = regexp.MustCompile(`(?i)^(run|exec|execute|invoke|perform|do[A-Z])`)
	reReactDep         = regexp.MustCompile(`^(react|preact|solid-js|svelte)$`)
)

func indexModulesByID(modules []model.Module) map[string]*model.Module {
	out := make(map[string]*model.Module, len(modules))
	for i := range modules {
		out[modules[i].ID] = &modules[i]
	}
	return out
}

// buildContainerSinks unions modules[*].Sinks per container id, in a single
// pass — used by classifyContainerEdge's "Persists" rule
// (draht-tools.cjs:2468-2471: `modules.filter(m => containerOf(m) ===
// edge.to)`). Precomputing this once avoids an O(edges × modules) rescan.
func buildContainerSinks(modules []model.Module) map[string]map[string]struct{} {
	out := make(map[string]map[string]struct{})
	for i := range modules {
		m := &modules[i]
		if len(m.Sinks) == 0 {
			continue
		}
		c := ContainerOf(m)
		set, ok := out[c]
		if !ok {
			set = make(map[string]struct{})
			out[c] = set
		}
		for _, s := range m.Sinks {
			set[s] = struct{}{}
		}
	}
	return out
}

// pkgHasReactDep reports whether the first package named pkgName lists a
// react-ish (react/preact/solid-js/svelte) dependency or peer dependency
// (devDependencies are deliberately excluded). First-match-wins over pkgs,
// matching `pkgs.find(x => x.name === pkgName)` (draht-tools.cjs:2448-2452).
func pkgHasReactDep(pkgs []model.Package, pkgName string) bool {
	for _, p := range pkgs {
		if p.Name != pkgName {
			continue
		}
		for _, d := range p.Dependencies {
			if reReactDep.MatchString(d) {
				return true
			}
		}
		for _, d := range p.PeerDependencies {
			if reReactDep.MatchString(d) {
				return true
			}
		}
		return false
	}
	return false
}

// containerEdgeAgg accumulates one "ca→cb" container pair's aggregate before
// classification. SymbolFreq uses model.OrderedCounts so first-seen symbol
// order and per-symbol frequency are both available, matching the JS
// `Map<symbol, count>` (`edge.symbolFreq`).
type containerEdgeAgg struct {
	from, to   string
	count      int
	callCount  int
	symbolFreq *model.OrderedCounts
}

// classifyContainerEdge mirrors classifyContainerEdge
// (draht-tools.cjs:2454-2487): a priority-ordered rule cascade where EVERY
// matching rule's label is appended to labels (not just the first), and
// label = labels[0]. symbolSamples is the top-5 symbols by aggregated
// frequency (ties broken by first-seen order via a stable sort).
func classifyContainerEdge(
	ag *containerEdgeAgg,
	containerSinks map[string]map[string]struct{},
	pkgs []model.Package,
) (label string, labels []string, samples []string) {
	symbols := ag.symbolFreq.Keys()

	type freqPair struct {
		symbol string
		count  int
	}
	pairs := make([]freqPair, len(symbols))
	for i, s := range symbols {
		pairs[i] = freqPair{symbol: s, count: ag.symbolFreq.Get(s)}
	}
	sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].count > pairs[j].count })
	if len(pairs) > 5 {
		pairs = pairs[:5]
	}
	samples = make([]string, len(pairs))
	for i, p := range pairs {
		samples[i] = p.symbol
	}

	matchesAny := func(re *regexp.Regexp) bool {
		for _, s := range symbols {
			if re.MatchString(s) {
				return true
			}
		}
		return false
	}

	toPkgName := strings.TrimPrefix(ag.to, "pkg:")

	var out []string
	if pkgHasReactDep(pkgs, toPkgName) && matchesAny(reUppercaseSymbol) {
		out = append(out, "Renders")
	}
	if matchesAny(reSendsEvents) {
		out = append(out, "Sends Events")
	}
	toSinks := containerSinks[ag.to]
	if _, ok := toSinks["fs:write"]; ok {
		out = append(out, "Persists")
	} else if _, ok := toSinks["db:sql"]; ok {
		out = append(out, "Persists")
	} else if _, ok := toSinks["db:orm"]; ok {
		out = append(out, "Persists")
	}
	if matchesAny(reUpdatesSymbol) {
		out = append(out, "Updates")
	}
	if !containsStr(out, "Updates") && matchesAny(reReadsStateSymbol) {
		out = append(out, "Reads State")
	}
	if matchesAny(reConfiguresSymbol) {
		out = append(out, "Configures")
	}
	if matchesAny(reAnalyzesSymbol) {
		out = append(out, "Analyzes")
	}
	if matchesAny(reExecutesSymbol) {
		out = append(out, "Executes Actions")
	}
	if ag.callCount == 0 || len(symbols) < 3 {
		out = append(out, "Uses")
	}
	if len(out) == 0 {
		out = append(out, "Calls")
	}

	return out[0], out, samples
}

// BuildContainerEdges collapses import edges (pass 1) and callEdges (pass 2,
// aggregation only — it never creates a new container-edge entry) into
// cross-container dataflow edges. Verbatim port of the containerEdgeMap
// block (draht-tools.cjs:2422-2495). There is NO confidence field on the
// v5 ContainerEdge record.
//
// Order: first import-edge occurrence order (insertion order of the
// "ca→cb" map). No cap, no sort.
func BuildContainerEdges(
	edges []model.Edge,
	callEdges []model.CallEdge,
	modules []model.Module,
	pkgs []model.Package,
) []model.ContainerEdge {
	moduleByID := indexModulesByID(modules)
	containerSinks := buildContainerSinks(modules)

	var order []string
	byKey := make(map[string]*containerEdgeAgg)

	for _, e := range edges {
		if e.Kind != model.EdgeKindImport {
			continue
		}
		a, aok := moduleByID[e.From]
		b, bok := moduleByID[e.To]
		if !aok || !bok {
			continue
		}
		ca, cb := ContainerOf(a), ContainerOf(b)
		if ca == cb {
			continue
		}
		key := ca + "→" + cb
		ag, ok := byKey[key]
		if !ok {
			ag = &containerEdgeAgg{from: ca, to: cb, symbolFreq: model.NewOrderedCounts()}
			byKey[key] = ag
			order = append(order, key)
		}
		ag.count++
	}

	for _, ce := range callEdges {
		a, aok := moduleByID[ce.From]
		b, bok := moduleByID[ce.To]
		if !aok || !bok {
			continue
		}
		ca, cb := ContainerOf(a), ContainerOf(b)
		if ca == cb {
			continue
		}
		key := ca + "→" + cb
		ag, ok := byKey[key]
		if !ok {
			continue // pass 2 never creates entries
		}
		n := ce.Count
		if n == 0 {
			n = 1
		}
		ag.callCount += n
		ag.symbolFreq.Add(ce.Symbol, n)
	}

	out := make([]model.ContainerEdge, 0, len(order))
	for _, key := range order {
		ag := byKey[key]
		label, labels, samples := classifyContainerEdge(ag, containerSinks, pkgs)
		out = append(out, model.ContainerEdge{
			From:          ag.from,
			To:            ag.to,
			Count:         ag.count,
			CallCount:     ag.callCount,
			Label:         label,
			Labels:        labels,
			SymbolSamples: samples,
		})
	}
	return out
}
