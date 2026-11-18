package kg

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// -- Rust: the module tree (`mod x;` → file, inline `mod x { … }`), each
// module's items and `use` bindings, crates of the workspace, and impl
// methods joined to the type they are for.

// rsScope is one module of the build:
// { rel, inl, items, mods: name -> key, modDecls, uses, globs, parent: key | null }.
type rsScope struct {
	rel       string
	inl       string
	items     *OMap[string, *RsItem]
	mods      *OMap[string, string] // name -> key
	modDecls  []RsModDecl
	uses      *OMap[string, [][]string]
	globs     [][]string
	hasParent bool
	parent    string // key
}

// rsBuild is the state the Rust closures of buildGraph share.
type rsBuild struct {
	scopes  *OMap[string, *rsScope]        // key -> scope
	crates  *OMap[string, string]          // crate name -> its lib root file
	childOf *OMap[string, string]          // file -> key of the module that declares it
	methods map[string]map[string][]string // owner node id -> (method name -> [node ids])
}

// rsRef is what a name or a path resolves to:
// { mod: key } | { item } | { member: [item, name] } | RS_EXT | null (nil).
type rsRef struct {
	mod        string
	hasMod     bool
	item       *RsItem
	member     *RsItem
	memberName string
	ext        bool
}

var rsExt = &rsRef{ext: true}

var rsOwnerKinds = strSet("struct", "enum", "trait", "type")

var rustCallSkip = strSet(
	"if", "while", "match", "for", "loop", "return", "fn", "let", "in", "as", "move", "async", "await", "unsafe", "where", "impl", "dyn",
	"ref", "mut", "self", "super", "crate", "Some", "Ok", "Err", "None", "Box", "Vec", "String", "drop", "else", "break", "continue", "pub", "use", "mod",
)

var (
	reRsBuildCargoKV   = mustRE(`^(name|path)\s*=\s*"([^"]*)"`, "")
	rsPathCallRe       = mustRE(`(?<![\w.:!])((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*(?:::\s*<[^<>()]*>\s*)?\(`, "g")
	rsSelfCallRe       = mustRE(`\bself\s*\.\s*([A-Za-z_]\w*)\s*(?:::\s*<[^<>()]*>\s*)?\(`, "g")
	reRsBuildPatLead   = mustRE(`(?:\blet\s+(?:mut\s+)?|\|\s*)$`, "")
	reRsBuildIfWord    = mustRE(`^if\b`, "")
	reRsBuildParam     = mustRE(`([A-Za-z_]\w*)\s*:`, "g")
	reRsBuildLet       = mustRE(`\blet\s+([^=;]*)`, "g")
	reRsBuildLowerID   = mustRE(`[a-z_]\w*`, "g")
	reRsBuildClosure   = mustRE(`\|([^|\n]*)\|`, "g")
	reRsBuildClosureID = mustRE(`([a-z_]\w*)\s*(?=[,:|]|$)`, "g")
	reRsBuildFor       = mustRE(`\bfor\s+([^{]*?)\s+in\b`, "g")
)

func (b *builder) rsKey(rel, inl string) string { return rel + "\n" + inl }

