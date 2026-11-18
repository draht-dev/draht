package kg

// ============================================================================
// TypeScript / JavaScript declarations
// ============================================================================

// tsAngles is the index after the `<…>` group opening at `open` (a generic
// parameter or argument list: the `>` of `=>` closes nothing, brackets inside
// are skipped whole), or -1 when it is not one.
func tsAngles(text []rune, open int) int {
	depth := 0
	limit := min(len(text), open+4000)
	for i := open; i < limit; i++ {
		ch := at(text, i)
		if ch == '(' || ch == '[' || ch == '{' {
			e := matchClose(text, i)
			if e < 0 {
				return -1
			}
			i = e
		} else if ch == '<' {
			depth++
		} else if ch == '>' && at(text, i-1) != '=' {
			depth--
			if depth == 0 {
				return i + 1
			}
		} else if ch == ';' || ch == ')' || ch == ']' || ch == '}' {
			return -1
		}
	}
	return -1
}

var (
	tsTypeBracePrev   = runeSet(":|&,(<?[")
	tsTypeWords       = strSet("is", "extends", "keyof", "typeof", "infer", "readonly", "asserts", "in")
	tsLineContinues   = runeSet("+-*/%&|^<>=?:,.([{!~")
	tsContinueWords   = strSet("return", "typeof", "new", "await", "yield", "extends", "in", "of", "instanceof", "as", "satisfies", "void", "delete", "throw", "case", "else")
	tsNextContinues   = runeSet(".?:+*/%&|^<>=,)]")
	tsNextWords       = strSet("as", "satisfies", "instanceof", "in", "extends")
	tsMemberModifiers = strSet("public", "private", "protected", "static", "readonly", "override", "abstract", "async", "declare", "accessor", "get", "set")
	tsNotAName        = strSet("extends", "implements")
)

var (
	reTsBodyTypeWord  = mustRE(`^(?:is|extends|keyof)\b`, "")
	reTsJsxPrev       = mustRE(`[\w"'/}\])]`, "")
	reTsLeadWord      = mustRE(`^[A-Za-z]+`, "")
	reTsAsync         = mustRE(`async\b`, "")
	reTsFnOrClass     = mustRE(`(function|class)\b`, "")
	reTsIdent         = mustRE(`[A-Za-z_$][\w$]*`, "")
	reTsExtends       = mustRE(`\bextends\s+([A-Za-z_$][\w$.]*)`, "")
	reTsImplements    = mustRE(`\bimplements\s+([\s\S]+)$`, "")
	reTsMemberIdent   = mustRE(`#?[A-Za-z_$][\w$]*`, "")
	reTsFieldType     = mustRE(`^\s*(?:readonly\s+)?([A-Za-z_$][\w$.]*)`, "")
	reTsFieldNew      = mustRE(`^\s*new\s+([A-Za-z_$][\w$.]*)`, "")
	reTsRequired      = mustRE(`^\s*(?:await\s+)?(?:require|import)\s*\(`, "")
	reTsDefault       = mustRE(`\bdefault\b`, "")
	reTsTopClass      = mustRE(`^(\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?)class\b\s*([A-Za-z_$][\w$]*)?`, "")
	reTsTopFunction   = mustRE(`^(\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?)function\b\s*\*?\s*([A-Za-z_$][\w$]*)?`, "")
	reTsTopVariable   = mustRE(`^(\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+)([A-Za-z_$][\w$]*)`, "")
	reTsTopIfaceEnum  = mustRE(`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:const\s+)?(interface|enum)\s+([A-Za-z_$][\w$]*)`, "")
	reTsIfaceExtends  = mustRE(`\bextends\s+([\s\S]+)$`, "")
	reTsTopType       = mustRE(`^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<|=|$)`, "")
	reTsTopNamespace  = mustRE(`^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{`, "")
	reTsTopGlobal     = mustRE(`^\s*declare\s+(global)\s*\{`, "")
	reTsNonSpace      = mustRE(`\S`, "")
	reTsExportDefault = mustRE(`^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$`, "")
	reTsModuleExports = mustRE(`^\s*(?:exports\s*=\s*)?module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$`, "")
	reTsExportsMember = mustRE(`^(\s*(?:module\.)?exports\.)([A-Za-z_$][\w$]*)\s*=(?!=)`, "")
	reTsLocalExport   = mustRE(`\bexport\s*\{([^}]*)\}(?!\s*from\b)`, "")
	reTsTypePrefix    = mustRE(`^type\s+`, "")
	reTsExportPiece   = mustRE(`^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$`, "")
	reTsNested        = mustRE(`(?<![\w$.])(?:(function)\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?=[<(])|(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[:=])|(class)\s+([A-Za-z_$][\w$]*)|(type|interface|enum)\s+([A-Za-z_$][\w$]*)\s*(?=[<={]|extends\b))`, "")
)

