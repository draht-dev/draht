package graph

import (
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// This file implements import resolution for python, go and rust — the three
// languages the engine already AST-parses but whose imports were, until the
// --experimental-lang-edges flag, extracted and then discarded (see the
// language gate in pipeline.go).
//
// It is deliberately separate from resolve.go. That file is a verbatim port of
// the CJS engine's resolveSpec and is frozen: it backs the byte-parity gate
// that lets the shim pin --parser regex and produce a MAP.json identical to
// the JS engine's. Nothing here may change TS/JS resolution.
//
// Precision policy, applied throughout: when a specifier cannot be resolved
// unambiguously, emit NO edge rather than a guess. The graph is consumed by
// LLMs as ground truth, so a confident wrong edge is worse than a missing one.

// GoModule is one go.mod discovered in the repo: the module path it declares
// and the repo-relative directory it sits in ("." for the repo root).
type GoModule struct {
	Path string
	Dir  string
}

// goModuleLineRe matches the `module <path>` directive of a go.mod. Go allows
// an inline `// comment` after it, which must not become part of the path.
var goModuleLineRe = regexp.MustCompile(`(?m)^\s*module\s+([^\s/]\S*)`)

// ParseGoModulePath extracts the module path from go.mod contents, or "" when
// the file declares none (an invalid go.mod, which is treated as absent).
func ParseGoModulePath(src []byte) string {
	m := goModuleLineRe.FindSubmatch(src)
	if m == nil {
		return ""
	}
	return strings.Trim(string(m[1]), `"`)
}

// LangResolver resolves import specifiers for python/go/rust against the same
// module set the TS/JS resolver uses. Membership in that set — never the
// filesystem — is what "exists" means, so resolution stays a pure lookup.
type LangResolver struct {
	idx *ResolverIndex

	// goModules is sorted by descending module-path length so that the
	// longest matching prefix wins: a nested module (…/draht/go) must beat its
	// parent (…/draht) for an import that both could claim.
	goModules []GoModule

	// goPkgFiles maps a repo-relative directory to the non-test .go files in
	// it, sorted. A Go import names a PACKAGE (a directory), not a file, which
	// is why resolution here is one-to-many.
	goPkgFiles map[string][]string

	// pyDirs is the set of directories containing at least one .py module, and
	// pyInit the subset that contain __init__.py. Together they let
	// pythonSourceRoot walk out of a package to find the directory that would
	// be on sys.path — the same rule CPython applies.
	pyInit map[string]struct{}
}

// NewLangResolver builds a LangResolver. modules is every code module in the
// graph (used to index Go packages and Python package markers); goModules is
// every go.mod found, in any order.
func NewLangResolver(idx *ResolverIndex, modules []scan.File, goModules []GoModule) *LangResolver {
	lr := &LangResolver{
		idx:        idx,
		goModules:  append([]GoModule(nil), goModules...),
		goPkgFiles: map[string][]string{},
		pyInit:     map[string]struct{}{},
	}
	sort.SliceStable(lr.goModules, func(i, j int) bool {
		if len(lr.goModules[i].Path) != len(lr.goModules[j].Path) {
			return len(lr.goModules[i].Path) > len(lr.goModules[j].Path)
		}
		return lr.goModules[i].Path < lr.goModules[j].Path
	})

	for _, f := range modules {
		dir := path.Dir(f.Rel)
		switch f.Lang {
		case scan.LangGo:
			// Test files are excluded from a package's importable surface:
			// including them would fan every importer out across _test.go
			// files that no other package can reference.
			//
			// scan.IsTest matches the JS conventions (.test./.spec.) and is a
			// frozen CJS port, so it does not recognise Go's _test.go — the
			// check has to live here.
			if !isGoTestFile(f.Rel) {
				lr.goPkgFiles[dir] = append(lr.goPkgFiles[dir], f.Rel)
			}
		case scan.LangPython:
			if path.Base(f.Rel) == "__init__.py" {
				lr.pyInit[dir] = struct{}{}
			}
		}
	}
	for dir := range lr.goPkgFiles {
		sort.Strings(lr.goPkgFiles[dir]) // map iteration is random; edges must not be
	}
	return lr
}

// Supports reports whether this resolver handles lang.
func (lr *LangResolver) Supports(lang scan.Lang) bool {
	switch lang {
	case scan.LangPython, scan.LangGo, scan.LangRust,
		scan.LangJava, scan.LangRuby, scan.LangShell:
		return true
	}
	return false
}

// Resolve maps one specifier to zero or more module paths. Zero means
// external or unresolvable — both emit an "external" edge upstream, matching
// how the TS/JS path reports an unresolved specifier.
//
// Only Go returns more than one target, because a Go import names a package
// directory whose whole non-test file set becomes a dependency.
func (lr *LangResolver) Resolve(lang scan.Lang, specifier, fromDir string) []string {
	if specifier == "" {
		return nil
	}
	switch lang {
	case scan.LangPython:
		return lr.resolvePython(specifier, fromDir)
	case scan.LangGo:
		return lr.resolveGo(specifier)
	case scan.LangRust:
		return lr.resolveRust(specifier, fromDir)
	case scan.LangJava:
		return lr.resolveJava(specifier)
	case scan.LangRuby:
		return lr.resolveRuby(specifier, fromDir)
	case scan.LangShell:
		return lr.resolveShell(specifier, fromDir)
	}
	return nil
}

// ── python ──────────────────────────────────────────────────────────────────

// resolvePython handles both import forms the query produces:
//
//	import a.b.c          -> specifier "a.b.c"
//	from ..pkg.mod import -> specifier "..pkg.mod"
//	from . import x       -> specifier "."
//
// Relative specifiers are exact: a leading dot means "this package", each
// additional dot climbs one package. Absolute specifiers are resolved against
// the importing file's sys.path root, computed by walking out of the package
// (see pythonSourceRoot), then against the repo root and src/ — first hit
// wins, and a miss yields no edge.
func (lr *LangResolver) resolvePython(spec, fromDir string) []string {
	if strings.HasPrefix(spec, ".") {
		dots := 0
		for dots < len(spec) && spec[dots] == '.' {
			dots++
		}
		rest := spec[dots:]
		base := fromDir
		// One dot = current package; each further dot climbs one level.
		for i := 1; i < dots; i++ {
			base = path.Dir(base)
			if base == "." || base == "/" {
				base = "."
				break
			}
		}
		target := base
		if rest != "" {
			target = path.Join(base, strings.ReplaceAll(rest, ".", "/"))
		}
		if hit, ok := lr.pyProbe(target); ok {
			return []string{hit}
		}
		return nil
	}

	relPath := strings.ReplaceAll(spec, ".", "/")
	for _, root := range lr.pythonRoots(fromDir) {
		if hit, ok := lr.pyProbe(path.Join(root, relPath)); ok {
			return []string{hit}
		}
	}
	return nil
}

// pythonRoots returns the candidate sys.path roots for a file in fromDir, in
// probe order: the package root first (most specific), then the repo root and
// src/, which cover the two dominant layouts.
func (lr *LangResolver) pythonRoots(fromDir string) []string {
	roots := []string{lr.pythonSourceRoot(fromDir)}
	for _, r := range []string{".", "src"} {
		if r != roots[0] {
			roots = append(roots, r)
		}
	}
	return roots
}

// pythonSourceRoot walks outward from dir while each directory is a package
// (contains __init__.py). The first non-package directory is what CPython
// would have on sys.path, and therefore what absolute imports resolve against.
func (lr *LangResolver) pythonSourceRoot(dir string) string {
	cur := dir
	for cur != "." && cur != "/" && cur != "" {
		if _, isPkg := lr.pyInit[cur]; !isPkg {
			return cur
		}
		cur = path.Dir(cur)
	}
	return "."
}

// pyProbe tries stem.py then stem/__init__.py — the two things a Python module
// name can name on disk.
func (lr *LangResolver) pyProbe(stem string) (string, bool) {
	stem = posixNormalize(stem)
	for _, c := range []string{stem + ".py", path.Join(stem, "__init__.py")} {
		if _, ok := lr.idx.Modules[c]; ok {
			return c, true
		}
	}
	return "", false
}

// ── go ──────────────────────────────────────────────────────────────────────

// resolveGo maps a Go import path to every non-test .go file in the imported
// package. Imports that do not fall under a go.mod found in this repo (the
// standard library, third-party modules) resolve to nothing and become
// external edges.
//
// The one-to-many result is deliberate and is the honest shape: `import
// ".../internal/scan"` is a dependency on that package's whole exported
// surface, which lives across all of its files. It does inflate edge counts
// relative to TS/JS file-to-file imports, which is part of why this path is
// gated behind --experimental-lang-edges.
func (lr *LangResolver) resolveGo(spec string) []string {
	for _, mod := range lr.goModules {
		if mod.Path == "" {
			continue
		}
		var rel string
		switch {
		case spec == mod.Path:
			rel = ""
		case strings.HasPrefix(spec, mod.Path+"/"):
			rel = spec[len(mod.Path)+1:]
		default:
			continue
		}
		dir := posixNormalize(path.Join(mod.Dir, rel))
		if files := lr.goPkgFiles[dir]; len(files) > 0 {
			return append([]string(nil), files...)
		}
		// The import is inside this module but names no package we scanned
		// (generated code, an excluded directory). Do not fall through to a
		// shorter module prefix — that would resolve into the wrong module.
		return nil
	}
	return nil
}

// ── rust ────────────────────────────────────────────────────────────────────

// rustExternalHeads are path roots that can never name an in-repo file.
var rustExternalHeads = map[string]struct{}{
	"std": {}, "core": {}, "alloc": {}, "proc_macro": {}, "test": {},
}

// resolveRust handles `mod foo;` (specifier "foo") and `use` paths
// (specifier "a::b::c").
//
// A use path mixes modules and items — `use crate::config::Settings` names a
// type inside config, not a module called Settings — so resolution tries the
// longest module prefix first and takes the first that names a real file.
// Bare heads are ambiguous between a sibling `mod` and an external crate, so
// they are probed as a sibling first and otherwise treated as external.
func (lr *LangResolver) resolveRust(spec, fromDir string) []string {
	segs := strings.Split(spec, "::")
	if len(segs) == 0 {
		return nil
	}
	head := segs[0]
	if _, ext := rustExternalHeads[head]; ext {
		return nil
	}

	var base string
	rest := segs
	switch head {
	case "crate":
		root, ok := lr.rustCrateRoot(fromDir)
		if !ok {
			return nil
		}
		base, rest = root, segs[1:]
	case "self":
		base, rest = fromDir, segs[1:]
	case "super":
		base, rest = path.Dir(fromDir), segs[1:]
		for len(rest) > 0 && rest[0] == "super" {
			base, rest = path.Dir(base), rest[1:]
		}
	default:
		// Either `mod foo;`/`use foo::…` naming a sibling module, or an
		// external crate. Sibling wins if it exists on disk.
		base, rest = fromDir, segs
	}

	for n := len(rest); n >= 1; n-- {
		stem := path.Join(append([]string{base}, rest[:n]...)...)
		if hit, ok := lr.rsProbe(stem); ok {
			return []string{hit}
		}
	}
	// `use crate::Thing` / `use self::Thing` can name an item in the current
	// module rather than a submodule; that is not an edge to a new file.
	return nil
}

// rustCrateRoot returns the directory that `crate::` is relative to: the
// nearest ancestor holding lib.rs or main.rs.
func (lr *LangResolver) rustCrateRoot(fromDir string) (string, bool) {
	cur := fromDir
	for {
		for _, entry := range []string{"lib.rs", "main.rs"} {
			if _, ok := lr.idx.Modules[posixNormalize(path.Join(cur, entry))]; ok {
				return cur, true
			}
		}
		if cur == "." || cur == "/" || cur == "" {
			return "", false
		}
		cur = path.Dir(cur)
	}
}

// rsProbe tries stem.rs then stem/mod.rs — Rust's two module file layouts.
func (lr *LangResolver) rsProbe(stem string) (string, bool) {
	stem = posixNormalize(stem)
	for _, c := range []string{stem + ".rs", path.Join(stem, "mod.rs")} {
		if _, ok := lr.idx.Modules[c]; ok {
			return c, true
		}
	}
	return "", false
}

// ── edge construction ───────────────────────────────────────────────────────

// LangModuleImports is one non-TS/JS module's imports, tagged with its
// language so the resolver can dispatch.
type LangModuleImports struct {
	Path    string
	Lang    scan.Lang
	Imports []parse.Import
}

// BuildLangEdges builds edges for python/go/rust modules. Input order is
// preserved (callers pass modules in scan order), and each module's imports
// keep their source order, so output is deterministic without sorting.
//
// An unresolved specifier produces an "external" edge exactly as on the TS/JS
// path, so `graph-context` still shows what a module imports even when the
// target is outside the repo. A Go import resolving to N package files
// produces N edges.
func BuildLangEdges(mi []LangModuleImports, lr *LangResolver) []model.Edge {
	edges := make([]model.Edge, 0)
	for _, m := range mi {
		fromDir := path.Dir(m.Path)
		for _, imp := range m.Imports {
			targets := lr.Resolve(m.Lang, imp.Specifier, fromDir)
			if len(targets) == 0 {
				edges = append(edges, model.Edge{
					From:       m.Path,
					To:         imp.Specifier,
					Kind:       model.EdgeKindExternal,
					Confidence: model.ConfidenceExtracted,
					Resolved:   model.Bool(false),
				})
				continue
			}
			for _, t := range targets {
				if t == m.Path {
					continue // a package file importing its own package
				}
				edges = append(edges, model.Edge{
					From:       m.Path,
					To:         t,
					Kind:       model.EdgeKindImport,
					Confidence: model.ConfidenceExtracted,
				})
			}
		}
	}
	return edges
}

// isGoTestFile reports whether rel is a Go test file. Go's convention is the
// `_test.go` suffix, which the shared scan.IsTest (a frozen port of the CJS
// engine's `.test.`/`.spec.` regexes) does not recognise.
func isGoTestFile(rel string) bool {
	return strings.HasSuffix(rel, "_test.go")
}

// ── java ────────────────────────────────────────────────────────────────────

// resolveJava maps a dotted type import to the file declaring it.
//
// Java's package-to-directory convention is rigid, but the source root is not:
// the same type lives at src/main/java/a/b/C.java in one repo and a/b/C.java in
// another. Rather than guessing roots, this matches on path SUFFIX and accepts
// the result only when exactly one module matches — an ambiguous suffix (the
// same class vendored twice, or main/ and test/ copies) yields no edge.
//
// The trailing segments of a specifier are not necessarily package parts:
//
//	import java.util.List        -> a/b/List.java
//	import static a.b.C.member   -> the member is not a file
//	import a.b.Outer.Inner       -> a nested class, also not a file
//
// so segments are dropped from the right until one names a real file.
func (lr *LangResolver) resolveJava(spec string) []string {
	segs := strings.Split(spec, ".")
	for n := len(segs); n >= 1; n-- {
		suffix := strings.Join(segs[:n], "/") + ".java"
		if hit, ok := lr.uniqueSuffixMatch(suffix); ok {
			return []string{hit}
		}
	}
	return nil
}

// uniqueSuffixMatch returns the single module whose path is, or ends with
// "/"+suffix. Zero or multiple matches both return false: ambiguity is
// resolved by emitting nothing rather than picking arbitrarily.
func (lr *LangResolver) uniqueSuffixMatch(suffix string) (string, bool) {
	var hit string
	n := 0
	for m := range lr.idx.Modules {
		if m == suffix || strings.HasSuffix(m, "/"+suffix) {
			n++
			if n > 1 {
				return "", false
			}
			hit = m
		}
	}
	return hit, n == 1
}

// ── ruby ────────────────────────────────────────────────────────────────────

// resolveRuby handles both require forms, which the parse layer reports
// identically (kind "require"), distinguished here by shape:
//
//	require_relative "./lib/foo" / "../x"  -> resolved against the file's dir
//	require "json"                         -> a load-path lookup
//
// A require_relative specifier need not start with "." (`require_relative
// "foo"` is legal and means a sibling), so a bare specifier is tried as a
// sibling first, then against the conventional lib/ root and the repo root.
//
// Worth knowing when reading a Rails graph: Zeitwerk autoloads constants, so
// idiomatic Rails code barely calls require at all. Sparse Ruby edges there
// are correct, not a extraction failure.
func (lr *LangResolver) resolveRuby(spec, fromDir string) []string {
	if strings.HasPrefix(spec, ".") {
		if hit, ok := lr.rbProbe(path.Join(fromDir, spec)); ok {
			return []string{hit}
		}
		return nil
	}
	for _, cand := range []string{
		path.Join(fromDir, spec), // require_relative "sibling"
		path.Join("lib", spec),   // gem convention
		spec,                     // repo-root relative
	} {
		if hit, ok := lr.rbProbe(cand); ok {
			return []string{hit}
		}
	}
	return nil
}

// rbProbe accepts an explicit .rb path or appends the extension.
func (lr *LangResolver) rbProbe(stem string) (string, bool) {
	stem = posixNormalize(stem)
	cands := []string{stem}
	if !strings.HasSuffix(stem, ".rb") {
		cands = []string{stem + ".rb", stem}
	}
	for _, c := range cands {
		if _, ok := lr.idx.Modules[c]; ok {
			return c, true
		}
	}
	return "", false
}

// ── shell ───────────────────────────────────────────────────────────────────

// resolveShell resolves `source X` / `. X` against the sourcing script's
// directory.
//
// This is an approximation: POSIX resolves a relative source path against the
// runtime $PWD, not the script's location. Script-relative is the dominant
// convention and the only one statically knowable, and the query already
// refuses any path containing an expansion, so what is emitted is either right
// or absent. Absolute paths are treated as external — they point outside the
// repo by construction.
func (lr *LangResolver) resolveShell(spec, fromDir string) []string {
	if spec == "" || strings.HasPrefix(spec, "/") {
		return nil
	}
	for _, cand := range []string{path.Join(fromDir, spec), spec} {
		if _, ok := lr.idx.Modules[posixNormalize(cand)]; ok {
			return []string{posixNormalize(cand)}
		}
	}
	return nil
}
