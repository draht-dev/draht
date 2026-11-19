package kg

import "strings"

// ============================================================================
// Go declarations
// ============================================================================

var goTypeWords = strSet("func", "map", "chan", "struct", "interface")
var goCallSkip = strSet(
	"if", "for", "switch", "select", "return", "func", "go", "defer", "range", "case", "else", "var", "const", "type",
	"make", "new", "len", "cap", "append", "copy", "delete", "panic", "recover", "close", "print", "println", "min", "max", "clear",
	"string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "byte", "rune",
	"float32", "float64", "complex64", "complex128", "bool", "error", "any",
)

var (
	reGoSlicePrefix = mustRE(`^\[\]`, "")
	reGoTypeName    = mustRE(`^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)`, "")
	reGoNamedPiece  = mustRE(`^([A-Za-z_]\w*)\s+(\S[\s\S]*)$`, "")
	reGoIdent       = mustRE(`^[A-Za-z_]\w*$`, "")

	reGoPackage   = mustRE(`^package\s+([A-Za-z_]\w*)`, "m")
	reGoGenerics  = mustRE(`^\[\s*[A-Za-z_]\w*\s+[^\]]`, "")
	reGoStruct    = mustRE(`^struct\b`, "")
	reGoInterface = mustRE(`^interface\b`, "")
	reGoEmbed     = mustRE(`^\*?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)(?:\[[^\]]*\])?\s*(?:"\s*"|`+"`"+`\s*`+"`"+`)?$`, "")
	reGoField     = mustRE(`^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+(\S.*)$`, "")
	reGoFunc      = mustRE(`func\s*(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*(\[[^\]]*\]\s*)?\(`, "")
	reGoRecv      = mustRE(`^\s*(?:([A-Za-z_]\w*)\s+)?\*?\s*([A-Za-z_]\w*)`, "")

	reGoLineFunc    = mustRE(`^func\b`, "")
	reGoLineType    = mustRE(`^type\s+([A-Za-z_]\w*)`, "")
	reGoLineGroup   = mustRE(`^(type|const|var)\s*\(`, "")
	reGoLineValues  = mustRE(`^(?:const|var)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)`, "")
	reGoGroupType   = mustRE(`^\s*([A-Za-z_]\w*)\b`, "")
	reGoContinues   = mustRE(`[+\-*/%&|^<>=,]$`, "")
	reGoGroupValues = mustRE(`^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?=$|=|[A-Za-z_*\[]|\/\/)`, "")
	reGoGroupOpen   = mustRE(`^(?:type|const|var)\s*\($`, "")
)

// goTypeName: a Go type expression reduced to the name a method is looked up
// on: `*pkg.T[K]` → "pkg.T"; `[]T` and `...T` → "[]T" (the elements are T).
// "" for maps, channels, function types and type literals.
func goTypeName(expr string) string { return goTypeNameR([]rune(expr)) }

// goTypeNameR is goTypeName on runes.
func goTypeNameR(expr []rune) string {
	t := trimRunes(expr)
	slice := false
	for {
		if hasPrefixAt(t, 0, "*") {
			t = trimRunes(t[1:])
		} else if hasPrefixAt(t, 0, "...") {
			slice = true
			t = trimRunes(t[3:])
		} else if hasPrefixAt(t, 0, "[") {
			e := matchClose(t, 0)
			if e < 0 {
				return ""
			}
			slice = true
			t = trimRunes(t[e+1:])
		} else {
			break
		}
	}
	if hasPrefixAt(t, 0, "map[") {
		e := matchClose(t, 3)
		v := ""
		if e > 0 {
			v = goTypeNameR(t[e+1:])
		}
		if v != "" {
			return "[]" + reGoSlicePrefix.ReplaceFirstLit(v, "")
		}
		return ""
	}
	m := reGoTypeName.Find(t)
	if m == nil || goTypeWords[m.S(1)] {
		return ""
	}
	if slice {
		return "[]" + m.S(1)
	}
	return m.S(1)
}

// goParams: `a, b int, c *T` → [{ name, type }], with Go's shared-type
// grouping. A list of bare types (unnamed parameters) gives none.
func goParams(text []rune) []GoParam {
	var out []GoParam
	var pending []string
	for _, raw := range splitTopLevel(text) {
		piece := trimRunes(raw)
		if len(piece) == 0 {
			continue
		}
		m := reGoNamedPiece.Find(piece)
		if m != nil && !goTypeWords[m.S(1)] {
			typ := goTypeNameR(m.R(2))
			for _, n := range pending {
				out = append(out, GoParam{Name: n, Type: typ})
			}
			pending = nil
			out = append(out, GoParam{Name: m.S(1), Type: typ})
		} else if reGoIdent.Test(piece) {
			pending = append(pending, string(piece))
		} else {
			pending = nil
		}
	}
	return out
}