// buildRust runs the unconditional Rust part of buildGraph: module scopes,
// Cargo.toml crates, `mod x;` resolution, impl methods joined to their type,
// nested items.
func (b *builder) buildRust() {
	st := &rsBuild{
		scopes:  newOMap[string, *rsScope](),
		crates:  newOMap[string, string](),
		childOf: newOMap[string, string](),
		methods: map[string]map[string][]string{},
	}
	b.rsState = st
	for rel, pf := range b.perFile.All() {
		if pf.Lang != "rust" {
			continue
		}
		for _, sc := range pf.Decls.RsScopes.All() {
			mods := newOMap[string, string]()
			for name, inline := range sc.Mods.All() {
				mods.Set(name, b.rsKey(rel, inline))
			}
			for _, item := range sc.Items.All() {
				item.Rel = rel
				item.Nid = pf.LocalDefs.G(item.Name)
			}
			bs := &rsScope{rel: rel, inl: sc.Inl, items: sc.Items, mods: mods, modDecls: sc.ModDecls, uses: sc.Uses, globs: sc.Globs}
			if sc.HasParent {
				bs.hasParent = true
				bs.parent = b.rsKey(rel, sc.Parent)
			}
			st.scopes.Set(b.rsKey(rel, sc.Inl), bs)
		}
	}
	if st.scopes.Len() > 0 {
		dirs := newOSet[string]()
		for _, sc := range st.scopes.All() {
			parts := strings.Split(sc.rel, "/")
			for i := 0; i < len(parts); i++ {
				dirs.Add(strings.Join(parts[:i], "/"))
			}
		}
		sortedDirs := dirs.Items()
		sort.Strings(sortedDirs)
		for _, dir := range sortedDirs {
			data, err := os.ReadFile(filepath.Join(b.root, filepath.FromSlash(dir), "Cargo.toml"))
			if err != nil {
				continue
			}
			toml := string(data)
			section, name, libPath := "", "", ""
			hasName := false // `name === null` until a name is read, an empty one included
			for _, raw := range strings.Split(toml, "\n") {
				ln := jsTrim(raw)
				if strings.HasPrefix(ln, "[") {
					section = ln
					continue
				}
				kv := reRsBuildCargoKV.FindS(ln)
				if kv == nil {
					continue
				}
				if section == "[package]" && kv.S(1) == "name" && !hasName {
					name, hasName = kv.S(2), true
				} else if section == "[lib]" && kv.S(1) == "name" {
					name, hasName = kv.S(2), true
				} else if section == "[lib]" && kv.S(1) == "path" {
					libPath = kv.S(2)
				}
			}
			d := dir
			if d == "" {
				d = "."
			}
			if libPath == "" {
				libPath = "src/lib.rs"
			}
			lib := path.Join(d, libPath)
			// path.posix.normalize keeps a trailing slash, path.Join drops it
			if strings.HasSuffix(libPath, "/") && !strings.HasSuffix(lib, "/") {
				lib += "/"
			}
			if name != "" && b.perFile.Has(lib) {
				st.crates.Set(strings.ReplaceAll(name, "-", "_"), lib)
			}
		}
		// `mod x;` in a.rs names a/x.rs or a/x/mod.rs; in mod.rs, lib.rs, main.rs
		// and any other crate root it names a sibling.
		keys := st.scopes.Keys()
		sort.Strings(keys)
		for _, key := range keys {
			sc := st.scopes.G(key)
			if len(sc.modDecls) == 0 {
				continue
			}
			dir := path.Dir(sc.rel)
			base := path.Base(sc.rel)
			own := path.Join(dir, strings.TrimSuffix(base, ".rs"))
			var bases []string
			if base == "mod.rs" || base == "lib.rs" || base == "main.rs" {
				bases = []string{dir}
			} else {
				bases = []string{own, dir}
			}
			var inl []string
			if sc.inl != "" {
				inl = strings.Split(sc.inl, "::")
			}
			pf := b.perFile.G(sc.rel)
			for _, decl := range sc.modDecls {
				hit := ""
				for _, bs := range bases {
					here := path.Join(append([]string{bs}, inl...)...)
					for _, c := range []string{path.Join(here, decl.Name+".rs"), path.Join(here, decl.Name, "mod.rs")} {
						cand := path.Clean(c)
						if b.perFile.Has(cand) && cand != sc.rel {
							hit = cand
							break
						}
					}
					if hit != "" {
						break
					}
				}
				if hit == "" {
					continue
				}
				sc.mods.Set(decl.Name, b.rsKey(hit, ""))
				if !st.childOf.Has(hit) {
					st.childOf.Set(hit, key)
				}
				b.addEdge(pf.FileNid, b.perFile.G(hit).FileNid, "imports_from", edgeOpts{File: sc.rel, Line: decl.Line, Context: "module"})
			}
		}
	}
	for rel, pf := range b.perFile.All() {
		if pf.Lang != "rust" {
			continue
		}
		d := pf.Decls
		for _, impl := range d.RsImpls {
			key := b.rsKey(rel, impl.Inl)
			var r *rsRef
			if len(impl.TypeSegs) == 1 {
				r = b.rsLookup(key, impl.TypeName, 0)
			} else {
				r = b.rsResolve(key, impl.TypeSegs, 0, false)
			}
			ownerNid := ""
			if r != nil && r.item != nil && rsOwnerKinds[r.item.Kind] {
				ownerNid = r.item.Nid
			}
			if ownerNid == "" {
				// an impl for a type this repo does not declare: the block itself stands for it
				ownerNid = makeID(fileStem(rel), "impl", impl.TypeName)
				n := codeNode(ownerNid, impl.TypeName, rel, impl.Line)
				n.Type = "impl"
				b.addNode(n)
				b.addEdge(pf.FileNid, ownerNid, "contains", edgeOpts{File: rel, Line: impl.Line})
			}
			impl.OwnerNid = ownerNid
			table := st.methods[ownerNid]
			if table == nil {
				table = map[string][]string{}
				st.methods[ownerNid] = table
			}
			for _, m := range impl.Methods {
				m.Nid = makeID(fileStem(rel), impl.TypeName, m.Name)
				m.OwnerNid = ownerNid
				n := codeNode(m.Nid, m.Name+"()", rel, m.Line)
				n.Callable = true
				b.addNode(n)
				b.addEdge(ownerNid, m.Nid, "method", edgeOpts{File: rel, Line: m.Line})
				includes := false
				for _, id := range table[m.Name] {
					if id == m.Nid {
						includes = true
						break
					}
				}
				if !includes {
					table[m.Name] = append(table[m.Name], m.Nid)
				}
			}
			if impl.TraitSegs != nil && !impl.IsTrait {
				tr := b.rsResolve(key, impl.TraitSegs, 0, false)
				if tr != nil && tr.item != nil && tr.item.Kind == "trait" && tr.item.Nid != "" && tr.item.Nid != ownerNid {
					b.addEdge(ownerNid, tr.item.Nid, "implements", edgeOpts{File: rel, Line: impl.Line})
				}
			}
		}
		for _, f := range d.Functions {
			f.Nid = pf.LocalDefs.G(f.Name)
		}
		for _, nf := range d.RsNested {
			parent := nf.Parent.Nid
			if parent == "" {
				continue
			}
			nid := makeID(parent, nf.Name)
			if b.hasNode(nid) {
				continue
			}
			if nf.Kind == "fn" {
				n := codeNode(nid, nf.Name+"()", rel, nf.Line)
				n.Callable = true
				b.addNode(n)
			} else {
				n := codeNode(nid, nf.Name, rel, nf.Line)
				if nf.Kind == "enum" {
					n.Type = "enum"
				} else {
					n.Type = "class"
				}
				b.addNode(n)
			}
			b.addEdge(parent, nid, "contains", edgeOpts{File: rel, Line: nf.Line})
		}
	}
}