// tsBody is the result of tsBodyOpen: `{ open }` (isOpen) or `{ end }`.
type tsBody struct {
	open   int
	end    int
	isOpen bool
}

// tsBodyOpen finds where a function's body opens after its parameter list
// closed at `from - 1`: { open } at the body brace, or { end } where a bodiless
// signature ends. A brace that belongs to the return type
// (`): { ok: boolean } {`) is skipped.
func tsBodyOpen(text []rune, from int) tsBody {
	n := len(text)
	prev := ')'
	word := ""
	arrow := false
	for k := from; k < n; k++ {
		ch := at(text, k)
		if ch == ' ' || ch == '\t' || ch == '\r' {
			continue
		}
		if ch == '\n' {
			if tsTypeBracePrev[prev] || arrow || tsTypeWords[word] {
				continue
			}
			q := k + 1
			for q < n && isSpace(text[q]) {
				q++
			}
			if q < n {
				c2 := text[q]
				if c2 == '{' || c2 == '|' || c2 == '&' || c2 == ':' || c2 == '<' || c2 == '=' || c2 == '.' || c2 == '?' || c2 == '[' {
					continue
				}
			}
			if prev == ')' && q >= n {
				return tsBody{end: k}
			}
			if reTsBodyTypeWord.Test(sub(text, q, q+8)) {
				continue
			}
			return tsBody{end: k}
		}
		if ch == '{' {
			if tsTypeBracePrev[prev] || arrow || tsTypeWords[word] {
				e := matchClose(text, k)
				if e < 0 {
					return tsBody{end: n}
				}
				k = e
				prev = '}'
				word = ""
				arrow = false
				continue
			}
			return tsBody{open: k, isOpen: true}
		}
		if ch == '(' || ch == '[' {
			e := matchClose(text, k)
			if e < 0 {
				return tsBody{end: n}
			}
			k = e
			prev = ')'
			word = ""
			arrow = false
			continue
		}
		if ch == '<' {
			e := tsAngles(text, k)
			if e > 0 {
				k = e - 1
				prev = '>'
				word = ""
				arrow = false
				continue
			}
		}
		if ch == ';' {
			return tsBody{end: k}
		}
		if ch == '}' || ch == ')' || ch == ']' {
			return tsBody{end: k - 1}
		}
		if ch == ',' && prev != ')' {
			return tsBody{end: k}
		}
		if ch == '=' && at(text, k+1) == '>' {
			arrow = true
			k++
			prev = '>'
			word = ""
			continue
		}
		arrow = false
		if isIdentChar(ch) {
			if isIdentChar(at(text, k-1)) {
				word += string(ch)
			} else {
				word = string(ch)
			}
		} else {
			word = ""
		}
		prev = ch
	}
	return tsBody{end: n}
}

