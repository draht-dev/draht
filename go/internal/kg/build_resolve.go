package kg

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Module resolution of buildGraph: workspace packages (js/ts monorepos),
// Python import roots, and the exported names of a module.

// jsonObject is a JSON object with its keys in document order
// (Object.keys / Object.values / Object.entries order).
type jsonObject struct {
	keys []string
	vals map[string]any
}

func (o *jsonObject) get(k string) (any, bool) {
	v, ok := o.vals[k]
	return v, ok
}

// parseOrderedJSON is JSON.parse, with objects as *jsonObject, arrays as
// []any, strings as string and every other scalar as json.Token values.
func parseOrderedJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := decodeOrdered(dec)
	if err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, os.ErrInvalid
	}
	if _, err := dec.Token(); err == nil {
		return nil, os.ErrInvalid // trailing content
	}
	return v, nil
}

func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); ok {
		switch d {
		case '{':
			obj := &jsonObject{vals: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := obj.vals[key]; !dup {
					obj.keys = append(obj.keys, key)
				}
				obj.vals[key] = v
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	}
	return tok, nil
}

// jsTruthy is JavaScript truthiness of a parsed JSON value.
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	}
	return true
}

// exportTargets: every target string of a package.json `exports` value
// (string, conditions object or fallback array), in declaration order.
func exportTargets(v any, out []string) []string {
	switch x := v.(type) {
	case string:
		out = append(out, x)
	case []any:
		for _, k := range x {
			out = exportTargets(k, out)
		}
	case *jsonObject:
		for _, k := range x.keys {
			out = exportTargets(x.vals[k], out)
		}
	}
	return out
}

// Targets of a package's root export ("." entry), in declaration order. Only
// the conditions a Node/TypeScript consumer of the package can take are read:
// others (`browser`, `bun`, `development`, …) may point at a different entry.
var rootExportConditions = strSet("source", "types", "import", "module", "node", "require", "default")

func rootExportTargets(v any, out []string) []string {
	switch x := v.(type) {
	case string:
		out = append(out, x)
	case []any:
		for _, k := range x {
			out = rootExportTargets(k, out)
		}
	case *jsonObject:
		for _, k := range x.keys {
			if rootExportConditions[k] {
				out = rootExportTargets(x.vals[k], out)
			}
		}
	}
	return out
}

// subpathExports: a package's `exports` as a subpath map ("." and "./sub"
// keys); nil when the field is absent. A string or a bare conditions object
// exports the root alone.
func subpathExports(exports any, present bool) *jsonObject {
	if !present || exports == nil {
		return nil
	}
	if obj, ok := exports.(*jsonObject); ok {
		for _, k := range obj.keys {
			if strings.HasPrefix(k, ".") {
				return obj
			}
		}
	}
	return &jsonObject{keys: []string{"."}, vals: map[string]any{".": exports}}
}

var (
	reDistPrefix = mustRE(`^(\.\/)?dist\/`, "")
	reDtsSuffix  = mustRE(`\.d\.[mc]?ts$`, "")
	reJsExt      = mustRE(`\.(js|mjs|cjs|jsx)$`, "")
	reDotExt     = mustRE(`\.[^.]+$`, "")
	rePyModPath  = mustRE(`^[\w.]*$`, "")
)

// distToSrc: the source path a build output was compiled from (`./dist/x.js`
// or `./dist/x.d.ts` → `./src/x`): `dist/` is never walked, so an export that
// points only at build output is found through its source.
func distToSrc(target string) string {
	s := target
	if m := reDistPrefix.FindS(s); m != nil {
		s = m.S(1) + "src/" + s[len(m.S(0)):]
	}
	return reDtsSuffix.ReplaceFirstLit(s, "")
}

// nodeNormalize is Node's path.posix.normalize: like path.Clean, but a
// trailing slash survives.
func nodeNormalize(p string) string {
	if p == "" {
		return "."
	}
	c := path.Clean(p)
	if strings.HasSuffix(p, "/") && c != "/" {
		return c + "/"
	}
	return c
}

// nodeJoin is Node's path.posix.join.
func nodeJoin(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		return "."
	}
	return nodeNormalize(strings.Join(kept, "/"))
}

type workspacePackage struct {
	dir     string
	exports *jsonObject // subpath map, nil without an `exports` field
}

