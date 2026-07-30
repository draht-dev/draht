package flow

import (
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// buildContext holds the per-Input lookup tables shared across every
// entry-point's flow build (draht-tools.cjs:2545-2571's prebuilt indices).
type buildContext struct {
	in                 Input
	moduleByID         map[string]*model.Module
	callOutByModule    map[string][]model.CallEdge
	modulesByContainer map[string][]*model.Module
}

func newBuildContext(in Input) *buildContext {
	ctx := &buildContext{
		in:                 in,
		moduleByID:         make(map[string]*model.Module, len(in.Modules)),
		callOutByModule:    make(map[string][]model.CallEdge),
		modulesByContainer: make(map[string][]*model.Module),
	}
	for i := range in.Modules {
		m := &in.Modules[i]
		ctx.moduleByID[m.ID] = m
		ctx.modulesByContainer[containerOf2(m)] = append(ctx.modulesByContainer[containerOf2(m)], m)
	}
	for _, ce := range in.CallEdges {
		ctx.callOutByModule[ce.From] = append(ctx.callOutByModule[ce.From], ce)
	}
	return ctx
}

// containerOf2 mirrors the CJS nil-safe containerOf helper
// (draht-tools.cjs:2545): "pkg:"+m.Package when set, else "dir:"+first path
// segment. Returns "" for a nil module.
func containerOf2(m *model.Module) string {
	if m == nil {
		return ""
	}
	if m.Package != nil && *m.Package != "" {
		return "pkg:" + *m.Package
	}
	first := m.Path
	if idx := strings.IndexByte(m.Path, '/'); idx >= 0 {
		first = m.Path[:idx]
	}
	return "dir:" + first
}

// relShort mirrors `(p||"").split("/").slice(-2).join("/")`
// (draht-tools.cjs:2543).
func relShort(p string) string {
	if p == "" {
		return ""
	}
	parts := strings.Split(p, "/")
	if len(parts) <= 2 {
		return p
	}
	return strings.Join(parts[len(parts)-2:], "/")
}

// docFor mirrors `mod?.exports?.find(x => x.name === symbol)?.doc ?? null`
// (draht-tools.cjs:2544).
func docFor(mod *model.Module, symbol string) *string {
	if mod == nil {
		return nil
	}
	for _, e := range mod.Exports {
		if e.Name == symbol {
			return e.Doc
		}
	}
	return nil
}

func exportsHas(mod *model.Module, symbol string) bool {
	if mod == nil {
		return false
	}
	for _, e := range mod.Exports {
		if e.Name == symbol {
			return true
		}
	}
	return false
}

// BuildFlows ports visComputeFlows (draht-tools.cjs:2536-2818): one flow per
// entry point, in EntryPoints order, with no cap and no sort. An entry point
// whose module cannot be resolved contributes no flow.
func BuildFlows(in Input) []Flow {
	ctx := newBuildContext(in)
	flows := make([]Flow, 0, len(in.EntryPoints))
	for _, ep := range in.EntryPoints {
		if f := ctx.buildFlow(ep); f != nil {
			flows = append(flows, *f)
		}
	}
	return flows
}

func (ctx *buildContext) buildFlow(ep model.EntryPointRef) *Flow {
	startMod := ctx.moduleByID[ep.ID]
	if startMod == nil {
		return nil
	}
	startContainer := containerOf2(startMod)
	if startContainer == "" {
		return nil
	}

	stepN := 1
	steps := []FlowStep{
		{
			Kind:        stepEntry,
			N:           stepN,
			From:        "actor:user",
			To:          startContainer,
			Title:       entryTitle(ep),
			Description: describeEntry(ep, startMod),
			FromFile:    nil,
			ToFile:      strPtr(ep.Path),
			BoxFrom:     "actor:user",
			BoxTo:       startContainer,
		},
	}
	stepN++

	visitedModules := newOrderedSet()
	visitedModules.add(ep.ID)
	visitedContainers := newOrderedSet()
	visitedContainers.add(startContainer)
	emittedHopKeys := make(map[string]struct{})
	enqueued := make(map[string]struct{})
	enqueued[ep.ID] = struct{}{}

	type queueItem struct {
		id    string
		depth int
	}
	queue := []queueItem{{ep.ID, 0}}

	for len(queue) > 0 && stepN <= MaxStepsPerFlow && visitedModules.len() < MaxModulesPerFlow {
		cur := queue[0]
		queue = queue[1:]
		if cur.depth > MaxBFSDepth {
			continue
		}
		fromMod := ctx.moduleByID[cur.id]
		fromContainer := containerOf2(fromMod)

		calls := append([]model.CallEdge(nil), ctx.callOutByModule[cur.id]...)
		sort.SliceStable(calls, func(i, j int) bool { return calls[i].Count > calls[j].Count })

		if len(calls) == 0 {
			reTargets := ctx.in.ReExportTargets[cur.id]
			if len(reTargets) > 0 {
				fanout := reTargets
				if len(fanout) > MaxReExportFanout {
					fanout = fanout[:MaxReExportFanout]
				}
				for _, t := range fanout {
					if _, ok := enqueued[t]; ok {
						continue
					}
					enqueued[t] = struct{}{}
					visitedModules.add(t)
					queue = append(queue, queueItem{t, cur.depth}) // same depth: transparent barrel hop
				}
				continue // barrel hop emits no step
			}

			importRank := func(to string) int {
				tm := ctx.moduleByID[to]
				if tm == nil {
					return 0
				}
				r := 0
				if containerOf2(tm) != fromContainer {
					r += 3
				}
				if len(tm.Sinks) > 0 {
					r += 2
				}
				if len(tm.Exports) > 0 {
					r++
				}
				return r
			}
			var fallback []string
			for _, to := range ctx.in.Adjacency[cur.id] {
				if _, ok := enqueued[to]; ok {
					continue
				}
				fallback = append(fallback, to)
			}
			sort.SliceStable(fallback, func(i, j int) bool {
				ri, rj := importRank(fallback[i]), importRank(fallback[j])
				if ri != rj {
					return ri > rj
				}
				return fallback[i] < fallback[j]
			})
			if len(fallback) > MaxCallsPerNode {
				fallback = fallback[:MaxCallsPerNode]
			}
			if len(fallback) == 0 {
				continue
			}
			for _, to := range fallback {
				calls = append(calls, model.CallEdge{From: cur.id, To: to, Symbol: "(imports)", Count: 0})
			}
		}

		limited := calls
		if len(limited) > MaxCallsPerNode {
			limited = limited[:MaxCallsPerNode]
		}
		for _, ce := range limited {
			toMod := ctx.moduleByID[ce.To]
			toContainer := containerOf2(toMod)
			isCross := fromContainer != toContainer
			callDoc := docFor(toMod, ce.Symbol)
			calleeExported := exportsHas(toMod, ce.Symbol)
			calleeHasSinks := toMod != nil && len(toMod.Sinks) > 0
			shouldEmit := isCross || callDoc != nil || calleeExported || calleeHasSinks || cur.depth <= 1

			if shouldEmit {
				if isCross {
					visitedContainers.add(toContainer)
				}
				var hopKey string
				if isCross {
					hopKey = fromContainer + "→" + toContainer + "#" + ce.Symbol
				} else {
					hopKey = ce.From + "→" + ce.To + "#" + ce.Symbol
				}
				if _, seen := emittedHopKeys[hopKey]; !seen {
					emittedHopKeys[hopKey] = struct{}{}
					steps = append(steps, buildCallStep(stepN, ce, fromContainer, toContainer, isCross, toMod, callDoc, calleeHasSinks))
					stepN++
				}
			}

			visitedModules.add(ce.To)
			if _, ok := enqueued[ce.To]; !ok {
				enqueued[ce.To] = struct{}{}
				queue = append(queue, queueItem{ce.To, cur.depth + 1})
			}
			if stepN > MaxStepsPerFlow {
				break
			}
		}
	}

	steps = ctx.appendSinkSteps(steps, &stepN, visitedModules, visitedContainers)

	return &Flow{
		ID:             "flow:" + ep.ID,
		Name:           flowName(ep),
		Description:    flowDescription(ep),
		Entry:          ep.ID,
		EntryKind:      ep.Kind,
		EntryContainer: startContainer,
		Steps:          steps,
	}
}

// appendSinkSteps ports draht-tools.cjs:2742-2799: a concrete-sink-site pass
// over visitedModules (insertion order), and — only when that pass emitted
// nothing — a fallback aggregated-sink-kind pass over visitedContainers.
func (ctx *buildContext) appendSinkSteps(steps []FlowStep, stepN *int, visitedModules, visitedContainers *orderedSet) []FlowStep {
	emittedSinkKinds := make(map[string]struct{})

	for _, modID := range visitedModules.items {
		if *stepN > SinkStepCeiling {
			break
		}
		mod := ctx.moduleByID[modID]
		if mod == nil || len(mod.SinkSites) == 0 {
			continue
		}
		fromContainer := containerOf2(mod)

		var kindOrder []string
		firstSite := make(map[string]model.SinkSite)
		for _, s := range mod.SinkSites {
			if _, ok := firstSite[s.Kind]; !ok {
				firstSite[s.Kind] = s
				kindOrder = append(kindOrder, s.Kind)
			}
		}

		for _, kind := range kindOrder {
			if _, ok := emittedSinkKinds[kind]; ok {
				continue
			}
			emittedSinkKinds[kind] = struct{}{}
			site := firstSite[kind]

			fnPart := "top-level code"
			if site.InFunction != nil && *site.InFunction != "" {
				fnPart = "`" + *site.InFunction + "()`"
			}
			phrase, ok := SinkPhrase[kind]
			if !ok {
				phrase = "performs " + kind
			}
			title := SinkLabel[kind]
			if title == "" {
				title = kind
			}

			steps = append(steps, FlowStep{
				Kind:        stepSink,
				N:           *stepN,
				From:        fromContainer,
				To:          SinkBoxID(kind),
				BoxFrom:     fromContainer,
				BoxTo:       SinkBoxID(kind),
				Title:       title,
				Description: mod.Path + ":" + strconv.Itoa(site.Line) + " — " + fnPart + " " + phrase + ". `" + site.Snippet + "`",
				SinkKind:    kind,
				SinkSite: &SinkSite{
					File:    mod.Path,
					Line:    site.Line,
					Fn:      site.InFunction,
					Snippet: site.Snippet,
				},
			})
			*stepN++
			if *stepN > SinkStepCeiling {
				break
			}
		}
	}

	if len(emittedSinkKinds) > 0 {
		return steps
	}

	for _, c := range visitedContainers.items {
		if *stepN > SinkStepCeiling {
			break
		}
		var kinds []string
		seen := make(map[string]struct{})
		for _, m := range ctx.modulesByContainer[c] {
			for _, s := range m.Sinks {
				if _, ok := seen[s]; !ok {
					seen[s] = struct{}{}
					kinds = append(kinds, s)
				}
			}
		}
		for _, kind := range kinds {
			if _, ok := emittedSinkKinds[kind]; ok {
				continue
			}
			emittedSinkKinds[kind] = struct{}{}

			title := SinkLabel[kind]
			if title == "" {
				title = kind
			}
			phrase, ok := SinkPhrase[kind]
			if !ok {
				phrase = "performs `" + kind + "`"
			}
			steps = append(steps, FlowStep{
				Kind:        stepSinkFallback,
				N:           *stepN,
				From:        c,
				To:          SinkBoxID(kind),
				BoxFrom:     c,
				BoxTo:       SinkBoxID(kind),
				Title:       title,
				Description: strings.TrimPrefix(c, "pkg:") + " " + phrase + ".",
				SinkKind:    kind,
			})
			*stepN++
			if *stepN > SinkStepCeiling {
				break
			}
		}
	}
	return steps
}

func buildCallStep(n int, ce model.CallEdge, fromContainer, toContainer string, isCross bool, toMod *model.Module, callDoc *string, calleeHasSinks bool) FlowStep {
	var symbolPhrase string
	switch ce.Symbol {
	case "default":
		symbolPhrase = "the default export"
	case "*":
		symbolPhrase = "the namespace import"
	case "(imports)":
		symbolPhrase = "into its imports"
	default:
		symbolPhrase = "`" + ce.Symbol + "()`"
	}

	var docPhrase string
	if callDoc != nil {
		docPhrase = " — " + *callDoc
	} else if calleeHasSinks && toMod != nil {
		sinks := toMod.Sinks
		if len(sinks) > 2 {
			sinks = sinks[:2]
		}
		docPhrase = " (which performs " + strings.Join(sinks, ", ") + ")"
	}

	from, to := ce.From, ce.To
	if isCross {
		from, to = fromContainer, toContainer
	}

	toBase := ce.To
	if toMod != nil && toMod.Path != "" {
		toBase = path.Base(toMod.Path)
	}

	title := strings.ReplaceAll(symbolPhrase, "`", "") + " in " + toBase
	description := relShort(ce.From) + " calls " + symbolPhrase + " in " + relShort(ce.To) + docPhrase + "."

	fromFile, toFile := ce.From, ce.To
	return FlowStep{
		Kind:        stepCall,
		N:           n,
		From:        from,
		To:          to,
		BoxFrom:     fromContainer,
		BoxTo:       toContainer,
		Title:       title,
		Description: description,
		Symbol:      ce.Symbol,
		FromFile:    &fromFile,
		ToFile:      &toFile,
	}
}

func entryTitle(ep model.EntryPointRef) string {
	switch ep.Kind {
	case model.EntryKindCLI:
		return "invoke `" + nameOr(ep.Name, "cli") + "`"
	case model.EntryKindHTTP:
		if len(ep.Routes) > 0 {
			return ep.Routes[0].Method + " " + ep.Routes[0].Path
		}
		return "HTTP request"
	default: // library
		return "call " + nameOr(ep.Name, "library")
	}
}

func describeEntry(ep model.EntryPointRef, mod *model.Module) string {
	switch ep.Kind {
	case model.EntryKindCLI:
		name := nameOr(ep.Name, "cli")
		s := "User runs `" + name + "` from the shell. Entry is " + ep.Path + "."
		var cmds []string
		for _, e := range mod.Exports {
			if e.Kind == "command" {
				cmds = append(cmds, e.Name)
			}
		}
		if len(cmds) > 0 {
			shown := cmds
			suffix := ""
			if len(shown) > 6 {
				shown = shown[:6]
				suffix = ", …"
			}
			parts := make([]string, len(shown))
			for i, c := range shown {
				parts[i] = "`" + c + "`"
			}
			s += " Dispatches commands: " + strings.Join(parts, ", ") + suffix + "."
		}
		return s
	case model.EntryKindHTTP:
		route := ""
		if len(ep.Routes) > 0 {
			route = ep.Routes[0].Method + " " + ep.Routes[0].Path
		}
		return "Incoming HTTP request " + route + " hits the handler in " + ep.Path + "."
	default: // library
		s := "Library consumer imports from " + ep.Path
		if len(mod.Exports) > 0 {
			shown := mod.Exports
			if len(shown) > 3 {
				shown = shown[:3]
			}
			parts := make([]string, len(shown))
			for i, e := range shown {
				parts[i] = e.Kind + " `" + e.Name + "`"
			}
			s += ". Exposes " + strings.Join(parts, ", ") + "."
		} else {
			s += "."
		}
		return s
	}
}

func flowName(ep model.EntryPointRef) string {
	switch ep.Kind {
	case model.EntryKindCLI:
		return nameOr(ep.Name, path.Base(ep.Path)) + " (CLI)"
	case model.EntryKindHTTP:
		if len(ep.Routes) > 0 {
			return ep.Routes[0].Method + " " + ep.Routes[0].Path
		}
		return ep.Path
	default: // library
		return nameOr(ep.Name, path.Base(ep.Path)) + " (library)"
	}
}

func flowDescription(ep model.EntryPointRef) string {
	switch ep.Kind {
	case model.EntryKindCLI:
		return "User invokes the `" + nameOr(ep.Name, "cli") + "` CLI command. The trace below shows which files run, what symbols they call, and what side effects they produce."
	case model.EntryKindHTTP:
		return "An incoming HTTP request flows through the handler, calls dependent services, and reaches downstream side effects."
	default: // library
		return "Library consumer imports from this entry. The trace shows what the entry exposes and which downstream side effects it can produce."
	}
}

func nameOr(name *string, fallback string) string {
	if name != nil && *name != "" {
		return *name
	}
	return fallback
}

func strPtr(s string) *string { return &s }