// tsExprEnd is the end (exclusive of the terminator) of the expression that
// starts at `from`: its `;`, a top-level `,`, the bracket that closes the
// enclosing construct, or the line break after which a new statement begins.
func tsExprEnd(text []rune, from int) int {
	n := len(text)
	var prev rune // 0: "" (nothing yet)
	word := ""
	for k := from; k < n; k++ {
		ch := at(text, k)
		if ch == ' ' || ch == '\t' || ch == '\r' {
			continue
		}
		if ch == '(' || ch == '[' || ch == '{' {
			e := matchClose(text, k)
			if e < 0 {
				return n
			}
			k = e
			prev = ')'
			word = ""
			continue
		}
		if ch == ';' || ch == ',' {
			return k
		}
		if ch == ')' || ch == ']' || ch == '}' {
			return k
		}
		if ch == '\n' {
			jsxClose := false
			if prev == '>' && k >= 2 && at(text, k-1) == '>' {
				jsxClose = reTsJsxPrev.Test(sub(text, k-2, k-1))
			}
			if prev == 0 || (tsLineContinues[prev] && !jsxClose) || tsContinueWords[word] {
				continue
			}
			q := k + 1
			for q < n && isSpace(text[q]) {
				q++
			}
			if q >= n {
				return k
			}
			if tsNextContinues[text[q]] && !(text[q] == '/' && at(text, q+1) == '/') {
				continue
			}
			if nw := reTsLeadWord.Find(sub(text, q, q+12)); nw != nil && tsNextWords[nw.S(0)] {
				continue
			}
			return k
		}
		if isIdentChar(ch) {
			if isIdentChar(at(text, k-1)) {
				word += string(ch)
			} else {
				word = string(ch)
			}
		} else {
			word = ""
		}
		prev = ch
	}
	return n
}

// tsFnInit is the result of tsFunctionInit: { kind, open, close, header? }.
type tsFnInit struct {
	kind   string // "function", "class", "arrow"
	open   int
	close  int
	header []rune // class only
}

// tsFunctionInit is the function or class an initializer is, when it is one:
// `(a) => …`, `async <T>(a: T): R => …`, `x => …`, `function (…) {…}`,
// `class {…}`. Returns { kind, open, close } with the body's braces (close =
// the end of a brace-less arrow body, open = -1), or nil.
func tsFunctionInit(text []rune, from int) *tsFnInit {
	n := len(text)
	k := from
	skipWs := func() {
		for k < n && isSpace(text[k]) {
			k++
		}
	}
	skipWs()
	if m := reTsAsync.At(text, k); m != nil {
		save := k
		k = m.End()
		skipWs()
		if c := at(text, k); c == '=' || c == ';' || c == ',' || c == ')' {
			k = save
		}
	}
	kw := reTsFnOrClass.At(text, k)
	if kw != nil && kw.S(1) == "function" {
		open := indexRune(text, '(', kw.End())
		pc := -1
		if open >= 0 {
			pc = matchClose(text, open)
		}
		if pc < 0 {
			return nil
		}
		b := tsBodyOpen(text, pc+1)
		close := -1
		if b.isOpen {
			close = matchClose(text, b.open)
		}
		if close > 0 {
			return &tsFnInit{kind: "function", open: b.open, close: close}
		}
		return nil
	}
	if kw != nil && kw.S(1) == "class" {
		b := tsClassBody(text, kw.End())
		if b == nil {
			return nil
		}
		return &tsFnInit{kind: "class", open: b.open, close: b.close, header: sub(text, kw.End(), b.open)}
	}
	if at(text, k) == '<' {
		e := tsAngles(text, k)
		if e < 0 {
			return nil
		}
		k = e
		skipWs()
		if at(text, k) != '(' {
			return nil
		}
	}
	arrowAt := -1
	if at(text, k) == '(' {
		pc := matchClose(text, k)
		if pc < 0 {
			return nil
		}
		k = pc + 1
		skipWs()
		if at(text, k) == '=' && at(text, k+1) == '>' {
			arrowAt = k
		} else if at(text, k) == ':' {
			// a return type, then the arrow
		scan:
			for q := k + 1; q < n; q++ {
				ch := text[q]
				switch {
				case ch == '(' || ch == '[' || ch == '{':
					e := matchClose(text, q)
					if e < 0 {
						return nil
					}
					q = e
				case ch == '<':
					if e := tsAngles(text, q); e > 0 {
						q = e - 1
					}
				case ch == '=' && at(text, q+1) == '>':
					arrowAt = q
					break scan
				case ch == ';' || ch == ')' || ch == ']' || ch == '}' || (ch == '=' && at(text, q+1) != '='):
					return nil
				}
			}
		}
	} else {
		m := reTsIdent.At(text, k)
		if m == nil {
			return nil
		}
		k = m.End()
		skipWs()
		if at(text, k) == '=' && at(text, k+1) == '>' {
			arrowAt = k
		}
	}
	if arrowAt < 0 {
		return nil
	}
	k = arrowAt + 2
	skipWs()
	if at(text, k) == '{' {
		close := matchClose(text, k)
		if close > 0 {
			return &tsFnInit{kind: "arrow", open: k, close: close}
		}
		return nil
	}
	return &tsFnInit{kind: "arrow", open: -1, close: tsExprEnd(text, k)}
}