// resolver is the resolution state the closures of buildGraph share.
type resolver struct {
	rels           []string
	relSet         map[string]bool
	workspaceEntry *OMap[string, string]
	workspacePkg   *OMap[string, *workspacePackage]
	pyRoots        []string
	specMemo       map[string]*string // key -> resolved rel (nil pointer target = null)

	reExportsOf       map[string][]reExport
	exportMaps        map[string]*OMap[string, string]
	exportsInProgress *OMap[string, int] // rel -> depth on the resolution stack
	cutDepth          int                // shallowest in-progress module a cycle cut pointed at
	pyExported        map[string]*string
}

type reExport struct {
	target string
	star   bool
	names  []ImportName
}

var noExports = newOMap[string, string]()

func (b *builder) initResolver() {
	r := &resolver{
		rels:              b.perFile.Keys(),
		relSet:            map[string]bool{},
		workspaceEntry:    newOMap[string, string](),
		workspacePkg:      newOMap[string, *workspacePackage](),
		specMemo:          map[string]*string{},
		reExportsOf:       map[string][]reExport{},
		exportMaps:        map[string]*OMap[string, string]{},
		exportsInProgress: newOMap[string, int](),
		cutDepth:          math.MaxInt,
		pyExported:        map[string]*string{},
	}
	b.res = r
	for _, rel := range r.rels {
		r.relSet[rel] = true
	}

	// -- workspace package resolution (js/ts monorepos): each package's root
	// entry, plus its directory and `exports` map for subpath imports
	pkgDirs := newOSet("")
	for _, rel := range r.rels {
		parts := strings.Split(rel, "/")
		for i := 1; i < len(parts); i++ {
			pkgDirs.Add(strings.Join(parts[:i], "/"))
		}
	}
	dirs := pkgDirs.Items()
	sort.Strings(dirs)
	for _, dir := range dirs {
		raw, err := os.ReadFile(filepath.Join(b.root, filepath.FromSlash(dir), "package.json"))
		if err != nil {
			continue
		}
		parsed, err := parseOrderedJSON(raw)
		if err != nil {
			continue
		}
		pj, ok := parsed.(*jsonObject)
		if !ok {
			continue
		}
		nameVal, _ := pj.get("name")
		if !jsTruthy(nameVal) {
			continue
		}
		name, isStr := nameVal.(string)
		if !isStr {
			continue
		}
		exportsVal, hasExports := pj.get("exports")
		exportMap := subpathExports(exportsVal, hasExports)
		if !r.workspacePkg.Has(name) {
			r.workspacePkg.Set(name, &workspacePackage{dir: dir, exports: exportMap})
		}
		if r.workspaceEntry.Has(name) {
			continue
		}
		// The root import comes from `exports["."]` alone — another subpath's
		// target (`./extension`) is not the package's entry — then the legacy
		// fields, then a conventional index. Build output (`dist/`) is mapped
		// back to the source it was compiled from (probeTarget).
		var rootTargets []string
		if exportMap != nil {
			if dot, ok := exportMap.get("."); ok {
				rootTargets = rootExportTargets(dot, rootTargets)
			}
		}
		for _, f := range []string{"module", "main", "types", "typings"} {
			if v, ok := pj.get(f); ok {
				if s, ok := v.(string); ok {
					rootTargets = append(rootTargets, s)
				}
			}
		}
		rootTargets = append(rootTargets, "src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js")
		for _, t := range rootTargets {
			if hit := b.probeTarget(dir, strings.TrimPrefix(t, "./")); hit != "" {
				r.workspaceEntry.Set(name, hit)
				break
			}
		}
	}

	// Import roots: the repo root and every directory that holds a top-level
	// package (a `src/` layout, an example project). The importing file's own
	// root is tried first.
	roots := newOSet("")
	for _, rel := range r.rels {
		if strings.HasSuffix(rel, ".py") {
			roots.Add(b.pyOwnRoot(rel))
		}
	}
	r.pyRoots = roots.Items()
	sort.Strings(r.pyRoots)
}

