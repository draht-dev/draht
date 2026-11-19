package kg

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/jsutil"
)

// The Go-language part of buildGraph (draht-kg.cjs, "-- Go: package scopes"
// up to "Embedded types"). The closures of the original are methods on
// *builder; the variables they share live in goBuild (b.goState).

// goModule is one go.mod: the module path and the repo directory it sits in
// ("" for the repo root).
type goModule struct {
	dir  string
	path string
}

// goTyped is `{ type, rel }`: a type expression and the file it is written in.
// Type is "" for the original's null.
type goTyped struct {
	Type string
	Rel  string
}

// goCur is what a selector chain has reached so far:
// { kind: "pkg", scope } | { kind: "fn", entry } | { kind: "value", type, rel, t? }
// | { kind: "typename", t } | goExternal.
type goCur struct {
	kind  string
	scope *GoScope
	entry *GoEntry
	typ   string
	rel   string
	t     *GoTypeEntry
}

// goEnv is the variable types of one function (never iterated).
type goEnv map[string]*goTyped

// goBuild is the state the Go closures of buildGraph share.
type goBuild struct {
	goScopes        *OMap[string, *GoScope]
	goMethodsByName *OMap[string, []*GoEntry] // repo-wide: method name -> entries
	goModules       []goModule
	goDirScope      *OMap[string, *GoScope]
	goVarTypes      map[*GoVar]*goTyped // presence matters: nil is the cycle guard
	importRes       map[string]*RE      // goImportEdges' regex per local package name
}

var goExternal = &goCur{kind: "external"}

var (
	reGoBModule      = mustRE(`^module\s+(\S+)`, "m")
	reGoBVersionSeg  = mustRE(`^v\d+$`, "")
	reGoBDotVersion  = mustRE(`\.v\d+$`, "")
	reGoBDashPrefix  = mustRE(`^go-`, "")
	reGoBNonWord     = mustRE(`[^\w]`, "g")
	reGoBIdent       = mustRE(`[A-Za-z_]\w*`, "y")
	reGoBInitDeref   = mustRE(`^[&*]\s*`, "")
	reGoBInitLiteral = mustRE(`^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{`, "")
	reGoBInitNew     = mustRE(`^new\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\)`, "")
	reGoBIdentStart  = mustRE(`^[A-Za-z_]`, "")
	reGoBInitTail    = mustRE(`^\s*(?:$|[,;{)])`, "")
	reGoBClosure     = mustRE(`\bfunc\s*\(([^)]*)\)`, "g")
	reGoBVarLine     = mustRE(`\bvar\s+([A-Za-z_]\w*)\s+([^=\n]+?)\s*(?:=|$)`, "")
	reGoBRangeLine   = mustRE(`\bfor\s+(\w+)\s*(?:,\s*([A-Za-z_]\w*)\s*)?:=\s*range\s+(\S.*)$`, "")
	reGoBDefineLine  = mustRE(`\b([A-Za-z_]\w*)\s*((?:,\s*[A-Za-z_]\w*\s*)*):=\s*(\S.*)$`, "")
	reGoBHead        = mustRE(`(?<![\w.)\]}])[A-Za-z_]\w*`, "g")
	reGoBArg         = mustRE(`[(,]\s*([A-Za-z_]\w*)\s*(?=[,)])`, "g")
)

// goSlice is `t.slice(a, b)` where b may be negative (an offset from the end),
// as a body whose closing brace was not found has bodyEnd -1.
func goSlice(t []rune, a, b int) []rune {
	if a < 0 {
		a += len(t)
	}
	if b < 0 {
		b += len(t)
	}
	return sub(t, a, b)
}

// goPosixJoin is `path.posix.join(...parts)`: empty parts dropped, the result
// normalized, a trailing slash kept.
func goPosixJoin(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	joined := strings.Join(kept, "/")
	if joined == "" {
		return "."
	}
	out := path.Clean(joined)
	if strings.HasSuffix(joined, "/") && out != "/" {
		out += "/"
	}
	return out
}

