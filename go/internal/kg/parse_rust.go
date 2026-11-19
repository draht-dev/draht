package kg

import "strings"

// ============================================================================
// Rust declarations
// ============================================================================

// skipAngles: index after the `<…>` group opening at `open` (the `>` of `->`
// and `=>` closes nothing), or -1.
func skipAngles(text []rune, open int) int {
	depth := 0
	for i := open; i < len(text); i++ {
		ch := at(text, i)
		if ch == '<' {
			depth++
		} else if ch == '>' && at(text, i-1) != '-' && at(text, i-1) != '=' {
			depth--
			if depth == 0 {
				return i + 1
			}
		} else if ch == '{' || ch == ';' {
			return -1
		}
	}
	return -1
}

// rustUse is one leaf of a `use` tree. Alias is "" for a glob.
type rustUse struct {
	Segs  []string
	Alias string
	Glob  bool
}

var (
	reRsUseHeadTail = mustRE(`::\s*$`, "")
	reRsUseLeaf     = mustRE(`^((?:[A-Za-z_]\w*\s*::\s*)*)(\*|[A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$`, "")
	reRsTypePrefix  = mustRE(`^(?:&|\*\s*(?:const|mut)\b|'[A-Za-z_]\w*|mut\b|dyn\b|impl\b)\s*`, "")
	reRsTypePath    = mustRE(`^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)`, "")

	reRsItem     = mustRE(`(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:(?:const|async|unsafe)\s+)*(?:extern\s*(?:"[^"]*"\s*)?)?(fn|struct|enum|union|trait|impl|mod|type|const|static|use|macro_rules\s*!|extern\s+crate)(?![\w])`, "")
	reRsName     = mustRE(`\s*((?:r#)?[A-Za-z_]\w*)`, "")
	reRsNestedFn = mustRE(`\b(fn|struct|enum)\s+((?:r#)?[A-Za-z_]\w*)`, "")
	reRsSpaces   = mustRE(`\s+`, "")
	reRsWhere    = mustRE(`\bwhere\b`, "")
	reRsFor      = mustRE(`^for\s+[^<\s]`, "")
	reRsNegImpl  = mustRE(`^\s*!`, "")
)

// rsConcat is `a.concat(b)`: always a fresh slice.
func rsConcat(a []string, b ...string) []string {
	out := make([]string, 0, len(a)+len(b))
	out = append(out, a...)
	return append(out, b...)
}

