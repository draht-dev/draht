package graph

import (
	"path"
	"regexp"
	"strings"

	"github.com/draht-dev/draht/go/internal/scan"
)

// ProbeExts is the CJS `tsLikeExts` (draht-tools.cjs:2216), order-significant.
// Index probing uses the same slice (`tsxIndexExts === tsLikeExts`, cjs:2217).
var ProbeExts = []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}

// nodeNextExts is the CJS `/\.(js|mjs|cjs|jsx)$/` set: when a relative
// specifier ends in one of these, resolveSpec ALSO tries the
// extension-stripped stem (NodeNext resolution: "./foo.js" on disk may
// really be "./foo.ts").
var nodeNextExts = []string{".js", ".mjs", ".cjs", ".jsx"}

// lastExtRe ports the JS `/\.[^/.]+$/` regex used when building workspace
// entry candidates: it matches a single trailing extension (a dot followed
// by one-or-more non-dot, non-slash characters at the end of the string).
var lastExtRe = regexp.MustCompile(`\.[^/.]+$`)

// ResolverIndex is the lookup structure Resolver consults. Membership in
// Modules — never the filesystem — is what "exists" means (design Spike 4
// §A2): resolution is a pure lookup against the set of files that survived
// discovery + the code-language filter.
type ResolverIndex struct {
	// Modules is the set of repo-relative POSIX paths of every module in
	// the graph.
	Modules map[string]struct{}
	// WorkspaceEntry maps a package.json "name" to its resolved
	// repo-relative entry module path (see BuildWorkspaceEntries).
	WorkspaceEntry map[string]string
}

// NewResolverIndex builds a ResolverIndex from a slice of module paths and
// the workspace-entry map (see BuildWorkspaceEntries). modulePaths need not
// be sorted; the index is a plain lookup set.
func NewResolverIndex(modulePaths []string, workspaceEntry map[string]string) *ResolverIndex {
	idx := &ResolverIndex{
		Modules:        make(map[string]struct{}, len(modulePaths)),
		WorkspaceEntry: workspaceEntry,
	}
	if idx.WorkspaceEntry == nil {
		idx.WorkspaceEntry = map[string]string{}
	}
	for _, p := range modulePaths {
		idx.Modules[p] = struct{}{}
	}
	return idx
}

// Resolver resolves an import specifier to a module path, ported verbatim
// from resolveSpec (draht-tools.cjs:2256-2285).
type Resolver struct {
	idx *ResolverIndex
}

// NewResolver returns a Resolver backed by idx. idx must not be mutated
// concurrently with calls to Resolve (Resolve only reads it).
func NewResolver(idx *ResolverIndex) *Resolver {
	return &Resolver{idx: idx}
}

// Resolve maps a raw specifier, seen while importing from fromDir (a
// repo-relative POSIX directory, "." for repo-root files), to a
// repo-relative module path. ok is false when the specifier is external or
// unresolvable — including an unresolvable RELATIVE specifier, which the
// CJS engine (faithfully reproduced here) still reports as "external" at
// the edge-construction layer, not as a distinct "unresolved" kind (design
// Spike 4 §A4).
//
// Branch 1 (specifier starts with "." or "/"): stems = [normalized] plus,
// when the specifier ends in .js/.mjs/.cjs/.jsx, the extension-stripped
// stem (NodeNext resolution). Per stem: exact match first, then ProbeExts
// appended, then "<stem>/index<ext>" for each ProbeExts entry.
//
// Branch 2 (bare specifier): exact package-name match, then the
// scope-aware first-slash prefix ("@scope/name/sub" collapses to
// "@scope/name").
func (r *Resolver) Resolve(specifier, fromDir string) (string, bool) {
	if specifier == "" {
		return "", false
	}
	if strings.HasPrefix(specifier, ".") || strings.HasPrefix(specifier, "/") {
		return r.resolveRelative(fromDir, specifier)
	}
	return r.resolveBare(specifier)
}

func (r *Resolver) resolveRelative(fromDir, spec string) (string, bool) {
	base := posixNormalize(path.Join(fromDir, spec))
	stems := []string{base}
	if stripped, ok := stripNodeNextExt(base); ok {
		stems = append(stems, stripped)
	}
	for _, stem := range stems {
		if _, ok := r.idx.Modules[stem]; ok {
			return stem, true
		}
		for _, ext := range ProbeExts {
			c := stem + ext
			if _, ok := r.idx.Modules[c]; ok {
				return c, true
			}
		}
		for _, ext := range ProbeExts {
			c := path.Join(stem, "index"+ext)
			if _, ok := r.idx.Modules[c]; ok {
				return c, true
			}
		}
	}
	return "", false
}