var (
	probeAnyExts   = []string{"", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs"}
	probeIndexExts = []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
)

// probeModule: the file a module path names: as written, with a `.js`-family
// extension swapped for a source one, or a directory's index. "" for none.
func (b *builder) probeModule(base string) string {
	stems := []string{base}
	if reJsExt.TestS(base) {
		stems = append(stems, reJsExt.ReplaceFirstLit(base, ""))
	}
	for _, stem := range stems {
		for _, e := range probeAnyExts {
			if b.res.relSet[stem+e] {
				return stem + e
			}
		}
		for _, e := range probeIndexExts {
			if idx := nodeJoin(stem, "index"+e); b.res.relSet[idx] {
				return idx
			}
		}
	}
	return ""
}

func (b *builder) probeTarget(dir, target string) string {
	if hit := b.probeModule(nodeNormalize(nodeJoin(dir, target))); hit != "" {
		return hit
	}
	source := distToSrc(target)
	if source != target {
		return b.probeModule(nodeNormalize(nodeJoin(dir, source)))
	}
	return ""
}

// resolveWorkspaceSubpath: a workspace subpath import (`@scope/pkg/testing`)
// resolves through the package's `exports`: the exact key, else the `*`
// pattern with the longest prefix (Node's rule), its targets tried in
// condition order. Never the package root — the root does not export the
// subpath's names, so its symbol imports and calls would be lost. A subpath
// the map does not export is unresolved (Node refuses it); without an
// `exports` field the subpath is a path inside the package.
func (b *builder) resolveWorkspaceSubpath(pkg *workspacePackage, sub string) string {
	if pkg.exports == nil {
		return b.probeTarget(pkg.dir, sub)
	}
	key, hasKey := "", false
	if _, ok := pkg.exports.get(sub); ok {
		key, hasKey = sub, true
	}
	star, hasStar := "", false
	if !hasKey {
		prefixLen := -1
		for _, k := range pkg.exports.keys {
			at := strings.Index(k, "*")
			if at < 0 || at < prefixLen || (at == prefixLen && len(k) <= len(key)) {
				continue
			}
			prefix := k[:at]
			suffix := k[at+1:]
			if len(sub) < len(k) || !strings.HasPrefix(sub, prefix) || !strings.HasSuffix(sub, suffix) {
				continue
			}
			key, hasKey = k, true
			prefixLen = at
			star, hasStar = sub[len(prefix):len(sub)-len(suffix)], true
		}
		if !hasKey {
			return ""
		}
	}
	v, _ := pkg.exports.get(key)
	for _, target := range exportTargets(v, nil) {
		t := target
		if hasStar {
			t = strings.Join(strings.Split(target, "*"), star)
		}
		if hit := b.probeTarget(pkg.dir, t); hit != "" {
			return hit
		}
	}
	return ""
}

// probePyModule: Python module path → file: `pkg/__init__.py` (a package wins
// over a same-named module, as in the import system) or `pkg/mod.py`.
func (b *builder) probePyModule(base string) string {
	for _, c := range []string{nodeJoin(base, "__init__.py"), base + ".py"} {
		if b.res.relSet[c] {
			return c
		}
	}
	return ""
}

// pyOwnRoot: the directory above the outermost package that holds `rel`.
func (b *builder) pyOwnRoot(rel string) string {
	d := path.Dir(rel)
	for d != "." && b.res.relSet[d+"/__init__.py"] {
		d = path.Dir(d)
	}
	if d == "." {
		return ""
	}
	return d
}

func (b *builder) probePyAbsolute(fromRel, mod string) string {
	// the file's own root, then each directory above it (a namespace package
	// has no __init__.py to mark where it starts), then the other roots
	own := b.pyOwnRoot(fromRel)
	order := newOSet(own)
	d := "."
	if own != "" {
		d = path.Dir(own)
	}
	for ; d != "." && d != "/"; d = path.Dir(d) {
		order.Add(d)
	}
	for _, r := range b.res.pyRoots {
		order.Add(r)
	}
	for _, r := range order.Items() {
		base := mod
		if r != "" {
			base = r + "/" + mod
		}
		if hit := b.probePyModule(base); hit != "" {
			return hit
		}
	}
	return ""
}

// resolvePySpec: dots count package levels from the importing file's own
// package: `.` is its directory, `..` the parent. Absolute dotted paths start
// at the repo root.
func (b *builder) resolvePySpec(fromRel, spec string) string {
	dots := 0
	for dots < len(spec) && spec[dots] == '.' {
		dots++
	}
	rest := spec[dots:]
	if !rePyModPath.TestS(rest) {
		return ""
	}
	mod := strings.ReplaceAll(rest, ".", "/")
	if dots == 0 {
		if mod != "" {
			return b.probePyAbsolute(fromRel, mod)
		}
		return ""
	}
	dir := path.Dir(fromRel)
	for k := 1; k < dots; k++ {
		dir = path.Dir(dir)
	}
	if mod != "" {
		return b.probePyModule(nodeJoin(dir, mod))
	}
	init := nodeJoin(dir, "__init__.py") // `from . import x`: the package itself
	if b.res.relSet[init] {
		return init
	}
	return ""
}

func (b *builder) resolveSpecUncached(fromRel, spec string) string {
	r := b.res
	if b.perFile.G(fromRel).Lang == "python" {
		return b.resolvePySpec(fromRel, spec)
	}
	if strings.HasPrefix(spec, ".") {
		return b.probeModule(nodeNormalize(nodeJoin(path.Dir(fromRel), spec)))
	}
	if entry, ok := r.workspaceEntry.Get(spec); ok {
		return entry
	}
	from := 0
	if strings.HasPrefix(spec, "@") {
		from = strings.Index(spec, "/") + 1
	}
	slash := -1
	if from <= len(spec) {
		if i := strings.Index(spec[from:], "/"); i >= 0 {
			slash = from + i
		}
	}
	if slash > 0 {
		if pkg, ok := r.workspacePkg.Get(spec[:slash]); ok {
			return b.resolveWorkspaceSubpath(pkg, "."+spec[slash:])
		}
	}
	return ""
}

// resolveSpec is the repo file an import specifier names, "" for none.
func (b *builder) resolveSpec(fromRel, spec string) string {
	key := fromRel + "\n" + spec
	if hit, ok := b.res.specMemo[key]; ok {
		return *hit
	}
	v := b.resolveSpecUncached(fromRel, spec)
	b.res.specMemo[key] = &v
	return v
}

// A module's exported names → defining symbol node, following re-export
// bindings: named (`export { helper } from`, aliases, `default as X`) and
// star (`export * from`, which never carries `default`). `export * as ns`
// exposes only `ns`, no inner name. A barrel has no localDef for
// pass-through names, so consumers importing through it would otherwise
// lose their symbol-import and call edges. Built once per module (a
// 1500-entry barrel costs one pass, not one per importer), with a cycle
// guard: a map computed while a cycle cut part of it away is incomplete
// for every module on that cycle except the one the cut points at, so only
// the latter is kept.
func (b *builder) reExportList(rel string) []reExport {
	if list, ok := b.res.reExportsOf[rel]; ok {
		return list
	}
	list := []reExport{}
	for _, imp := range b.perFile.G(rel).Decls.Imports {
		if !imp.ReExport {
			continue
		}
		if target := b.resolveSpec(rel, imp.Spec); target != "" {
			list = append(list, reExport{target: target, star: imp.Namespace == "*", names: imp.Names})
		}
	}
	b.res.reExportsOf[rel] = list
	return list
}

func (b *builder) exportsOf(rel string) *OMap[string, string] {
	r := b.res
	if done, ok := r.exportMaps[rel]; ok {
		return done
	}
	pf, ok := b.perFile.Get(rel)
	if !ok {
		return noExports
	}
	if depth, inProgress := r.exportsInProgress.Get(rel); inProgress {
		if depth < r.cutDepth {
			r.cutDepth = depth
		}
		return noExports
	}
	myDepth := r.exportsInProgress.Len()
	r.exportsInProgress.Set(rel, myDepth)
	outerCut := r.cutDepth
	r.cutDepth = math.MaxInt
	m := pf.LocalDefs.Clone()
	if pf.DefaultNid != "" {
		m.Set("default", pf.DefaultNid)
	}
	// `export { a as b }`: a local declaration, or a name this module imported
	for _, le := range pf.Decls.LocalExports {
		if m.Has(le.Exported) && le.Exported == le.Local {
			continue
		}
		nid := pf.LocalDefs.G(le.Local)
		if nid == "" {
			for _, imp := range pf.Decls.Imports {
				if imp.ReExport || imp.Dynamic {
					continue
				}
				target := b.resolveSpec(rel, imp.Spec)
				if target == "" {
					continue
				}
				if imp.Default == le.Local {
					nid = b.perFile.G(target).DefaultNid
					if nid == "" {
						nid = b.exportsOf(target).G("default")
					}
				}
				for _, x := range imp.Names {
					if x.Local == le.Local {
						nid = b.exportsOf(target).G(x.Imported)
						break
					}
				}
				if nid != "" {
					break
				}
			}
		}
		if nid != "" {
			m.Set(le.Exported, nid)
		}
	}
	for _, re := range b.reExportList(rel) {
		target := b.exportsOf(re.target)
		if re.star {
			for name, nid := range target.All() {
				if name != "default" && !m.Has(name) {
					m.Set(name, nid)
				}
			}
		} else {
			for _, n := range re.names {
				if m.Has(n.Local) {
					continue
				}
				if nid := target.G(n.Imported); nid != "" {
					m.Set(n.Local, nid)
				}
			}
		}
	}
	r.exportsInProgress.Delete(rel)
	if r.cutDepth >= myDepth {
		r.exportMaps[rel] = m
		r.cutDepth = outerCut
	} else if outerCut < r.cutDepth {
		r.cutDepth = outerCut
	}
	return m
}

// resolvePyExported: a Python module exports every name it imports, and
// Python packages import each other in cycles as a matter of course, so a
// name is followed on its own (memoized per module and name) instead of
// through whole export maps: local declaration, else the import that binds
// it, else a star import.
func (b *builder) resolvePyExported(rel, name string, depth int) string {
	key := rel + "\n" + name
	if hit, ok := b.res.pyExported[key]; ok {
		return *hit
	}
	pf, ok := b.perFile.Get(rel)
	if !ok || depth > 12 {
		return ""
	}
	empty := ""
	b.res.pyExported[key] = &empty // cycle guard
	nid := pf.LocalDefs.G(name)
	if nid == "" {
		for _, imp := range pf.Decls.Imports {
			bound, found := "", false
			for _, x := range imp.Names {
				if x.Local == name {
					bound, found = x.Imported, true
					break
				}
			}
			if !found {
				continue
			}
			if target := b.resolveSpec(rel, imp.Spec); target != "" {
				nid = b.resolvePyExported(target, bound, depth+1)
			}
			if nid != "" {
				break
			}
		}
	}
	if nid == "" {
		for _, imp := range pf.Decls.Imports {
			star := false
			for _, x := range imp.Names {
				if x.Imported == "*" {
					star = true
					break
				}
			}
			if !star {
				continue
			}
			if target := b.resolveSpec(rel, imp.Spec); target != "" {
				nid = b.resolvePyExported(target, name, depth+1)
			}
			if nid != "" {
				break
			}
		}
	}
	b.res.pyExported[key] = &nid
	return nid
}

func (b *builder) resolveExported(rel, name string) string {
	if pf, ok := b.perFile.Get(rel); ok && pf.Lang == "python" {
		return b.resolvePyExported(rel, name, 0)
	}
	return b.exportsOf(rel).G(name)
}

// defaultOf: the symbol a module's default import binds to: its own default
// declaration, else what it re-exports as `default`.
func (b *builder) defaultOf(rel string) string {
	pf, ok := b.perFile.Get(rel)
	if !ok {
		return ""
	}
	if pf.DefaultNid != "" {
		return pf.DefaultNid
	}
	return b.resolveExported(rel, "default")
}

type lineRegion struct {
	start int
	end   int
}

// pyDefRegion: the def (function or method) whose body holds 1-based `line`,
// innermost.
func pyDefRegion(pf *fileInfo, line int) *lineRegion {
	var best *lineRegion
	consider := func(f *Func) {
		if f.Line < line && f.End != 0 && line <= f.End && (best == nil || f.Line > best.start) {
			best = &lineRegion{start: f.Line, end: f.End}
		}
	}
	for _, f := range pf.Decls.Functions {
		consider(f)
	}
	for _, c := range pf.Decls.Classes {
		for _, m := range c.Methods {
			consider(m)
		}
	}
	return best
}

// importedAt: what `name` was imported as, seen from `line`: a def's own
// imports first. line 0 means "no line".
func importedAt(pf *fileInfo, name string, line int) *importedName {
	if line != 0 && len(pf.ScopedImports) > 0 {
		var hit *importedName
		hitStart := -1
		for _, sc := range pf.ScopedImports {
			if line >= sc.Start && line <= sc.End && sc.Start >= hitStart && sc.Map.Has(name) {
				hit = sc.Map.G(name)
				hitStart = sc.Start
			}
		}
		if hit != nil {
			return hit
		}
	}
	return pf.ImportedNames.G(name)
}
