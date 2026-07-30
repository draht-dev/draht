package rank

import "github.com/draht-dev/draht/go/internal/model"

// EntryPoints projects modules[*].entryPoint into the top-level
// entryPoints[] list (draht-tools.cjs:2498). It inherits `modules`' order
// verbatim (no cap, no sort): the caller must pass modules already sorted
// ascending by id, as the rest of the pipeline guarantees.
//
// Name and Routes marshal as literal JSON null whenever the underlying
// ModuleEntryPoint field is absent (`m.entryPoint.name || null` /
// `m.entryPoint.routes || null` in the CJS source) — an empty Name string
// or a nil/empty Routes slice on the module both produce a nil pointer /
// nil slice here, never a zero-value placeholder.
func EntryPoints(modules []model.Module) []model.EntryPointRef {
	out := make([]model.EntryPointRef, 0)
	for _, m := range modules {
		if m.EntryPoint == nil {
			continue
		}
		ref := model.EntryPointRef{
			ID:      m.ID,
			Path:    m.Path,
			Package: m.Package,
			Kind:    m.EntryPoint.Kind,
		}
		if m.EntryPoint.Name != "" {
			ref.Name = model.Str(m.EntryPoint.Name)
		}
		if len(m.EntryPoint.Routes) > 0 {
			ref.Routes = m.EntryPoint.Routes
		}
		out = append(out, ref)
	}
	return out
}

// SinkModules projects modules with at least one detected sink into the
// top-level sinks[] list (draht-tools.cjs:2506). No cap, no sort — it
// inherits `modules`' order verbatim, same contract as EntryPoints.
func SinkModules(modules []model.Module) []model.SinkModule {
	out := make([]model.SinkModule, 0)
	for _, m := range modules {
		if len(m.Sinks) == 0 {
			continue
		}
		out = append(out, model.SinkModule{
			ID:      m.ID,
			Path:    m.Path,
			Package: m.Package,
			Sinks:   m.Sinks,
		})
	}
	return out
}