func (b *builder) rsCrateRoot(rel string) string {
	st := b.rsState
	seen := map[string]bool{}
	for st.childOf.Has(rel) && !seen[rel] {
		seen[rel] = true
		rel = st.scopes.G(st.childOf.G(rel)).rel
	}
	return rel
}

// rsParent is the key of the module above `key`; ok is false for none (null).
func (b *builder) rsParent(key string) (string, bool) {
	st := b.rsState
	sc, ok := st.scopes.Get(key)
	if !ok {
		return "", false
	}
	if sc.hasParent {
		return sc.parent, true
	}
	if k := st.childOf.G(sc.rel); k != "" {
		return k, true
	}
	return "", false
}

// A name in a module: { mod: key } | { item } | RS_EXT | null. `use`
// bindings and glob imports are followed.
func (b *builder) rsLookup(key, name string, depth int) *rsRef {
	st := b.rsState
	sc, ok := st.scopes.Get(key)
	if !ok || depth > 8 {
		return nil
	}
	if sc.mods.Has(name) {
		return &rsRef{mod: sc.mods.G(name), hasMod: true}
	}
	if sc.items.Has(name) {
		return &rsRef{item: sc.items.G(name)}
	}
	if sc.uses.Has(name) {
		return b.rsUse(key, sc.uses.G(name), nil, depth+1)
	}
	for _, g := range sc.globs {
		r := b.rsResolve(key, g, depth+1, true)
		if r == nil || !r.hasMod {
			continue
		}
		sub, ok := st.scopes.Get(r.mod)
		if ok && (sub.mods.Has(name) || sub.items.Has(name) || sub.uses.Has(name)) {
			return b.rsLookup(r.mod, name, depth+1)
		}
	}
	return nil
}