// tsBraces is the result of tsClassBody: { open, close }.
type tsBraces struct {
	open  int
	close int
}

// tsClassBody is the body braces of a class whose name (or `class` keyword)
// ends at `from`.
func tsClassBody(text []rune, from int) *tsBraces {
	n := len(text)
	for k := from; k < n; k++ {
		ch := at(text, k)
		if ch == '(' || ch == '[' {
			e := matchClose(text, k)
			if e < 0 {
				return nil
			}
			k = e
		} else if ch == '<' {
			if e := tsAngles(text, k); e > 0 {
				k = e - 1
			}
		} else if ch == '{' {
			close := matchClose(text, k)
			if close > 0 {
				return &tsBraces{open: k, close: close}
			}
			return nil
		} else if ch == ';' || ch == '}' || ch == ')' {
			return nil
		}
	}
	return nil
}

// tsClassHeritage is the `extends` / `implements` of a class header (the text
// between its name and body).
func tsClassHeritage(header []rune) (extends string, implements []string) {
	h := header
	lead := leadSpace(h)
	if at(h, lead) == '<' {
		if e := tsAngles(h, lead); e > 0 {
			h = sub(h, e, len(h))
		}
	}
	if ext := reTsExtends.Find(h); ext != nil {
		extends = splitStr(ext.S(1), ".")[0]
	}
	implText := ""
	if impl := reTsImplements.Find(h); impl != nil {
		implText = impl.S(1)
	}
	return extends, implementsList(implText)
}

