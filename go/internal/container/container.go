package container

import (
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// indexFileRe matches a barrel/index file path suffix, verbatim from
// draht-tools.cjs:2398 (`/\/index\.(?:ts|tsx|js|mjs|cjs)$/` — note this
// requires a preceding "/", unlike the clustering package's barrel regex
// which also accepts a bare root-level "index.ts").
var indexFileRe = regexp.MustCompile(`/index\.(?:ts|tsx|js|mjs|cjs)$`)

// ContainerOf returns m's container id: "pkg:" + its package name when set,
// else "dir:" + the first path segment. Verbatim port of the `containerOf`
// closure at draht-tools.cjs:2355-2359 (used by containers/containerEdges/
// clustering; the flow package's containerOf2 is a nil-safe variant of the
// same rule and is NOT this function's concern).
func ContainerOf(m *model.Module) string {
	if m.Package != nil && *m.Package != "" {
		return "pkg:" + *m.Package
	}
	return "dir:" + firstPathSegment(m.Path)
}

func firstPathSegment(p string) string {
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return p
}

// countByPathPrefix counts modules whose Path starts with prefix+"/" —
// draht-tools.cjs:2339/2351's `moduleCount` rule. This is DELIBERATELY a
// different rule from ContainerOf (see design note on containers[*].
// moduleCount vs boxes[*].moduleCount divergence for nested workspace
// packages) — do not "simplify" this to ContainerOf-based counting.
func countByPathPrefix(modules []model.Module, prefix string) int {
	pfx := prefix + "/"
	n := 0
	for _, m := range modules {
		if strings.HasPrefix(m.Path, pfx) {
			n++
		}
	}
	return n
}

// BuildContainers derives the containers[] list: one per non-root workspace
// package when there is more than one package, else one per top-level
// directory. Verbatim port of draht-tools.cjs:2329-2354. TopFiles is left as
// an empty (non-nil) slice; the caller fills it via ComputeTopFiles once
// in-degree/out-degree maps are available.
//
// Order: pkgs discovery order (root manifest, Path=="." , skipped) in the
// multi-package branch; module-encounter order of first path segments in the
// single/no-package fallback branch. No sort, no cap — this order IS the
// final containers[] order (and therefore also boundedContexts[] order).
func BuildContainers(modules []model.Module, pkgs []model.Package) []model.Container {
	var containers []model.Container
	if len(pkgs) > 1 {
		for _, p := range pkgs {
			if p.Path == "." {
				continue
			}
			containers = append(containers, model.Container{
				ID:          "pkg:" + p.Name,
				Name:        p.Name,
				Path:        p.Path,
				Kind:        "package",
				Description: p.Description,
				ModuleCount: countByPathPrefix(modules, p.Path),
				TopFiles:    []model.TopFile{},
			})
		}
	} else {
		seen := make(map[string]struct{})
		var topDirs []string
		for _, m := range modules {
			first := firstPathSegment(m.Path)
			if first == "" || strings.Contains(first, ".") {
				continue
			}
			if _, ok := seen[first]; ok {
				continue
			}
			seen[first] = struct{}{}
			topDirs = append(topDirs, first)
		}
		for _, d := range topDirs {
			containers = append(containers, model.Container{
				ID:          "dir:" + d,
				Name:        d,
				Path:        d,
				Kind:        "directory",
				Description: nil,
				ModuleCount: countByPathPrefix(modules, d),
				TopFiles:    []model.TopFile{},
			})
		}
	}
	if containers == nil {
		containers = []model.Container{}
	}
	return containers
}

// hasDocExport reports whether any export carries a (non-empty) doc comment.
// model.Export.Doc is nil exactly when the CJS source's `e.doc` would be
// falsy (see graph/convert.go's convertExports), so a nil check reproduces
// the JS `.some(e => e.doc)` truthiness test exactly.
func hasDocExport(exports []model.Export) bool {
	for _, e := range exports {
		if e.Doc != nil {
			return true
		}
	}
	return false
}

// topFileReason mirrors the reason cascade at draht-tools.cjs:2401-2410 (an
// if/else-if chain — Go's switch{} with boolean cases evaluates identically,
// stopping at the first true case).
func topFileReason(m *model.Module, inDeg, outDeg, medianLoc int) string {
	switch {
	case m.EntryPoint != nil:
		switch m.EntryPoint.Kind {
		case model.EntryKindCLI:
			return "CLI entry"
		case model.EntryKindHTTP:
			return "HTTP handler"
		default:
			return "library entry"
		}
	case len(m.Routes) > 0:
		return "HTTP handler"
	case indexFileRe.MatchString(m.Path):
		return "package index"
	case inDeg >= 3:
		return "most depended-on"
	case outDeg >= 8:
		return "orchestrator"
	case float64(m.Loc) > float64(medianLoc)*1.5:
		return "largest"
	default:
		return "core file"
	}
}

// ComputeTopFiles ranks c's non-test modules by relevance score, returning
// the top 3 (containers with < 6 eligible modules) or top 5 (>= 6). Verbatim
// port of computeTopFiles (draht-tools.cjs:2384-2416). inDeg/outDeg are the
// import-edge degree maps (test edges INCLUDED — draht-tools.cjs:2364-2371;
// this is a DIFFERENT, non-test-excluded pair from the hotspot ranker's
// inDegNT/outDegNT).
//
// Sort: score DESC, path ASC (lexicographic byte compare — matches JS `<`
// on ASCII paths). Score uses model.ToFixed2, a verbatim port of the CJS
// source's `+score.toFixed(2)` (draht-tools.cjs:2411).
func ComputeTopFiles(c model.Container, modules []model.Module, inDeg, outDeg map[string]int) []model.TopFile {
	var mods []*model.Module
	for i := range modules {
		m := &modules[i]
		if m.IsTest {
			continue
		}
		if ContainerOf(m) != c.ID {
			continue
		}
		mods = append(mods, m)
	}
	if len(mods) == 0 {
		return []model.TopFile{}
	}

	locs := make([]int, len(mods))
	for i, m := range mods {
		locs[i] = m.Loc
	}
	sort.Ints(locs)
	medianLoc := locs[len(locs)/2]

	scored := make([]model.TopFile, len(mods))
	for i, m := range mods {
		score := 0.0
		if m.EntryPoint != nil {
			score += 6
		}
		if len(m.Routes) > 0 {
			score += 3
		}
		score += math.Log2(1 + float64(m.Loc))
		score += math.Log2(1 + float64(outDeg[m.ID]))
		score += math.Log2(1 + float64(inDeg[m.ID]))
		if indexFileRe.MatchString(m.Path) {
			score += 4
		}
		if hasDocExport(m.Exports) {
			score += 2
		}
		scored[i] = model.TopFile{
			Path:   m.Path,
			Reason: topFileReason(m, inDeg[m.ID], outDeg[m.ID], medianLoc),
			Score:  model.ToFixed2(score),
			Loc:    m.Loc,
		}
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		return scored[i].Path < scored[j].Path
	})

	limit := 5
	if len(mods) < 6 {
		limit = 3
	}
	if len(scored) > limit {
		scored = scored[:limit]
	}
	return scored
}