// A path from a module: additionally { member: [item, name] } for
// `Type::name`. Null when unknown, RS_EXT for a path outside the repo.
func (b *builder) rsResolve(key string, segs []string, depth int, viaUse bool) *rsRef {
	st := b.rsState
	if len(segs) == 0 || depth > 8 {
		return nil
	}
	first := segs[0]
	var cur *rsRef
	i := 1
	if first == "crate" {
		cur = &rsRef{mod: b.rsKey(b.rsCrateRoot(st.scopes.G(key).rel), ""), hasMod: true}
	} else if first == "self" {
		cur = &rsRef{mod: key, hasMod: true}
	} else if first == "super" {
		k := key
		i = 0
		for i < len(segs) && segs[i] == "super" {
			p, ok := b.rsParent(k)
			if !ok {
				return nil
			}
			k = p
			i++
		}
		cur = &rsRef{mod: k, hasMod: true}
	} else if first == "std" || first == "core" || first == "alloc" {
		return rsExt
	} else {
		sc, ok := st.scopes.Get(key)
		cur = nil
		if ok {
			if sc.mods.Has(first) {
				cur = &rsRef{mod: sc.mods.G(first), hasMod: true}
			} else if sc.items.Has(first) {
				cur = &rsRef{item: sc.items.G(first)}
			} else if sc.uses.Has(first) {
				var self []string
				if viaUse {
					self = segs
				}
				cur = b.rsUse(key, sc.uses.G(first), self, depth+1)
			}
		}
		if cur == nil && st.crates.Has(first) {
			cur = &rsRef{mod: b.rsKey(st.crates.G(first), ""), hasMod: true}
		}
		if cur == nil && !viaUse {
			cur = b.rsLookup(key, first, depth+1)
		}
		if cur == nil {
			return nil
		}
	}
	for ; i < len(segs); i++ {
		if cur == nil || !cur.hasMod {
			if cur != nil && cur.item != nil && i == len(segs)-1 {
				return &rsRef{member: cur.item, memberName: segs[i]}
			}
			if cur != nil && cur.ext {
				return rsExt
			}
			return nil
		}
		cur = b.rsLookup(cur.mod, segs[i], depth+1)
	}
	return cur
}

// One `use` name can bind a type, a value and a macro (three namespaces):
// the binding that names a module or an item of this repo wins.
// self is nil for the JS `null`.
func (b *builder) rsUse(key string, candidates [][]string, self []string, depth int) *rsRef {
	var fallback *rsRef
	for _, segs := range candidates {
		if self != nil && strings.Join(segs, "::") == strings.Join(self, "::") {
			continue
		}
		r := b.rsResolve(key, segs, depth, true)
		if r != nil && (r.hasMod || r.item != nil) {
			return r
		}
		if r != nil && fallback == nil {
			fallback = r
		}
	}
	return fallback
}

// `use` paths: the file that declares the module or item, and the item itself.
func (b *builder) rustImports(rel string, pf *fileInfo) {
	st := b.rsState
	seen := map[string]bool{}
	once := func(target, relation string, line int) {
		k := target + "|" + relation
		if seen[k] || target == pf.FileNid {
			return
		}
		seen[k] = true
		b.addEdge(pf.FileNid, target, relation, edgeOpts{File: rel, Line: line, Context: "import"})
	}
	for _, imp := range pf.Decls.Imports {
		r := b.rsResolve(b.rsKey(rel, imp.RsInl), imp.RsSegs, 0, true)
		if r != nil && r.hasMod {
			target, ok := st.scopes.Get(r.mod)
			if ok && target.rel != rel {
				once(b.perFile.G(target.rel).FileNid, "imports_from", imp.Line)
			}
		} else if r != nil && r.item != nil {
			if r.item.Rel == rel {
				continue
			}
			once(b.perFile.G(r.item.Rel).FileNid, "imports_from", imp.Line)
			if r.item.Nid != "" {
				once(r.item.Nid, "imports", imp.Line)
			}
		} else if r != nil && r.member != nil {
			if r.member.Rel != rel {
				once(b.perFile.G(r.member.Rel).FileNid, "imports_from", imp.Line)
			}
		} else {
			head := ""
			if len(imp.RsSegs) > 0 {
				head = imp.RsSegs[0]
			}
			if head == "" || head == "crate" || head == "self" || head == "super" || st.crates.Has(head) {
				continue
			}
			nid := makeID(head)
			if taken, ok := b.nodeByID[nid]; ok && taken.SourceFile != "" {
				nid = makeID("external", head)
			}
			if nid == "" {
				continue
			}
			b.addNode(&Node{ID: nid, Label: head, FileType: "code", Type: "module"})
			once(nid, "imports_from", imp.Line)
		}
	}
}

// `Name(…)` that destructures (after `let`, before `=>` or a single `=`,
// in closure parameters) instead of constructing.
func (b *builder) rsIsPattern(segment []rune, pos, open int) bool {
	if reRsBuildPatLead.Test(sub(segment, max(0, pos-24), pos)) {
		return true
	}
	k := matchClose(segment, open)
	if k < 0 {
		return false
	}
	for k++; k < len(segment); k++ {
		ch := segment[k]
		if ch == ')' || ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
			continue
		}
		if ch == '=' {
			return at(segment, k+1) != '='
		}
		if ch == '|' {
			return at(segment, k+1) != '|'
		}
		if ch == 'i' && reRsBuildIfWord.Test(sub(segment, k, k+3)) {
			return true
		}
		return ch == ':' && at(segment, k+1) != ':'
	}
	return false
}

