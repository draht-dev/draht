package query

import (
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Resolution is graphResolveFile's return value: the resolved module id,
// plus whether the match was exact (id === query) as opposed to inferred
// via the suffix/basename/substring fallback cascade.
type Resolution struct {
	ID    string
	Exact bool
}

// Resolver precomputes the lookups graphResolveFile needs (draht-tools.cjs:
// 5357-5369) once per process instead of rescanning map.modules on every
// call, as the CJS does. map.modules order is preserved throughout — it
// drives the tie-break in the substring stage (shortest id wins; ties keep
// modules order, which is already id-ASC in a real MAP.json).
type Resolver struct {
	modules []model.Module
	byID    map[string]*model.Module
}

// NewResolver builds a Resolver over m.Modules. m is not retained beyond
// what is copied into the index; callers may safely discard or mutate m's
// other fields afterward (though in practice m lives for the whole command).
func NewResolver(m *model.Map) *Resolver {
	r := &Resolver{
		modules: m.Modules,
		byID:    make(map[string]*model.Module, len(m.Modules)),
	}
	for i := range r.modules {
		r.byID[r.modules[i].ID] = &r.modules[i]
	}
	return r
}

// ModuleByID returns the module with the given id, or nil if absent.
func (r *Resolver) ModuleByID(id string) *model.Module {
	return r.byID[id]
}

// Resolve implements graphResolveFile's 4-stage cascade:
//  1. exact: normalized query equals a module id.
//  2. unique suffix: exactly one module id ends with "/" + normalized query.
//  3. unique basename: exactly one module's path basename equals the
//     normalized query's basename.
//  4. substring: modules whose id contains the normalized query, shortest
//     id wins (ties preserve map.modules order).
//
// A leading "./" is stripped from q exactly once before matching. Absolute
// paths are NOT normalized — deliberately: the CJS never special-cases
// them, so an absolute path only ever matches stage 4 if some module id
// literally contains it (practically never), and otherwise resolves to nil.
// An empty q resolves to nil (mirrors `if (!q) return null`).
func (r *Resolver) Resolve(q string) *Resolution {
	if q == "" {
		return nil
	}
	norm := q
	if strings.HasPrefix(norm, "./") {
		norm = norm[2:]
	}

	if m := r.byID[norm]; m != nil {
		return &Resolution{ID: m.ID, Exact: true}
	}

	suffix := "/" + norm
	var suffixMatch *model.Module
	suffixCount := 0
	for i := range r.modules {
		if strings.HasSuffix(r.modules[i].ID, suffix) {
			suffixCount++
			suffixMatch = &r.modules[i]
			if suffixCount > 1 {
				break
			}
		}
	}
	if suffixCount == 1 {
		return &Resolution{ID: suffixMatch.ID, Exact: false}
	}

	base := lastPathSegment(norm)
	var baseMatch *model.Module
	baseCount := 0
	for i := range r.modules {
		if lastPathSegment(r.modules[i].Path) == base {
			baseCount++
			baseMatch = &r.modules[i]
			if baseCount > 1 {
				break
			}
		}
	}
	if baseCount == 1 {
		return &Resolution{ID: baseMatch.ID, Exact: false}
	}

	var best *model.Module
	for i := range r.modules {
		if !strings.Contains(r.modules[i].ID, norm) {
			continue
		}
		if best == nil || len(r.modules[i].ID) < len(best.ID) {
			best = &r.modules[i]
		}
	}
	if best != nil {
		return &Resolution{ID: best.ID, Exact: false}
	}

	return nil
}

// lastPathSegment returns the final "/"-delimited segment of p (p itself
// if p has no "/"), matching JS `p.split("/").pop()`.
func lastPathSegment(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}