func (r *Resolver) resolveBare(spec string) (string, bool) {
	if e, ok := r.idx.WorkspaceEntry[spec]; ok {
		return e, true
	}
	// cjs: const slash = spec.indexOf("/", spec.startsWith("@") ?
	//   spec.indexOf("/") + 1 : 0);
	from := 0
	if strings.HasPrefix(spec, "@") {
		i := strings.Index(spec, "/")
		if i < 0 {
			return "", false
		}
		from = i + 1
	}
	if from > len(spec) {
		return "", false
	}
	j := strings.Index(spec[from:], "/")
	if j < 0 {
		return "", false
	}
	slash := from + j
	if slash > 0 {
		pkgName := spec[:slash]
		if e, ok := r.idx.WorkspaceEntry[pkgName]; ok {
			return e, true
		}
	}
	return "", false
}

// stripNodeNextExt strips a trailing .js/.mjs/.cjs/.jsx suffix from base,
// reporting whether one was found (ports `/\.(js|mjs|cjs|jsx)$/`).
func stripNodeNextExt(base string) (string, bool) {
	for _, ext := range nodeNextExts {
		if strings.HasSuffix(base, ext) {
			return strings.TrimSuffix(base, ext), true
		}
	}
	return "", false
}

// posixNormalize ports path.posix.normalize semantics closely enough for
// our purposes: path.Clean already handles the general case, but an empty
// result must still normalize to "." (matching Node, which normalize()s ""
// to ".").
func posixNormalize(p string) string {
	c := path.Clean(p)
	if c == "" {
		return "."
	}
	return c
}

// replaceLastExt ports `rel.replace(/\.[^/.]+$/, "") + ext`: if rel ends in
// a single extension, that extension is replaced by ext; otherwise ext is
// appended unchanged. Used only for workspace-entry candidate probing,
// which is why it differs from the relative-specifier probe (which always
// APPENDS — see Resolve's design note in Spike 4 §A3 vs §A2).
func replaceLastExt(rel, ext string) string {
	if lastExtRe.MatchString(rel) {
		return lastExtRe.ReplaceAllString(rel, "") + ext
	}
	return rel + ext
}

// EntryCandidates returns, in CJS order (draht-tools.cjs:2228-2239), the
// entry-file candidates for one workspace package manifest: main, module,
// every string leaf of exports (already collected by scan.ScanPackages in
// Object.values() order), then the four hardcoded fallbacks.
func EntryCandidates(pkg scan.Package) []string {
	var out []string
	if pkg.Main != "" {
		out = append(out, pkg.Main)
	}
	if pkg.Module != "" {
		out = append(out, pkg.Module)
	}
	out = append(out, pkg.ExportLeaves...)
	out = append(out, "src/index.ts", "src/index.js", "index.ts", "index.js")
	return out
}

// normalizeEntryCandidate ports the workspace-entry normalization at
// cjs:2243: posix.normalize(posix.join(pkgDir, cand.replace(/^\.\//,""))),
// then strip EVERY "../" occurrence post-normalize (the CJS hack — not a
// path traversal fix, just a literal global string replace).
func normalizeEntryCandidate(pkgDir, cand string) string {
	trimmed := strings.TrimPrefix(cand, "./")
	joined := posixNormalize(path.Join(pkgDir, trimmed))
	return strings.ReplaceAll(joined, "../", "")
}

// ResolveWorkspaceEntry probes candidates (see EntryCandidates) for pkgDir
// against modules, in CJS order (draht-tools.cjs:2240-2251): for each
// candidate, try the normalized path exactly, then each ProbeExts entry
// substituted for the candidate's own trailing extension (NOT appended —
// this differs from resolveRelative, since main/module/exports values
// typically already carry an extension, e.g. "dist/index.js" -> "src/index.ts"
// falls out of trying ".ts" in place of ".js"). First candidate to hit wins.
func ResolveWorkspaceEntry(pkgDir string, candidates []string, modules map[string]struct{}) (string, bool) {
	for _, cand := range candidates {
		rel := normalizeEntryCandidate(pkgDir, cand)
		if _, ok := modules[rel]; ok {
			return rel, true
		}
		for _, ext := range ProbeExts {
			r := replaceLastExt(rel, ext)
			if _, ok := modules[r]; ok {
				return r, true
			}
		}
	}
	return "", false
}

// BuildWorkspaceEntries builds the workspaceEntryByName map
// (draht-tools.cjs:2222-2254) for every package in pkgs: the package name
// maps to its resolved repo-relative entry module, or is absent when no
// candidate resolves.
func BuildWorkspaceEntries(pkgs []scan.Package, modules map[string]struct{}) map[string]string {
	out := make(map[string]string)
	for _, p := range pkgs {
		pkgDir := p.Path
		if pkgDir == "." {
			pkgDir = ""
		}
		candidates := EntryCandidates(p)
		if entry, ok := ResolveWorkspaceEntry(pkgDir, candidates, modules); ok {
			out[p.Name] = entry
		}
	}
	return out
}