// goFirstResult: the first result type of a signature's result text (`*T`,
// `(T, error)`, `(x T, err error)`).
func goFirstResult(text []rune) string {
	t := trimRunes(text)
	if len(t) == 0 {
		return ""
	}
	if hasPrefixAt(t, 0, "(") {
		e := matchClose(t, 0)
		if e < 0 {
			e = len(t)
		}
		first := trimRunes(splitTopLevel(sub(t, 1, e))[0])
		m := reGoNamedPiece.Find(first)
		if m != nil && !goTypeWords[m.S(1)] {
			t = m.R(2)
		} else {
			t = first
		}
	}
	return goTypeNameR(t)
}

// parseGoDecls: top-level Go declarations from masked source: functions and
// methods with receiver, parameter and result types; named types (struct
// fields and embedded types included); package-level constants and variables,
// single or in `( … )` groups. Offsets index `masked`.
func parseGoDecls(d *Decls, masked []rune, lineOf func(int) int) {
	d.GoPackage = ""
	if pm := reGoPackage.Find(masked); pm != nil {
		d.GoPackage = pm.S(1)
	}
	d.GoMethods = nil
	d.GoVars = newOMap[string, *GoVar]() // name -> { type, init }
	n := len(masked)

	addType := func(name string, pos int, rest []rune, restAt int) {
		// generic parameters, then an optional alias `=`
		r, rAt := rest, restAt
		lead := leadSpace(r)
		r = r[lead:]
		rAt += lead
		if hasPrefixAt(r, 0, "[") {
			e := matchClose(masked, rAt)
			// `type A [4]int` is an array type, not generics: generics hold an identifier pair
			if e > 0 && reGoGenerics.Test(sub(masked, rAt, e+1)) {
				rAt = e + 1
				r = sub(masked, rAt, eolAt(masked, rAt))
				l2 := leadSpace(r)
				r = r[l2:]
				rAt += l2
			}
		}
		if hasPrefixAt(r, 0, "=") {
			l3 := leadSpace(r[1:]) + 1
			r = r[l3:]
			rAt += l3
		}
		kind := "type"
		if reGoStruct.Test(r) {
			kind = "struct"
		} else if reGoInterface.Test(r) {
			kind = "interface"
		}
		cls := &Class{Name: name, Line: lineOf(pos), Kind: kind, Fields: newOMap[string, string](), BodyStart: -1, BodyEnd: -1}
		if kind != "type" {
			open := indexRune(masked, '{', rAt)
			closeAt := -1
			if open >= 0 {
				closeAt = matchClose(masked, open)
			}
			if open >= 0 && closeAt > open {
				cls.BodyStart = open
				cls.BodyEnd = closeAt
				cls.End = lineOf(closeAt)
				depth, lineStart := 0, open+1
				for i := open + 1; i <= closeAt; i++ {
					ch := masked[i]
					if ch == '\n' || i == closeAt {
						if depth == 0 {
							ln := trimRunes(sub(masked, lineStart, i))
							if em := reGoEmbed.Find(ln); em != nil {
								cls.Embeds = append(cls.Embeds, em.S(1))
							} else if kind == "struct" {
								if fm := reGoField.Find(ln); fm != nil {
									if t := goTypeNameR(fm.R(2)); t != "" {
										for _, f := range splitStr(fm.S(1), ",") {
											cls.Fields.Set(jsTrim(f), t)
										}
									}
								}
							}
						}
						lineStart = i + 1
					}
					if ch == '{' || ch == '(' {
						depth++
					} else if ch == '}' || ch == ')' {
						depth--
					}
				}
			}
		} else {
			t := goTypeNameR(r)
			if t != "" && !strings.HasPrefix(t, "[]") {
				cls.Underlying = t
			}
		}
		d.Classes = append(d.Classes, cls)
	}

	addValues := func(names string, pos int, rest []rune) {
		var list []string
		for _, s := range splitStr(names, ",") {
			s = jsTrim(s)
			if s != "" && s != "_" {
				list = append(list, s)
			}
		}
		for _, name := range list {
			d.Types = append(d.Types, &TypeDecl{Name: name, Line: lineOf(pos), Kind: "const"})
		}
		if len(list) != 1 {
			return
		}
		eq := indexRune(rest, '=', 0)
		var typeText []rune
		init := ""
		if eq < 0 {
			typeText = trimRunes(rest)
		} else {
			typeText = trimRunes(rest[:eq])
			init = string(trimRunes(rest[eq+1:]))
		}
		typ := ""
		if len(typeText) > 0 {
			typ = goTypeNameR(typeText)
		}
		d.GoVars.Set(list[0], &GoVar{Type: typ, Init: init})
	}

	addFunc := func(pos int) int {
		m := reGoFunc.At(masked, pos)
		if m == nil {
			return pos
		}
		paramsOpen := m.End() - 1
		paramsClose := matchClose(masked, paramsOpen)
		if paramsClose < 0 {
			return pos
		}
		bodyOpen, paren, i, word := -1, 0, paramsClose+1, ""
	scan:
		for ; i < n; i++ {
			ch := masked[i]
			if ch == '(' || ch == '[' {
				paren++
			} else if ch == ')' || ch == ']' {
				paren--
			} else if ch == '{' {
				if word == "interface" || word == "struct" {
					e := matchClose(masked, i)
					if e < 0 {
						break scan
					}
					i = e
					word = ""
					continue
				}
				bodyOpen = i
				break scan
			} else if ch == '\n' && paren <= 0 {
				break scan
			}
			if isIdentChar(ch) {
				if isIdentChar(at(masked, i-1)) {
					word += string(ch)
				} else {
					word = string(ch)
				}
			} else if ch != ' ' && ch != '\t' {
				word = ""
			}
		}
		bodyClose := -1
		if bodyOpen >= 0 {
			bodyClose = matchClose(masked, bodyOpen)
		}
		var end int
		if bodyClose > 0 {
			end = lineOf(bodyClose)
		} else if i < n {
			end = lineOf(i)
		} else {
			end = lineOf(n - 1)
		}
		resultEnd := i
		if bodyOpen >= 0 {
			resultEnd = bodyOpen
		}
		fn := &Func{
			Name: m.S(2), Line: lineOf(pos), End: end,
			Params:    goParams(sub(masked, paramsOpen+1, paramsClose)),
			Result:    goFirstResult(sub(masked, paramsClose+1, resultEnd)),
			DeclStart: pos, BodyStart: bodyOpen, BodyEnd: bodyClose,
		}
		ret := i
		if bodyClose > 0 {
			ret = bodyClose
		}
		if m.Has(1) {
			if rm := reGoRecv.Find(m.R(1)); rm != nil {
				fn.HasRecv = true
				if rm.S(1) != "" && rm.S(1) != "_" {
					fn.RecvName = rm.S(1)
				}
				fn.RecvType = rm.S(2)
				d.GoMethods = append(d.GoMethods, fn)
				return ret
			}
		}
		d.Functions = append(d.Functions, fn)
		return ret
	}

	// Walk line starts at brace depth 0; `group` is the keyword of an open `( … )` block.
	brace, paren, group, prevEnd, paren1Start := 0, 0, "", "", false
	i := 0
	for i < n {
		eol := eolAt(masked, i)
		ln := sub(masked, i, eol)
		skipTo := -1
		if brace == 0 {
			if paren == 0 {
				group = ""
				if reGoLineFunc.Test(ln) {
					skipTo = addFunc(i)
				} else if m := reGoLineType.Find(ln); m != nil {
					addType(m.S(1), i, ln[m.Len():], i+m.Len())
				} else if m := reGoLineGroup.Find(ln); m != nil {
					group = m.S(1)
					paren1Start = true
				} else if m := reGoLineValues.Find(ln); m != nil {
					addValues(m.S(1), i, ln[m.Len():])
				}
			} else if paren == 1 && group != "" {
				if group == "type" {
					if m := reGoGroupType.Find(ln); m != nil {
						addType(m.S(1), i+indexStr(ln, m.S(1), 0), ln[m.Len():], i+m.Len())
					}
				} else if paren1Start || !reGoContinues.TestS(prevEnd) {
					if m := reGoGroupValues.Find(ln); m != nil {
						addValues(m.S(1), i+indexStr(ln, m.S(1), 0), ln[m.Len():])
					}
				}
			}
		}
		if skipTo > i {
			// a function was consumed up to its closing brace: resume on the next line
			next := indexRune(masked, '\n', skipTo)
			if next < 0 {
				i = n
			} else {
				i = next + 1
			}
			prevEnd = "}"
			continue
		}
		for k := i; k < eol; k++ {
			switch masked[k] {
			case '{':
				brace++
			case '}':
				brace--
			case '(':
				paren++
			case ')':
				paren--
			}
		}
		trimmed := trimEndRunes(ln)
		if len(trimmed) > 0 {
			prevEnd = string(trimmed[len(trimmed)-1])
			if !reGoGroupOpen.Test(trimmed) {
				paren1Start = false
			}
		}
		i = eol + 1
	}
}