func tsIsWordChar(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

// tsClassMembers records the members of a class body (between its braces):
// methods, the constructor, accessors, `#private` names and function-valued
// properties. A word followed by `(` at member position is a method header
// whatever the word is (`delete(id) {`, `get() {`); statements cannot occur
// there.
func tsClassMembers(cls *Class, text []rune, from, to int, lineOf func(int) int) {
	identRe := reTsMemberIdent
	blank := func(c rune) bool { return c == ' ' || c == '\t' }
	i := from
	for i < to {
		ch := at(text, i)
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == ';' || ch == ',' {
			i++
			continue
		}
		if ch == '@' { // decorator
			k := i + 1
			if w := identRe.At(text, i+1); w != nil {
				k = w.End()
			}
			for at(text, k) == '.' {
				w := identRe.At(text, k+1)
				if w == nil {
					break
				}
				k = w.End()
			}
			if at(text, k) == '(' {
				e := matchClose(text, k)
				if e < 0 {
					k = to
				} else {
					k = e + 1
				}
			}
			i = k
			continue
		}
		// modifiers, then the name
		name, hasName := "", false
		nameAt, k, accessor := i, i, false
		for {
			for k < to && (text[k] == ' ' || text[k] == '\t' || text[k] == '\n' || text[k] == '\r') {
				k++
			}
			if at(text, k) == '*' {
				k++
				continue
			}
			w := identRe.At(text, k)
			if w == nil {
				break
			}
			q := w.End()
			for q < to && blank(text[q]) {
				q++
			}
			next := at(text, q)
			w0 := w.S(0)
			startsName := next == '#' || next == '[' || next == '"' || next == '\'' || next == '*' || (q < len(text) && isIdentChar(next)) || (next == '\n' && (w0 == "static" || w0 == "async"))
			if tsMemberModifiers[w0] && startsName {
				if w0 == "get" || w0 == "set" || w0 == "accessor" {
					accessor = true
				}
				k = w.End()
				continue
			}
			name, hasName = w0, true
			nameAt = k
			k = w.End()
			break
		}
		if !hasName {
			c := at(text, k)
			if c == '{' { // static block
				e := matchClose(text, k)
				if e < 0 {
					i = to
				} else {
					i = e + 1
				}
				continue
			}
			if c == '[' || c == '"' || c == '\'' { // computed or quoted name: not indexed
				var e int
				if c == '[' {
					e = matchClose(text, k)
				} else {
					e = indexRune(text, c, k+1)
				}
				if e < 0 {
					k = to
				} else {
					k = e + 1
				}
			} else if c >= '0' && c <= '9' {
				for k < to && (tsIsWordChar(text[k]) || text[k] == '.') {
					k++
				}
			} else {
				i = k + 1
				continue
			}
		}
		for k < to && blank(text[k]) {
			k++
		}
		if c := at(text, k); c == '?' || c == '!' {
			k++
		}
		for k < to && blank(text[k]) {
			k++
		}
		open := k
		if at(text, open) == '<' {
			if e := tsAngles(text, open); e > 0 {
				open = e
				for open < to && isSpace(text[open]) {
					open++
				}
			}
		}
		if at(text, open) == '(' {
			pc := matchClose(text, open)
			if pc < 0 {
				return
			}
			b := tsBodyOpen(text, pc+1)
			close := -1
			if b.isOpen {
				close = matchClose(text, b.open)
			}
			if b.isOpen && close <= 0 {
				// JS: `Math.min(b.end, to)` with b.end undefined is NaN, so
				// the method ends at lineOf(NaN) = 1 and `i = NaN + 1` ends
				// the member loop.
				if hasName {
					addMethod(cls, &Func{Name: name, Line: lineOf(nameAt), End: 1, BodyStart: -1, BodyEnd: close})
				}
				return
			}
			end := close
			if close <= 0 {
				end = min(b.end, to)
			}
			if hasName {
				bodyStart := -1
				if close > 0 {
					bodyStart = b.open
				}
				addMethod(cls, &Func{Name: name, Line: lineOf(nameAt), End: lineOf(min(end, len(text)-1)), BodyStart: bodyStart, BodyEnd: close})
			}
			i = end + 1
			continue
		}
		// a property: its type annotation, then an initializer that may be a function
		eq, stop := -1, to
	scan:
		for q := k; q < to; q++ {
			c := at(text, q)
			if c == '(' || c == '[' || c == '{' {
				e := matchClose(text, q)
				if e < 0 {
					stop = to
					break scan
				}
				q = e
			} else if c == '<' {
				if e := tsAngles(text, q); e > 0 {
					q = e - 1
				}
			} else if c == '=' && at(text, q+1) == '>' {
				q++
			} else if c == '=' {
				eq = q
				break scan
			} else if c == ';' || c == '}' {
				stop = q
				break scan
			} else if c == '\n' {
				p := q - 1
				for p > k && (at(text, p) == ' ' || at(text, p) == '\t' || at(text, p) == '\r') {
					p--
				}
				nx := q + 1
				for nx < to && isSpace(text[nx]) {
					nx++
				}
				cn := at(text, nx)
				if !(p >= 0 && p < len(text) && tsTypeBracePrev[text[p]]) && !(at(text, p) == '>' && at(text, p-1) == '=') && cn != '|' && cn != '&' && cn != '=' && cn != '?' && cn != ':' {
					stop = q
					break scan
				}
			}
		}
		if hasName && at(text, k) == ':' {
			typeEnd := eq
			if eq < 0 {
				typeEnd = stop
			}
			if tm := reTsFieldType.Find(sub(text, k+1, typeEnd)); tm != nil {
				if cls.Fields == nil {
					cls.Fields = newOMap[string, string]()
				}
				cls.Fields.Set(name, tm.S(1))
			}
		}
		if eq < 0 {
			i = stop + 1
			continue
		}
		if hasName && !cls.Fields.Has(name) {
			if nm := reTsFieldNew.Find(sub(text, eq+1, eq+200)); nm != nil {
				if cls.Fields == nil {
					cls.Fields = newOMap[string, string]()
				}
				cls.Fields.Set(name, nm.S(1))
			}
		}
		var fn *tsFnInit
		if !accessor {
			fn = tsFunctionInit(text, eq+1)
		}
		if fn != nil && fn.kind != "class" {
			if hasName {
				addMethod(cls, &Func{Name: name, Line: lineOf(nameAt), End: lineOf(min(fn.close, len(text)-1)), BodyStart: fn.open, BodyEnd: fn.close, Property: true})
			}
			i = fn.close + 1
		} else {
			i = tsExprEnd(text, eq+1) + 1
		}
	}
}

// tsVar is the result of variableAt: the kind of `const name …`.
type tsVar struct {
	kind     string // "function", "class", "const"
	open     int
	close    int
	header   []rune
	required bool
}

// parseTsDecls reads the declarations of a TS/JS module from masked source.
// Top level: classes (class expressions bound to a variable included),
// functions, function-valued variables, other variables, interfaces, enums,
// type aliases, namespaces. Below top level: named functions, function-valued
// variables, classes and types declared inside function bodies and callbacks
// (`d.nested`).
func parseTsDecls(d *Decls, masked []rune, lineOf func(int) int, lang string) {
	n := len(masked)
	d.Nested = []Nested{}
	d.CjsFunctions = []*Func{}
	d.LocalExports = []LocalExport{} // `export { a as b }` without a source
	d.DefaultName = ""               // `export default name`
	total := func() int { return len(d.Classes) + len(d.Functions) + len(d.Types) }
	addClass := func(name string, at, bodyOpen, bodyClose int, header []rune, isDefault bool) *Class {
		ext, impl := tsClassHeritage(header)
		cls := &Class{Name: name, Line: lineOf(at), End: lineOf(bodyClose), IsDefault: isDefault, Extends: ext, Implements: impl, BodyStart: bodyOpen, BodyEnd: bodyClose}
		d.Classes = append(d.Classes, cls)
		tsClassMembers(cls, masked, bodyOpen+1, bodyClose, lineOf)
		return cls
	}
	functionAt := func(declAt, afterKeyword int, name string, isDefault bool) {
		k := afterKeyword
		for k < n && isSpace(masked[k]) {
			k++
		}
		if at(masked, k) == '<' {
			if e := tsAngles(masked, k); e > 0 {
				k = e
			}
		}
		open := indexRune(masked, '(', k)
		pc := -1
		if open >= 0 {
			pc = matchClose(masked, open)
		}
		if pc < 0 {
			return
		}
		b := tsBodyOpen(masked, pc+1)
		close := -1
		if b.isOpen {
			close = matchClose(masked, b.open)
		}
		var end int
		switch {
		case close > 0:
			end = lineOf(min(close, n-1))
		case b.isOpen:
			end = 1 // JS: b.end is undefined, Math.min gives NaN, lineOf(NaN) = 1
		default:
			end = lineOf(min(b.end, n-1))
		}
		bodyStart := -1
		if close > 0 {
			bodyStart = b.open
		}
		d.Functions = append(d.Functions, &Func{Name: name, Line: lineOf(declAt), End: end, IsDefault: isDefault, BodyStart: bodyStart, BodyEnd: close})
	}
	// The `=` that starts a variable's initializer, after an optional type annotation.
	initializerAt := func(from int) int {
		for q := from; q < n; q++ {
			c := masked[q]
			if c == '(' || c == '[' || c == '{' {
				e := matchClose(masked, q)
				if e < 0 {
					return -1
				}
				q = e
			} else if c == '<' {
				if e := tsAngles(masked, q); e > 0 {
					q = e - 1
				}
			} else if c == '=' && at(masked, q+1) == '>' {
				q++
			} else if c == '=' {
				return q
			} else if c == ';' || c == '}' || c == ')' || c == ',' {
				return -1
			} else if c == '\n' && at(masked, from) != ':' {
				return -1
			}
		}
		return -1
	}
	// kind of `const name …`: { kind: "function" | "class" | "const", … }
	variableAt := func(nameEnd int) tsVar {
		k := nameEnd
		for k < n && (masked[k] == ' ' || masked[k] == '\t') {
			k++
		}
		if at(masked, k) == '!' {
			k++
		}
		eq := -1
		if at(masked, k) == '=' && at(masked, k+1) != '=' && at(masked, k+1) != '>' {
			eq = k
		} else if at(masked, k) == ':' {
			eq = initializerAt(k)
		}
		if eq < 0 {
			return tsVar{kind: "const", required: false}
		}
		if fn := tsFunctionInit(masked, eq+1); fn != nil {
			if fn.kind == "class" {
				return tsVar{kind: "class", open: fn.open, close: fn.close, header: fn.header}
			}
			return tsVar{kind: "function", open: fn.open, close: fn.close}
		}
		return tsVar{kind: "const", required: reTsRequired.Test(sub(masked, eq+1, eq+40))}
	}

	// -- top level: lines that start a declaration outside every bracket
	brace, paren, i := 0, 0, 0
	for i < n && total() < maxSymbolsPerFile {
		eol := eolAt(masked, i)
		if brace == 0 && paren == 0 {
			ln := sub(masked, i, eol)
			func() {
				// every pattern below starts with one of these words: skip the rest
				if !tsTopWords[tsLeadWord(ln)] {
					return
				}
				if m := reTsTopClass.Find(ln); m != nil && (m.S(2) != "" || reTsDefault.TestS(m.S(1))) {
					named := m.S(2) != "" && !tsNotAName[m.S(2)]
					after := i + m.Stop(1) + 5
					if named {
						after = i + m.Len()
					}
					if b := tsClassBody(masked, after); b != nil {
						name := "default"
						if named {
							name = m.S(2)
						}
						addClass(name, i+m.Stop(1), b.open, b.close, sub(masked, after, b.open), reTsDefault.TestS(m.S(1)))
					}
					return
				}
				if m := reTsTopFunction.Find(ln); m != nil && (m.S(2) != "" || reTsDefault.TestS(m.S(1))) {
					name := m.S(2)
					if name == "" {
						name = "default"
					}
					functionAt(i+m.Stop(1), i+m.Len(), name, reTsDefault.TestS(m.S(1)))
					return
				}
				if m := reTsTopVariable.Find(ln); m != nil {
					declAt := i + m.Stop(1)
					v := variableAt(i + m.Len())
					if v.kind == "function" {
						d.Functions = append(d.Functions, &Func{Name: m.S(2), Line: lineOf(declAt), End: lineOf(min(v.close, n-1)), BodyStart: v.open, BodyEnd: v.close})
					} else if v.kind == "class" {
						addClass(m.S(2), declAt, v.open, v.close, v.header, false)
					} else if !v.required {
						d.Types = append(d.Types, &TypeDecl{Name: m.S(2), Line: lineOf(declAt), Kind: "const"})
					}
					return
				}
				if m := reTsTopIfaceEnum.Find(ln); m != nil {
					t := &TypeDecl{Name: m.S(2), Line: lineOf(i + indexStr(ln, m.S(1), 0)), Kind: m.S(1)}
					if m.S(1) == "interface" {
						b := tsClassBody(masked, i+m.Len())
						var header []rune
						if b != nil {
							header = sub(masked, i+m.Len(), b.open)
						}
						lead := leadSpace(header)
						if at(header, lead) == '<' {
							if e := tsAngles(header, lead); e > 0 {
								header = sub(header, e, len(header))
							}
						}
						extText := ""
						if em := reTsIfaceExtends.Find(header); em != nil {
							extText = em.S(1)
						}
						t.ExtendsAll = implementsList(extText)
						if len(t.ExtendsAll) > 0 {
							t.Extends = t.ExtendsAll[0]
						}
					}
					d.Types = append(d.Types, t)
					return
				}
				if m := reTsTopType.Find(ln); m != nil {
					d.Types = append(d.Types, &TypeDecl{Name: m.S(1), Line: lineOf(i + indexStr(ln, "type", 0)), Kind: "type"})
					return
				}
				m := reTsTopNamespace.Find(ln)
				if m == nil {
					m = reTsTopGlobal.Find(ln)
				}
				if m != nil {
					d.Types = append(d.Types, &TypeDecl{Name: m.S(1), Line: lineOf(i + reTsNonSpace.Search(ln)), Kind: "namespace"})
					return
				}
				m = reTsExportDefault.Find(ln)
				if m == nil {
					m = reTsModuleExports.Find(ln)
				}
				if m != nil {
					d.DefaultName = m.S(1)
					return
				}
				if m := reTsExportsMember.Find(ln); m != nil {
					// `exports.name = function …` declares `name` when nothing else does
					fn := tsFunctionInit(masked, i+m.Len())
					if fn != nil && fn.kind != "class" {
						d.CjsFunctions = append(d.CjsFunctions, &Func{Name: m.S(2), Line: lineOf(i + m.Stop(1)), End: lineOf(min(fn.close, n-1)), BodyStart: fn.open, BodyEnd: fn.close})
					}
				}
			}()
		}
		for k := i; k < eol; k++ {
			switch masked[k] {
			case '{':
				brace++
			case '}':
				brace--
			case '(', '[':
				paren++
			case ')', ']':
				paren--
			}
		}
		i = eol + 1
	}
	for _, fn := range d.CjsFunctions {
		taken := false
		for _, f := range d.Functions {
			if f.Name == fn.Name {
				taken = true
				break
			}
		}
		for _, c := range d.Classes {
			if taken {
				break
			}
			taken = c.Name == fn.Name
		}
		for _, t := range d.Types {
			if taken {
				break
			}
			taken = t.Name == fn.Name
		}
		if !taken {
			d.Functions = append(d.Functions, fn)
		}
	}
	for em := range reTsLocalExport.Iter(masked, 0) {
		for _, piece := range splitStr(em.S(1), ",") {
			pm := reTsExportPiece.FindS(reTsTypePrefix.ReplaceFirstLit(jsTrim(piece), ""))
			if pm != nil {
				exported := pm.S(2)
				if exported == "" {
					exported = pm.S(1)
				}
				d.LocalExports = append(d.LocalExports, LocalExport{Local: pm.S(1), Exported: exported})
			}
		}
	}

	// -- below top level
	depthAt := make([]int32, n+1)
	{
		var depth int32
		for k := 0; k < n; k++ {
			depthAt[k] = depth
			if masked[k] == '{' {
				depth++
			} else if masked[k] == '}' {
				depth--
			}
		}
		depthAt[n] = depth
	}
	for nm := range reTsNested.Iter(masked, 0) {
		if len(d.Nested) >= maxSymbolsPerFile {
			break
		}
		if depthAt[nm.Index()] == 0 {
			continue
		}
		line := lineOf(nm.Index())
		if nm.S(1) != "" {
			d.Nested = append(d.Nested, Nested{Name: nm.S(2), Kind: "function", Line: line})
		} else if nm.S(3) != "" {
			v := variableAt(nm.Index() + nm.Len())
			if v.kind == "function" {
				d.Nested = append(d.Nested, Nested{Name: nm.S(4), Kind: "function", Line: line})
			} else if v.kind == "class" {
				d.Nested = append(d.Nested, Nested{Name: nm.S(4), Kind: "class", Line: line})
			}
		} else if nm.S(5) != "" {
			if tsNotAName[nm.S(6)] {
				continue
			}
			d.Nested = append(d.Nested, Nested{Name: nm.S(6), Kind: "class", Line: line})
			if b := tsClassBody(masked, nm.Index()+nm.Len()); b != nil {
				inner := &Class{}
				tsClassMembers(inner, masked, b.open+1, b.close, lineOf)
				for _, meth := range inner.Methods {
					d.Nested = append(d.Nested, Nested{Name: meth.Name, Kind: "function", Line: meth.Line})
				}
			}
		} else if lang == "typescript" {
			d.Nested = append(d.Nested, Nested{Name: nm.S(8), Kind: nm.S(7), Line: line})
		}
	}
}

// The words a top-level declaration line can start with (after leading
// blanks): the first keyword alternatives of every reTsTop… pattern,
// reTsExportDefault, reTsModuleExports and reTsExportsMember.
var tsTopWords = strSet(
	"export", "default", "declare", "abstract", "class", "async", "function", "const", "let", "var",
	"interface", "enum", "type", "namespace", "module", "exports",
)

// tsLeadWord is the run of ASCII letters a line starts with, after blanks.
func tsLeadWord(ln []rune) string {
	i := leadSpace(ln)
	j := i
	for j < len(ln) && ((ln[j] >= 'a' && ln[j] <= 'z') || (ln[j] >= 'A' && ln[j] <= 'Z')) {
		j++
	}
	return string(ln[i:j])
}