func (b *builder) goScopeOf(dir, name string) *GoScope {
	g := b.goState
	k := dir + "\n" + name
	s := g.goScopes.G(k)
	if s == nil {
		s = &GoScope{
			Dir: dir, Name: name,
			Funcs:   newOMap[string, *GoEntry](),
			Types:   newOMap[string, *GoTypeEntry](),
			Values:  newOMap[string, *GoValueEntry](),
			Vars:    newOMap[string, *GoVar](),
			Methods: newOMap[string, *OMap[string, *GoEntry]](),
		}
		g.goScopes.Set(k, s)
	}
	return s
}

// buildGo runs the unconditional Go part of buildGraph: package scopes, method
// nodes and edges, module paths, per-file imports, embedded types.
func (b *builder) buildGo() {
	g := &goBuild{
		goScopes:        newOMap[string, *GoScope](),
		goMethodsByName: newOMap[string, []*GoEntry](),
		goDirScope:      newOMap[string, *GoScope](),
		goVarTypes:      map[*GoVar]*goTyped{},
		importRes:       map[string]*RE{},
	}
	b.goState = g

	// -- Go: package scopes. A package is every file of one directory with one
	// package clause; functions, types and values are visible across its files,
	// and a method joins its receiver type from whichever file declares it.
	for rel, pf := range b.perFile.All() {
		if pf.Lang != "go" {
			continue
		}
		d := pf.Decls
		scope := b.goScopeOf(path.Dir(rel), d.GoPackage)
		pf.GoScope = scope
		scope.Files = append(scope.Files, rel)
		for _, f := range d.Functions {
			if !scope.Funcs.Has(f.Name) {
				scope.Funcs.Set(f.Name, &GoEntry{Nid: pf.LocalDefs.G(f.Name), Fn: f, Rel: rel})
			}
		}
		for _, c := range d.Classes {
			if !scope.Types.Has(c.Name) {
				scope.Types.Set(c.Name, &GoTypeEntry{Nid: pf.LocalDefs.G(c.Name), Cls: c, Rel: rel, Scope: scope})
			}
		}
		for _, t := range d.Types {
			if !scope.Values.Has(t.Name) {
				scope.Values.Set(t.Name, &GoValueEntry{Nid: pf.LocalDefs.G(t.Name), Rel: rel})
			}
		}
		for name, v := range d.GoVars.All() {
			if !scope.Vars.Has(name) {
				scope.Vars.Set(name, &GoVar{Type: v.Type, Init: v.Init, Rel: rel})
			}
		}
	}
	for rel, pf := range b.perFile.All() {
		if pf.Lang != "go" {
			continue
		}
		byType := newOMap[string, []*Func]()
		for _, m := range pf.Decls.GoMethods {
			byType.Set(m.RecvType, append(byType.G(m.RecvType), m))
		}
		for typeName, ms := range byType.All() {
			ids := methodNodeIDs(rel, typeName, ms, "go")
			owner := pf.GoScope.Types.G(typeName)
			table := pf.GoScope.Methods.G(typeName)
			if table == nil {
				table = newOMap[string, *GoEntry]()
				pf.GoScope.Methods.Set(typeName, table)
			}
			for _, m := range ms {
				m.Nid = ids.G(m.Name)
				n := codeNode(m.Nid, m.Name+"()", rel, m.Line)
				n.Callable = true
				b.addNode(n)
				if owner != nil {
					b.addEdge(owner.Nid, m.Nid, "method", edgeOpts{File: rel, Line: m.Line})
				} else {
					b.addEdge(pf.FileNid, m.Nid, "defines", edgeOpts{File: rel, Line: m.Line})
				}
				entry := &GoEntry{Nid: m.Nid, Fn: m, Rel: rel}
				if !table.Has(m.Name) {
					table.Set(m.Name, entry)
				}
				g.goMethodsByName.Set(m.Name, append(g.goMethodsByName.G(m.Name), entry))
			}
		}
	}
	// Module paths (go.mod) map an import path to a repo directory; the package a
	// directory exports is its non-test one.
	if g.goScopes.Len() > 0 {
		dirs := newOSet[string]()
		for _, s := range g.goScopes.All() {
			var parts []string
			if s.Dir != "." {
				parts = splitStr(s.Dir, "/")
			}
			for i := 0; i <= len(parts); i++ {
				dirs.Add(strings.Join(parts[:i], "/"))
			}
			if strings.HasSuffix(s.Name, "_test") {
				continue
			}
			cur := g.goDirScope.G(s.Dir)
			if cur == nil || len(s.Files) > len(cur.Files) {
				g.goDirScope.Set(s.Dir, s)
			}
		}
		sorted := dirs.Items()
		sort.Strings(sorted)
		for _, dir := range sorted {
			data, err := os.ReadFile(filepath.Join(b.root, filepath.FromSlash(dir), "go.mod"))
			if err != nil {
				continue // no go.mod here
			}
			if mod := reGoBModule.FindS(string(data)); mod != nil {
				g.goModules = append(g.goModules, goModule{dir: dir, path: mod.S(1)})
			}
		}
		mods := g.goModules
		sort.SliceStable(mods, func(i, j int) bool {
			li, lj := jsutil.LenUTF16(mods[i].path), jsutil.LenUTF16(mods[j].path)
			if li != lj {
				return li > lj
			}
			return lessStr(mods[i].dir, mods[j].dir)
		})
	}
	for _, pf := range b.perFile.All() {
		if pf.Lang != "go" {
			continue
		}
		pf.GoImports = newOMap[string, *GoScope]() // local name -> package scope, or nil for a package outside the repo
		pf.GoDot = nil
		for _, imp := range pf.Decls.Imports {
			imp.GoScope = b.resolveGoImport(imp.Spec)
			if imp.GoAlias == "_" {
				continue
			}
			if imp.GoAlias == "." {
				if imp.GoScope != nil {
					pf.GoDot = append(pf.GoDot, imp.GoScope)
				}
				continue
			}
			segs := splitStr(imp.Spec, "/")
			base := segs[len(segs)-1]
			if reGoBVersionSeg.TestS(base) && len(segs) > 1 {
				base = segs[len(segs)-2]
			}
			switch {
			case imp.GoAlias != "":
				imp.GoLocal = imp.GoAlias
			case imp.GoScope != nil:
				imp.GoLocal = imp.GoScope.Name
			default:
				imp.GoLocal = reGoBDashPrefix.ReplaceFirstLit(reGoBDotVersion.ReplaceFirstLit(base, ""), "")
			}
			pf.GoImports.Set(imp.GoLocal, imp.GoScope)
		}
	}

	// Embedded types (struct in struct, interface in interface).
	for _, scope := range g.goScopes.All() {
		for _, t := range scope.Types.All() {
			for _, e := range t.Cls.Embeds {
				target := b.goTypeRef(e, t.Rel)
				if target != nil && target.Nid != t.Nid {
					b.addEdge(t.Nid, target.Nid, "embeds", edgeOpts{File: t.Rel, Line: t.Cls.Line})
				}
			}
		}
	}
}