// rsPathParts is `s.split("::").map((s) => s.trim()).filter(Boolean)`.
func rsPathParts(s string) []string {
	var out []string
	for _, p := range splitStr(s, "::") {
		if p = jsTrim(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// rustUseTree: `a::b::{c, d as e, f::*, self}` → [{ segs, alias, glob }].
func rustUseTree(text []rune, prefix []string, out []rustUse) []rustUse {
	t := trimRunes(text)
	if len(t) == 0 {
		return out
	}
	brace := indexRune(t, '{', 0)
	if brace >= 0 {
		closeAt := matchClose(t, brace)
		head := jsTrim(reRsUseHeadTail.ReplaceFirstLit(str(t, 0, brace), ""))
		base := prefix
		if head != "" {
			base = rsConcat(prefix, rsPathParts(head)...)
		}
		if closeAt < 0 {
			closeAt = len(t)
		}
		for _, piece := range splitTopLevel(sub(t, brace+1, closeAt)) {
			out = rustUseTree(piece, base, out)
		}
		return out
	}
	m := reRsUseLeaf.Find(t)
	if m == nil {
		return out
	}
	head := rsPathParts(m.S(1))
	if m.S(2) == "*" {
		out = append(out, rustUse{Segs: rsConcat(prefix, head...), Alias: "", Glob: true})
	} else if m.S(2) == "self" && (len(prefix) > 0 || len(head) > 0) {
		segs := rsConcat(prefix, head...)
		alias := m.S(3)
		if alias == "" {
			alias = segs[len(segs)-1]
		}
		out = append(out, rustUse{Segs: segs, Alias: alias, Glob: false})
	} else {
		alias := m.S(3)
		if alias == "" {
			alias = m.S(2)
		}
		out = append(out, rustUse{Segs: append(rsConcat(prefix, head...), m.S(2)), Alias: alias, Glob: false})
	}
	return out
}

// rustTypePath: the name a type expression is known by: `&'a mut
// path::Type<T>` → "Type", with its full path segments (`["path", "Type"]`).
// nil when the expression names no type.
func rustTypePath(expr []rune) []string {
	t := trimRunes(expr)
	for {
		m := reRsTypePrefix.Find(t)
		if m == nil || m.Len() == 0 {
			break
		}
		t = t[m.Len():]
	}
	m := reRsTypePath.Find(t)
	if m == nil {
		return nil
	}
	parts := splitStr(m.S(1), "::")
	for i, p := range parts {
		parts[i] = jsTrim(p)
	}
	return parts
}

// rsBody is what bodyOf returns: { open, close } (hasBody) or { end }.
type rsBody struct {
	hasBody     bool
	open, close int
	end         int
}

// last is `b.close != null ? b.close : b.end`.
func (b rsBody) last() int {
	if b.hasBody {
		return b.close
	}
	return b.end
}

// rsName is what nameAt returns; ok is false for JS null.
type rsName struct {
	name string
	end  int
	ok   bool
}

// rsCtx is the impl / trait body a scan is inside.
type rsCtx struct {
	owner   string
	methods *[]*Func
}

// parseRustDecls: Rust items from masked source, at any module depth:
// functions, structs, enums, unions, traits (with their methods), impl blocks
// (methods grouped by the type they are for), inline and file modules, type
// aliases, constants, statics, macros and `use` trees. Offsets index `masked`.
func parseRustDecls(d *Decls, masked []rune, lineOf func(int) int) {
	d.RsScopes = newOMap[string, *RsFileScope]() // inline module path ("" | "a::b") -> scope
	d.RsImpls = nil
	d.RsNested = nil
	d.RsFns = nil
	d.RsSkip = nil // ranges that hold no calls: type declarations, macro definitions
	n := len(masked)
	scopeOf := func(inl string, parent string, hasParent bool) *RsFileScope {
		s, ok := d.RsScopes.Get(inl)
		if !ok {
			s = &RsFileScope{
				Inl: inl, Items: newOMap[string, *RsItem](), Mods: newOMap[string, string](),
				Uses: newOMap[string, [][]string](), HasParent: hasParent, Parent: parent,
			}
			d.RsScopes.Set(inl, s)
		}
		return s
	}
	nameAt := func(i int) rsName {
		r := reRsName.At(masked, i)
		if r == nil {
			return rsName{}
		}
		return rsName{name: r.S(1), end: r.End(), ok: true}
	}
	// End of a statement starting at `i`: its `;`, or the brace that closes its first top-level block.
	statementEnd := func(i int, stopAtBlock bool) int {
		for k := i; k < n; k++ {
			ch := at(masked, k)
			if ch == '(' || ch == '[' {
				e := matchClose(masked, k)
				if e < 0 {
					return n
				}
				k = e
			} else if ch == '{' {
				e := matchClose(masked, k)
				if e < 0 {
					return n
				}
				if stopAtBlock {
					return e
				}
				k = e
			} else if ch == ';' {
				return k
			} else if ch == '}' {
				return k - 1
			}
		}
		return n
	}
	// Body of an item whose header starts at `i`: { open, close } or { end } at its `;`.
	bodyOf := func(i int) rsBody {
	scan:
		for k := i; k < n; k++ {
			ch := at(masked, k)
			if ch == '(' || ch == '[' {
				e := matchClose(masked, k)
				if e < 0 {
					break scan
				}
				k = e
			} else if ch == '<' {
				if e := skipAngles(masked, k); e > 0 {
					k = e - 1
				}
			} else if ch == '{' {
				e := matchClose(masked, k)
				if e < 0 {
					return rsBody{end: n}
				}
				return rsBody{hasBody: true, open: k, close: e}
			} else if ch == ';' {
				return rsBody{end: k}
			} else if ch == '}' {
				return rsBody{end: k - 1}
			}
		}
		return rsBody{end: n}
	}
	// `lineOf(b.close != null ? b.close : Math.min(b.end, n - 1))`
	endLine := func(b rsBody) int {
		if b.hasBody {
			return lineOf(b.close)
		}
		return lineOf(min(b.end, n-1))
	}
	addFn := func(pos int, nameInfo rsName, inl string, owner string, list *[]*Func) int {
		b := bodyOf(nameInfo.end)
		fn := &Func{Name: nameInfo.name, Line: lineOf(pos), End: endLine(b), DeclStart: pos, BodyStart: -1, BodyEnd: -1, Inl: inl, Owner: owner}
		if b.hasBody {
			fn.BodyStart = b.open
			fn.BodyEnd = b.close
		}
		*list = append(*list, fn)
		d.RsFns = append(d.RsFns, fn)
		if fn.BodyStart >= 0 {
			for m := range reRsNestedFn.Iter(masked, fn.BodyStart) {
				if m.Index() >= fn.BodyEnd {
					break
				}
				nb := bodyOf(m.Index() + m.Len())
				d.RsNested = append(d.RsNested, &RsNested{Name: m.S(2), Kind: m.S(1), Line: lineOf(m.Index()), End: endLine(nb), Parent: fn})
			}
		}
		return b.last()
	}

	var scanItems func(from, to int, inl string, parent string, hasParent bool, ctx *rsCtx)
	scanItems = func(from, to int, inl string, parent string, hasParent bool, ctx *rsCtx) {
		var scope *RsFileScope
		if ctx == nil {
			scope = scopeOf(inl, parent, hasParent)
		}
		i := from
		for i < to {
			ch := at(masked, i)
			if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == ';' {
				i++
				continue
			}
			if ch == '#' { // attribute
				open := indexRune(masked, '[', i)
				e := -1
				if open >= 0 && open <= i+2 {
					e = matchClose(masked, open)
				}
				if e < 0 {
					i = i + 1
				} else {
					i = e + 1
				}
				continue
			}
			m := reRsItem.At(masked, i)
			if m == nil {
				i = statementEnd(i, true) + 1
				continue
			}
			kw := reRsSpaces.ReplaceLit(m.S(1), " ")
			after := m.End()
			nm := nameAt(after)
			if kw == "fn" {
				if !nm.ok {
					i = statementEnd(after, true) + 1
					continue
				}
				if ctx != nil {
					i = addFn(i, nm, inl, ctx.owner, ctx.methods) + 1
				} else {
					var list []*Func
					i = addFn(i, nm, inl, "", &list) + 1
					fn := list[0]
					d.Functions = append(d.Functions, fn)
					if !scope.Items.Has(fn.Name) {
						scope.Items.Set(fn.Name, &RsItem{Kind: "fn", Name: fn.Name})
					}
				}
			} else if kw == "struct" || kw == "enum" || kw == "union" || kw == "trait" {
				if !nm.ok || ctx != nil {
					i = statementEnd(after, true) + 1
					continue
				}
				b := bodyOf(nm.end)
				kind := "struct"
				if kw == "trait" {
					kind = "trait"
				} else if kw == "enum" {
					kind = "enum"
				}
				cls := &Class{Name: nm.name, Line: lineOf(i), End: endLine(b), Kind: kind, Inl: inl, BodyStart: -1, BodyEnd: -1}
				if b.hasBody {
					cls.BodyStart = b.open
					cls.BodyEnd = b.close
				}
				if kw != "trait" {
					d.RsSkip = append(d.RsSkip, [2]int{i, b.last() + 1})
				}
				d.Classes = append(d.Classes, cls)
				if !scope.Items.Has(cls.Name) {
					scope.Items.Set(cls.Name, &RsItem{Kind: cls.Kind, Name: cls.Name})
				}
				if kw == "trait" && b.hasBody {
					impl := &RsImpl{Inl: inl, TypeName: nm.name, TypeSegs: []string{nm.name}, TraitSegs: nil, Line: cls.Line, IsTrait: true}
					d.RsImpls = append(d.RsImpls, impl)
					scanItems(b.open+1, b.close, inl, parent, hasParent, &rsCtx{owner: nm.name, methods: &impl.Methods})
				}
				i = b.last() + 1
			} else if kw == "impl" {
				k := after
				for k < n && isSpace(masked[k]) {
					k++
				}
				if at(masked, k) == '<' {
					if e := skipAngles(masked, k); e > 0 {
						k = e
					}
				}
				b := bodyOf(k)
				if !b.hasBody || ctx != nil {
					i = b.last() + 1
					continue
				}
				header := sub(masked, k, b.open)
				if wh := reRsWhere.Search(header); wh >= 0 {
					header = header[:wh]
				}
				// the first ` for ` outside angle brackets separates trait and type
				depth, forAt := 0, -1
				for q := 0; q < len(header); q++ {
					c := header[q]
					if c == '<' {
						depth++
					} else if c == '>' && at(header, q-1) != '-' && at(header, q-1) != '=' {
						depth--
					} else if depth == 0 && c == 'f' && reRsFor.Test(header[q:]) && (q == 0 || isSpace(header[q-1])) {
						forAt = q
						break
					}
				}
				var typeSegs, traitSegs []string
				if forAt >= 0 {
					typeSegs = rustTypePath(sub(header, forAt+3, len(header)))
					traitSegs = rustTypePath([]rune(reRsNegImpl.ReplaceFirstLit(str(header, 0, forAt), "")))
				} else {
					typeSegs = rustTypePath(header)
				}
				if typeSegs != nil {
					impl := &RsImpl{Inl: inl, TypeName: typeSegs[len(typeSegs)-1], TypeSegs: typeSegs, TraitSegs: traitSegs, Line: lineOf(i), IsTrait: false}
					d.RsImpls = append(d.RsImpls, impl)
					scanItems(b.open+1, b.close, inl, parent, hasParent, &rsCtx{owner: impl.TypeName, methods: &impl.Methods})
				}
				i = b.close + 1
			} else if kw == "mod" {
				if !nm.ok || ctx != nil {
					i = statementEnd(after, true) + 1
					continue
				}
				b := bodyOf(nm.end)
				if b.hasBody {
					subInl := nm.name
					if inl != "" {
						subInl = inl + "::" + nm.name
					}
					scope.Mods.Set(nm.name, subInl)
					scanItems(b.open+1, b.close, subInl, inl, true, nil)
					i = b.close + 1
				} else {
					scope.ModDecls = append(scope.ModDecls, RsModDecl{Name: nm.name, Line: lineOf(i)})
					i = b.end + 1
				}
			} else if kw == "type" || kw == "const" || kw == "static" {
				name := nm
				if name.ok && name.name == "mut" {
					name = nameAt(name.end)
				}
				end := statementEnd(after, false)
				if name.ok && name.name != "_" && ctx == nil {
					kind := "const"
					if kw == "type" {
						kind = "type"
					}
					t := &TypeDecl{Name: name.name, Line: lineOf(i), Kind: kind, Inl: inl}
					d.Types = append(d.Types, t)
					if !scope.Items.Has(t.Name) {
						scope.Items.Set(t.Name, &RsItem{Kind: t.Kind, Name: t.Name})
					}
				}
				i = end + 1
			} else if kw == "macro_rules !" || kw == "macro_rules!" {
				b := rsBody{end: after}
				if nm.ok {
					b = bodyOf(nm.end)
				}
				end := b.last()
				if nm.ok && !b.hasBody { // macro_rules! name ( … );
					open := indexRune(masked, '(', nm.end)
					e := -1
					if open >= 0 {
						e = matchClose(masked, open)
					}
					if e > 0 {
						end = e
					}
				}
				d.RsSkip = append(d.RsSkip, [2]int{i, end + 1})
				if nm.ok && ctx == nil {
					t := &TypeDecl{Name: nm.name, Line: lineOf(i), Kind: "macro", Inl: inl}
					d.Types = append(d.Types, t)
					if !scope.Items.Has(t.Name) {
						scope.Items.Set(t.Name, &RsItem{Kind: "macro", Name: t.Name})
					}
				}
				i = end + 1
			} else if kw == "use" {
				end := statementEnd(after, false)
				if ctx == nil {
					for _, u := range rustUseTree(sub(masked, after, end), nil, nil) {
						if u.Glob {
							scope.Globs = append(scope.Globs, u.Segs)
						} else if u.Alias != "_" {
							scope.Uses.Set(u.Alias, append(scope.Uses.G(u.Alias), u.Segs))
						}
						d.Imports = append(d.Imports, &Import{Spec: strings.Join(u.Segs, "::"), Namespace: u.Alias, Line: lineOf(i), RsInl: inl, RsSegs: u.Segs, RsGlob: u.Glob})
					}
				}
				i = end + 1
			} else {
				i = statementEnd(after, false) + 1 // extern crate
			}
		}
	}
	scanItems(0, n, "", "", false, nil)
}