// rsUniqueMethod is the node id of the one method `name` of an owner, "" for
// none or several.
func (b *builder) rsUniqueMethod(ownerNid, name string) string {
	if ownerNid == "" {
		return ""
	}
	list := b.rsState.methods[ownerNid][name]
	if len(list) == 1 {
		return list[0]
	}
	return ""
}

// Calls whose target the source names outright: a function in scope, a
// path (`module::f`, `Type::f`), `Self::f` and `self.f()` on a method the
// type declares once. A receiver that needs type inference is left alone.
func (b *builder) rustCalls(rel string, pf *fileInfo) {
	text := pf.Stripped
	seen := map[string]bool{}
	emit := func(caller, target string, offset int, relation string) {
		if target == "" || target == caller {
			return
		}
		k := caller + "|" + target + "|" + relation
		if seen[k] {
			return
		}
		seen[k] = true
		b.addEdge(caller, target, relation, edgeOpts{File: rel, Line: pf.LineOf(offset), Context: "call"})
	}
	scan := func(segment []rune, base int, caller, key, ownerNid string, locals map[string]bool) {
		for m := range rsPathCallRe.Iter(segment, 0) {
			segs := strings.Split(m.S(1), "::")
			for i, s := range segs {
				segs[i] = jsTrim(s)
			}
			name := segs[len(segs)-1]
			if len(segs) == 1 {
				if rustCallSkip[name] || locals[name] {
					continue
				}
				r := b.rsLookup(key, name, 0)
				if r == nil || r.item == nil || r.item.Nid == "" {
					continue
				}
				if r.item.Kind == "fn" {
					emit(caller, r.item.Nid, base+m.Index(), "calls")
				} else if r.item.Kind == "struct" && !b.rsIsPattern(segment, m.Index(), m.Index()+m.Len()-1) {
					emit(caller, r.item.Nid, base+m.Index(), "instantiates")
				}
			} else if segs[0] == "Self" {
				if len(segs) == 2 {
					emit(caller, b.rsUniqueMethod(ownerNid, name), base+m.Index(), "calls")
				}
			} else {
				r := b.rsResolve(key, segs, 0, false)
				if r == nil {
					continue
				}
				if r.item != nil && r.item.Nid != "" {
					if r.item.Kind == "fn" {
						emit(caller, r.item.Nid, base+m.Index(), "calls")
					} else if r.item.Kind == "struct" && !b.rsIsPattern(segment, m.Index(), m.Index()+m.Len()-1) {
						emit(caller, r.item.Nid, base+m.Index(), "instantiates")
					}
				} else if r.member != nil && r.member.Nid != "" {
					emit(caller, b.rsUniqueMethod(r.member.Nid, r.memberName), base+m.Index(), "calls")
				}
			}
		}
		if ownerNid == "" {
			return
		}
		for m := range rsSelfCallRe.Iter(segment, 0) {
			emit(caller, b.rsUniqueMethod(ownerNid, m.S(1)), base+m.Index(), "calls")
		}
	}
	var taken [][2]int
	for _, fn := range pf.Decls.RsFns {
		eol := indexRune(text, '\n', fn.DeclStart)
		end := eol
		if fn.BodyEnd > 0 {
			end = fn.BodyEnd + 1
		} else if eol < 0 {
			end = len(text)
		}
		taken = append(taken, [2]int{fn.DeclStart, end})
		if fn.BodyStart < 0 || fn.Nid == "" {
			continue
		}
		locals := map[string]bool{}
		for m := range reRsBuildParam.Iter(sub(text, fn.DeclStart, fn.BodyStart), 0) {
			locals[m.S(1)] = true
		}
		body := sub(text, fn.BodyStart+1, fn.BodyEnd)
		for m := range reRsBuildLet.Iter(body, 0) {
			for id := range reRsBuildLowerID.IterS(strings.Split(m.S(1), ":")[0]) {
				locals[id.S(0)] = true
			}
		}
		for m := range reRsBuildClosure.Iter(body, 0) {
			for id := range reRsBuildClosureID.IterS(m.S(1)) {
				locals[id.S(1)] = true
			}
		}
		for m := range reRsBuildFor.Iter(body, 0) {
			for id := range reRsBuildLowerID.IterS(m.S(1)) {
				locals[id.S(0)] = true
			}
		}
		scan(body, fn.BodyStart+1, fn.Nid, b.rsKey(rel, fn.Inl), fn.OwnerNid, locals)
	}
	scan(blankRanges(text, append(taken, pf.Decls.RsSkip...)), 0, pf.FileNid, b.rsKey(rel, ""), "", map[string]bool{})
}