func (b *builder) resolveGoImport(spec string) *GoScope {
	g := b.goState
	for _, m := range g.goModules {
		if spec != m.path && !strings.HasPrefix(spec, m.path+"/") {
			continue
		}
		rest := ""
		if len(spec) > len(m.path)+1 {
			rest = spec[len(m.path)+1:]
		}
		dir := m.dir
		if dir == "" {
			dir = "."
		}
		return g.goDirScope.G(goPosixJoin(dir, rest))
	}
	return nil
}

// An in-repo import depends on the files that declare what the importer
// names through it (`pkg.Symbol`), not on the whole package; a package used
// for nothing nameable (blank import) falls back to its entry file.
func (b *builder) goImportEdges(rel string, pf *fileInfo, imp *Import) bool {
	scope := imp.GoScope
	if scope == nil {
		return false
	}
	targets := newOSet[string]()
	if imp.GoLocal != "" {
		re := b.goState.importRes[imp.GoLocal]
		if re == nil {
			escaped := reGoBNonWord.ReplaceS(imp.GoLocal, func(m *Match) string { return `\` + m.S(0) })
			re = mustRE(`(?<![\w.])`+escaped+`\s*\.\s*([A-Za-z_]\w*)`, "g")
			b.goState.importRes[imp.GoLocal] = re
		}
		seen := map[string]bool{}
		for m := range re.Iter(pf.Decls.Masked, 0) {
			name := m.S(1)
			if seen[name] {
				continue
			}
			seen[name] = true
			// scope.funcs.get(name) || scope.types.get(name) || scope.values.get(name)
			var nid, erel string
			if f := scope.Funcs.G(name); f != nil {
				nid, erel = f.Nid, f.Rel
			} else if t := scope.Types.G(name); t != nil {
				nid, erel = t.Nid, t.Rel
			} else if v := scope.Values.G(name); v != nil {
				nid, erel = v.Nid, v.Rel
			} else {
				continue
			}
			if nid == "" {
				continue
			}
			targets.Add(erel)
			b.addEdge(pf.FileNid, nid, "imports", edgeOpts{File: rel, Line: imp.Line, Context: "import"})
		}
	}
	if targets.Len() == 0 {
		var own []string
		for _, f := range scope.Files {
			if !strings.HasSuffix(f, "_test.go") {
				own = append(own, f)
			}
		}
		sort.Strings(own)
		find := func(base string) string {
			for _, f := range own {
				if path.Base(f) == base {
					return f
				}
			}
			return ""
		}
		entry := find(scope.Name + ".go")
		if entry == "" {
			entry = find("doc.go")
		}
		if entry == "" && len(own) > 0 {
			entry = own[0]
		}
		if entry == "" && len(scope.Files) > 0 {
			entry = scope.Files[0]
		}
		if entry != "" {
			targets.Add(entry)
		}
	}
	sorted := targets.Items()
	sort.Strings(sorted)
	for _, t := range sorted {
		b.addEdge(pf.FileNid, b.perFile.G(t).FileNid, "imports_from", edgeOpts{File: rel, Line: imp.Line, Context: "import"})
	}
	return true
}

// Type expression (as written in `ctxRel`) → the repo type it names, or nil.
func (b *builder) goTypeRef(typeStr, ctxRel string) *GoTypeEntry {
	if typeStr == "" {
		return nil
	}
	name := strings.TrimPrefix(typeStr, "[]")
	pf := b.perFile.G(ctxRel)
	dot := strings.Index(name, ".")
	if dot < 0 {
		return pf.GoScope.Types.G(name)
	}
	scope := pf.GoImports.G(name[:dot])
	if scope == nil {
		return nil
	}
	return scope.Types.G(name[dot+1:])
}

// Methods and fields are looked up on the type, then on what it embeds
// (Go's promotion), a few levels deep.
func (b *builder) goFindMethod(t *GoTypeEntry, name string, depth int) *GoEntry {
	if t == nil || depth > 4 {
		return nil
	}
	if hit := t.Scope.Methods.G(t.Cls.Name).G(name); hit != nil {
		return hit
	}
	for _, e := range t.Cls.Embeds {
		if r := b.goFindMethod(b.goTypeRef(e, t.Rel), name, depth+1); r != nil {
			return r
		}
	}
	if t.Cls.Underlying != "" && t.Cls.Kind == "type" {
		return nil
	}
	return nil
}

func (b *builder) goFieldType(t *GoTypeEntry, field string, depth int) *goTyped {
	if t == nil || depth > 4 {
		return nil
	}
	if f := t.Cls.Fields.G(field); f != "" {
		return &goTyped{Type: f, Rel: t.Rel}
	}
	for _, e := range t.Cls.Embeds {
		if e[strings.LastIndex(e, ".")+1:] == field {
			return &goTyped{Type: e, Rel: t.Rel}
		}
		if r := b.goFieldType(b.goTypeRef(e, t.Rel), field, depth+1); r != nil {
			return r
		}
	}
	return nil
}

func (b *builder) goVarType(v *GoVar) *goTyped {
	if v.Type != "" {
		return &goTyped{Type: v.Type, Rel: v.Rel}
	}
	g := b.goState
	if t, ok := g.goVarTypes[v]; ok {
		return t
	}
	g.goVarTypes[v] = nil // cycle guard
	t := b.goInitType(v.Init, v.Rel, goEnv{})
	g.goVarTypes[v] = t
	return t
}

func (b *builder) goFuncNamed(pf *fileInfo, name string) *GoEntry {
	if f := pf.GoScope.Funcs.G(name); f != nil {
		return f
	}
	for _, ds := range pf.GoDot {
		if g := ds.Funcs.G(name); g != nil {
			return g
		}
	}
	return nil
}

// What `name` selects on the value, package or type reached so far. A member
// the repo does not declare (a type from outside, an interface method, a
// func-typed field) is "external": nothing binds to it, and nothing is
// guessed for it.
func (b *builder) goMember(cur *goCur, name string) *goCur {
	if cur.kind == "pkg" {
		if f := cur.scope.Funcs.G(name); f != nil {
			return &goCur{kind: "fn", entry: f}
		}
		if v := cur.scope.Vars.G(name); v != nil {
			if t := b.goVarType(v); t != nil {
				return &goCur{kind: "value", typ: t.Type, rel: t.Rel}
			}
			return goExternal
		}
		if t := cur.scope.Types.G(name); t != nil {
			return &goCur{kind: "typename", t: t}
		}
		return goExternal
	}
	if cur.kind == "value" || cur.kind == "typename" {
		if cur.kind == "value" && cur.t == nil && strings.HasPrefix(cur.typ, "[]") {
			return goExternal
		}
		t := cur.t
		if t == nil {
			t = b.goTypeRef(cur.typ, cur.rel)
		}
		if t == nil {
			return goExternal
		}
		if m := b.goFindMethod(t, name, 0); m != nil {
			return &goCur{kind: "fn", entry: m}
		}
		if cur.kind == "typename" {
			return goExternal
		}
		if f := b.goFieldType(t, name, 0); f != nil {
			return &goCur{kind: "value", typ: f.Type, rel: f.Rel}
		}
		return goExternal
	}
	return goExternal
}

// Evaluates the selector chain that starts with the identifier at `start`
// (`x.field.Method(args)[i].Other()`): every call it makes to a repo
// function or method is reported through `onCall`, and the result is what
// the chain yields (a typed value, where the types are known) with its end
// offset. A nil cur is the original's null result.
func (b *builder) goEval(text []rune, start int, env goEnv, pf *fileInfo, rel string, onCall func(entry *GoEntry, at int)) (*goCur, int) {
	hm := reGoBIdent.At(text, start)
	if hm == nil {
		return nil, 0
	}
	head := hm.S(0)
	i := start + hm.Len()
	var cur *goCur
	if v, ok := env[head]; ok {
		if v.Type != "" {
			cur = &goCur{kind: "value", typ: v.Type, rel: v.Rel}
		} else {
			cur = goExternal
		}
	} else if s, ok := pf.GoImports.Get(head); ok {
		if s != nil {
			cur = &goCur{kind: "pkg", scope: s}
		} else {
			cur = goExternal
		}
	} else if v, ok := pf.GoScope.Vars.Get(head); ok {
		if t := b.goVarType(v); t != nil {
			cur = &goCur{kind: "value", typ: t.Type, rel: t.Rel}
		} else {
			cur = goExternal
		}
	} else if f := b.goHeadFunc(pf, head); f != nil {
		cur = &goCur{kind: "fn", entry: f}
	} else if t, ok := pf.GoScope.Types.Get(head); ok {
		cur = &goCur{kind: "typename", t: t}
	} else {
		cur = goExternal
	}
	for {
		j := i
		for at(text, j) == ' ' || at(text, j) == '\t' {
			j++
		}
		ch := at(text, j)
		if ch == '.' {
			k := j + 1
			for k < len(text) && isSpace(text[k]) {
				k++
			}
			if at(text, k) == '(' { // type assertion
				e := matchClose(text, k)
				if e < 0 {
					break
				}
				tn := goTypeName(str(text, k+1, e))
				if tn != "" && tn != "type" {
					cur = &goCur{kind: "value", typ: tn, rel: rel}
				} else {
					cur = goExternal
				}
				i = e + 1
				continue
			}
			fm := reGoBIdent.At(text, k)
			if fm == nil {
				break
			}
			cur = b.goMember(cur, fm.S(0))
			i = k + fm.Len()
			continue
		}
		if ch == '(' {
			e := matchClose(text, j)
			if e < 0 {
				break
			}
			if cur.kind == "fn" {
				onCall(cur.entry, j)
				if cur.entry.Fn.Result != "" {
					cur = &goCur{kind: "value", typ: cur.entry.Fn.Result, rel: cur.entry.Rel}
				} else {
					cur = goExternal
				}
			} else if cur.kind == "typename" {
				cur = &goCur{kind: "value", t: cur.t, typ: cur.t.Cls.Name, rel: cur.t.Rel} // conversion
			} else {
				cur = goExternal
			}
			i = e + 1
			continue
		}
		if ch == '[' {
			e := matchClose(text, j)
			if e < 0 {
				break
			}
			if cur.kind == "value" && cur.t == nil && strings.HasPrefix(cur.typ, "[]") {
				cur = &goCur{kind: "value", typ: cur.typ[2:], rel: cur.rel}
			} else if cur.kind != "fn" && cur.kind != "typename" {
				cur = goExternal // generic arguments keep the function
			}
			i = e + 1
			continue
		}
		break
	}
	return cur, i
}

// goHeadFunc is `!GO_CALL_SKIP.has(head) && goFuncNamed(pf, head)`.
func (b *builder) goHeadFunc(pf *fileInfo, head string) *GoEntry {
	if goCallSkip[head] {
		return nil
	}
	return b.goFuncNamed(pf, head)
}

func goNoCall(*GoEntry, int) {}

// The type an initializer yields: a composite literal, `new(T)`, or a
// selector chain (conversion, call result, field) that is the whole expression.
func (b *builder) goInitType(init string, rel string, env goEnv) *goTyped {
	text := []rune(reGoBInitDeref.ReplaceFirstLit(jsTrim(init), ""))
	if m := reGoBInitLiteral.Find(text); m != nil {
		if b.goTypeRef(m.S(1), rel) != nil {
			return &goTyped{Type: m.S(1), Rel: rel}
		}
		return nil
	}
	if m := reGoBInitNew.Find(text); m != nil {
		if b.goTypeRef(m.S(1), rel) != nil {
			return &goTyped{Type: m.S(1), Rel: rel}
		}
		return nil
	}
	if !reGoBIdentStart.Test(text) {
		return nil
	}
	cur, end := b.goEval(text, 0, env, b.perFile.G(rel), rel, goNoCall)
	if cur == nil || cur.kind != "value" || !reGoBInitTail.Test(sub(text, end, len(text))) {
		return nil
	}
	if cur.t != nil {
		return &goTyped{Type: cur.t.Cls.Name, Rel: cur.t.Rel}
	}
	return &goTyped{Type: cur.typ, Rel: cur.rel}
}

// Variable types inside one function: receiver, parameters (closures'
// included) and the local declarations whose type is written or follows
// from the initializer. Any other local is recorded with no type, so it
// shadows a package-level name without a guess.
func (b *builder) goEnvOf(fn *Func, pf *fileInfo, rel string, text []rune) goEnv {
	env := goEnv{}
	if fn.RecvName != "" {
		env[fn.RecvName] = &goTyped{Type: fn.RecvType, Rel: rel}
	}
	for _, p := range fn.Params {
		env[p.Name] = &goTyped{Type: p.Type, Rel: rel}
	}
	if fn.BodyStart < 0 {
		return env
	}
	body := goSlice(text, fn.BodyStart, fn.BodyEnd)
	for m := range reGoBClosure.Iter(body, 0) {
		for _, p := range goParams(m.R(1)) {
			if _, ok := env[p.Name]; !ok {
				env[p.Name] = &goTyped{Type: p.Type, Rel: rel}
			}
		}
	}
	bind := func(name string, t *goTyped) {
		if name == "_" {
			return
		}
		if _, ok := env[name]; ok {
			return
		}
		if t == nil {
			t = &goTyped{Rel: rel}
		}
		env[name] = t
	}
	for _, ln := range splitLines(body) {
		if m := reGoBVarLine.Find(ln); m != nil {
			bind(m.S(1), &goTyped{Type: goTypeName(m.S(2)), Rel: rel})
		} else if m := reGoBRangeLine.Find(ln); m != nil {
			bind(m.S(1), nil)
			if m.S(2) != "" {
				var v *goTyped
				if reGoBIdentStart.TestS(m.S(3)) {
					cur, _ := b.goEval(m.R(3), 0, env, pf, rel, goNoCall)
					if cur != nil && cur.kind == "value" && cur.t == nil && strings.HasPrefix(cur.typ, "[]") {
						v = &goTyped{Type: cur.typ[2:], Rel: cur.rel}
					}
				}
				bind(m.S(2), v)
			}
		} else if m := reGoBDefineLine.Find(ln); m != nil {
			bind(m.S(1), b.goInitType(m.S(3), rel, env))
			for _, other := range splitStr(m.S(2), ",") {
				if o := jsTrim(other); o != "" {
					bind(o, nil)
				}
			}
		}
	}
	return env
}

func (b *builder) goCalls(rel string, pf *fileInfo) {
	text := pf.Stripped
	seen := map[string]bool{}
	emit := func(caller string, callee *GoEntry, offset int, relation string) {
		if callee == nil || callee.Nid == "" || callee.Nid == caller {
			return
		}
		key := caller + "|" + callee.Nid
		if seen[key+"|calls"] || seen[key+"|"+relation] {
			return
		}
		seen[key+"|"+relation] = true
		o := edgeOpts{File: rel, Line: pf.LineOf(offset), Confidence: "EXTRACTED", Context: "call"}
		if relation == "indirect_call" {
			o.Confidence = "INFERRED"
			o.Score = inferredCallScore
			o.HasScore = true
		}
		b.addEdge(caller, callee.Nid, relation, o)
	}
	scan := func(from, to int, caller string, env goEnv, source []rune) {
		onCall := func(callee *GoEntry, at int) { emit(caller, callee, at, "calls") }
		pos := from
		for {
			m := reGoBHead.Exec(source, pos)
			if m == nil || !(m.Index() < to) {
				break
			}
			b.goEval(source, m.Index(), env, pf, rel, onCall)
			pos = m.End()
		}
		segment := goSlice(source, from, to)
		for m := range reGoBArg.Iter(segment, 0) {
			if _, ok := env[m.S(1)]; ok || goCallSkip[m.S(1)] {
				continue
			}
			if f := b.goFuncNamed(pf, m.S(1)); f != nil {
				emit(caller, f, from+m.Index(), "indirect_call")
			}
		}
	}
	var taken [][2]int
	fns := make([]*Func, 0, len(pf.Decls.Functions)+len(pf.Decls.GoMethods))
	fns = append(fns, pf.Decls.Functions...)
	fns = append(fns, pf.Decls.GoMethods...)
	for _, fn := range fns {
		eol := indexRune(text, '\n', fn.DeclStart)
		end := eol
		if fn.BodyEnd > 0 {
			end = fn.BodyEnd + 1
		} else if eol < 0 {
			end = len(text)
		}
		taken = append(taken, [2]int{fn.DeclStart, end})
		if fn.BodyStart < 0 {
			continue
		}
		caller := fn.Nid
		if caller == "" {
			caller = pf.LocalDefs.G(fn.Name)
		}
		if caller != "" {
			scan(fn.BodyStart+1, fn.BodyEnd, caller, b.goEnvOf(fn, pf, rel, text), text)
		}
	}
	for _, c := range pf.Decls.Classes {
		if c.BodyStart >= 0 {
			taken = append(taken, [2]int{c.BodyStart, c.BodyEnd + 1})
		}
	}
	outside := blankRanges(text, taken)
	scan(0, len(outside), pf.FileNid, goEnv{}, outside)
}
