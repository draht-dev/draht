package kg

import "strings"

// ============================================================================
// Source masking — ONE lexer pass (comments, strings, templates, regex literals)
// ============================================================================

// Keywords after which a `/` starts a regex literal instead of dividing.
var regexPrevWords = strSet(
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
	"case", "do", "else", "yield", "await",
)

// Punctuation after which an expression may start (so `/` opens a regex).
var regexPrevChars = runeSet("(,=:[!&|?{;")

// maskSource: comments and string/regex/template TEXT become spaces — same
// length, same line breaks — so offsets, line numbers and indentation survive.
// Quote delimiters stay, and so does the code inside a template's `${ … }`
// (nested templates included). One pass decides what each character is: a
// `"src/*"` string cannot open a comment, a backtick inside a string or regex
// cannot open a template, and a `//` in a URL string is not a comment, which
// separate comment-then-string passes cannot guarantee across lines.
// Python: `#` comments and ”' / """ strings. Go: raw backtick strings and
// runes. Rust: nested block comments, raw strings, chars (a lifetime `'a` is
// not one). When `multiline` is non-nil, start / end offset pairs of
// multi-line (triple-quoted) strings are appended to it.
func maskSource(src []rune, lang string, multiline *[]int) []rune {
	js, py, isGo, rust := tsLike(lang), lang == "python", lang == "go", lang == "rust"
	n := len(src)
	// The JS collects untouched and blanked pieces and joins them; the ranges
	// are blanked in increasing order, so blanking a copy in place is the same.
	out := make([]rune, n)
	copy(out, src)
	blank := func(a, b int) {
		if b > n {
			b = n
		}
		if a < 0 {
			a = 0
		}
		for k := a; k < b; k++ {
			if c := out[k]; c != '\r' && c != '\n' {
				out[k] = ' '
			}
		}
	}
	eol := func(from int) int { return eolAt(src, from) }
	var tplDepth []int // brace depth inside each open `${ … }`
	sig := -1          // index of the last significant code character

	// Opening quote at `start`; returns the index after the closing quote.
	// An unterminated single-line string ends at its line break.
	scanString := func(start int, quote rune, multi bool) int {
		j := start + 1
		for j < n {
			ch := src[j]
			if ch == '\\' {
				if at(src, j+1) == '\r' && at(src, j+2) == '\n' {
					j += 3
				} else {
					j += 2
				}
				continue
			}
			if ch == quote {
				blank(start+1, j)
				return j + 1
			}
			if ch == '\n' && !multi {
				break
			}
			j++
		}
		j = min(j, n)
		blank(start+1, j)
		return j
	}
	scanPyString := func(start int, quote rune) int {
		if at(src, start+1) != quote || at(src, start+2) != quote {
			return scanString(start, quote, false)
		}
		j := start + 3
		for j < n {
			if src[j] == '\\' {
				j += 2
				continue
			}
			if src[j] == quote && at(src, j+1) == quote && at(src, j+2) == quote {
				blank(start+3, j)
				if multiline != nil {
					*multiline = append(*multiline, start, j+3)
				}
				return j + 3
			}
			j++
		}
		blank(start+3, n)
		if multiline != nil {
			*multiline = append(*multiline, start, n)
		}
		return n
	}
	scanRaw := func(start int, closing string) int {
		e := indexStr(src, closing, start+1)
		end := e
		if e < 0 {
			end = n
		}
		blank(start+1, end)
		if e < 0 {
			return n
		}
		return e + len(closing)
	}
	// Go rune / Rust char literal; -1 when the quote is not one (a Rust lifetime).
	scanChar := func(start int) int {
		if at(src, start+1) == '\\' {
			e := indexRune(src, '\'', start+3)
			if e > 0 && e-start <= 12 && indexRune(sub(src, start, e), '\n', 0) < 0 {
				return e + 1
			}
			return -1
		}
		// One rune is one character here (the JS skips a surrogate pair).
		closeAt := start + 2
		if at(src, closeAt) == '\'' && at(src, start+1) != '\n' {
			return closeAt + 1
		}
		return -1
	}
	scanBlock := func(start int) int {
		depth, j := 1, start+2
		for j < n && depth != 0 {
			if rust && src[j] == '/' && at(src, j+1) == '*' {
				depth++
				j += 2
			} else if src[j] == '*' && at(src, j+1) == '/' {
				depth--
				j += 2
			} else {
				j++
			}
		}
		j = min(j, n)
		blank(start, j)
		return j
	}
	// Template text from `from` (after the opening backtick or a closing `}`)
	// up to the closing backtick or the next `${`.
	scanTemplate := func(from int) int {
		j := from
		for j < n {
			ch := src[j]
			if ch == '\\' {
				j += 2
				continue
			}
			if ch == '`' {
				blank(from, j)
				sig = j
				return j + 1
			}
			if ch == '$' && at(src, j+1) == '{' {
				blank(from, j+2)
				tplDepth = append(tplDepth, 0)
				return j + 2
			}
			j++
		}
		blank(from, n)
		return n
	}
	regexAllowed := func(pos int) bool {
		k := pos - 1
		for k >= 0 && (src[k] == ' ' || src[k] == '\t') {
			k--
		}
		if k < 0 || src[k] == '\n' || src[k] == '\r' {
			return true // first token on its line
		}
		if sig < 0 {
			return true
		}
		p := at(src, sig)
		if isIdentChar(p) {
			s := sig
			for s > 0 && isIdentChar(src[s-1]) {
				s--
			}
			return regexPrevWords[str(src, s, sig+1)]
		}
		if p == '>' {
			return at(src, sig-1) == '=' // `=>`
		}
		return regexPrevChars[p]
	}
	// Regex literal opening at `start`; returns the index after its flags, or
	// -1 when the line has no closing slash (so it was a division).
	scanRegex := func(start int) int {
		j, inClass := start+1, false
		for j < n {
			ch := src[j]
			if ch == '\n' {
				return -1
			}
			if ch == '\\' {
				j += 2
				continue
			}
			if inClass {
				if ch == ']' {
					inClass = false
				}
			} else if ch == '[' {
				inClass = true
			} else if ch == '/' {
				if j == start+1 {
					return -1
				}
				blank(start+1, j)
				e := j + 1
				for e < n && ((src[e] >= 'A' && src[e] <= 'Z') || (src[e] >= 'a' && src[e] <= 'z')) {
					e++
				}
				return e
			}
			j++
		}
		return -1
	}

	i := 0
	if hasPrefixAt(src, 0, "#!") {
		i = eol(0)
		blank(0, i)
	}
	for i < n {
		c := src[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		if isIdentChar(c) {
			j := i + 1
			for j < n && isIdentChar(src[j]) {
				j++
			}
			if rust && (at(src, j) == '"' || at(src, j) == '#') &&
				((j-i == 1 && src[i] == 'r') || (j-i == 2 && src[i] == 'b' && src[i+1] == 'r')) {
				h := j
				for at(src, h) == '#' {
					h++
				}
				if at(src, h) == '"' {
					i = scanRaw(h, `"`+strings.Repeat("#", h-j))
					sig = h
					continue
				}
			}
			sig = j - 1
			i = j
			continue
		}
		switch {
		case c == '/' && !py:
			d := at(src, i+1)
			if d == '/' {
				e := eol(i)
				blank(i, e)
				i = e
				continue
			}
			if d == '*' {
				i = scanBlock(i)
				continue
			}
			if js && regexAllowed(i) {
				e := scanRegex(i)
				if e > 0 {
					sig = i
					i = e
					continue
				}
			}
		case py && c == '#':
			e := eol(i)
			blank(i, e)
			i = e
			continue
		case c == '"' || (c == '\'' && !rust && !isGo):
			start := i
			if py {
				i = scanPyString(i, c)
			} else {
				i = scanString(i, c, rust)
			}
			sig = start
			continue
		case c == '\'' && (rust || isGo):
			e := scanChar(i)
			if e > 0 {
				blank(i+1, e-1)
				sig = i
				i = e
				continue
			}
		case c == '`' && js:
			i = scanTemplate(i + 1)
			continue
		case c == '`' && isGo:
			start := i
			i = scanRaw(i, "`")
			sig = start
			continue
		case js && len(tplDepth) > 0 && (c == '{' || c == '}'):
			if c == '{' {
				tplDepth[len(tplDepth)-1]++
			} else if tplDepth[len(tplDepth)-1] == 0 {
				tplDepth = tplDepth[:len(tplDepth)-1]
				blank(i, i+1)
				i = scanTemplate(i + 1)
				continue
			} else {
				tplDepth[len(tplDepth)-1]--
			}
		}
		sig = i
		i++
	}
	return out
}

var reTsTypeDecl = mustRE(`^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(interface|type)\s+[A-Za-z_$][\w$]*`, "m")

// typeDeclRanges: offset ranges of interface bodies and type-alias right-hand
// sides in masked TypeScript. Calls cannot occur there, so their member
// signatures (`save(): number;`) must not be scanned as call sites.
func typeDeclRanges(masked []rune) [][2]int {
	n := len(masked)
	var ranges [][2]int
	pos := 0 // declRe.lastIndex
	for {
		m := execTsTypeDecl(masked, pos)
		if m == nil {
			break
		}
		pos = m.End()
		j := pos
		// Generic parameters and heritage clauses may hold braces and `=>`.
		angle := 0
		if m.S(1) == "interface" {
			for ; j < n; j++ {
				ch := masked[j]
				if ch == '<' {
					angle++
				} else if ch == '>' && at(masked, j-1) != '=' {
					angle = max(0, angle-1)
				} else if (ch == '{' && angle == 0) || ch == ';' {
					break
				}
			}
			if at(masked, j) != '{' {
				continue
			}
			depth, k := 0, j
			for ; k < n; k++ {
				if masked[k] == '{' {
					depth++
				} else if masked[k] == '}' {
					depth--
					if depth == 0 {
						break
					}
				}
			}
			ranges = append(ranges, [2]int{j + 1, min(k, n)})
			pos = max(pos, min(k, n))
			continue
		}
		for ; j < n; j++ {
			ch := masked[j]
			if ch == '<' {
				angle++
			} else if ch == '>' && at(masked, j-1) != '=' {
				angle = max(0, angle-1)
			} else if angle == 0 && !isSpace(ch) {
				break
			}
		}
		if at(masked, j) != '=' {
			continue
		}
		j++
		rhs := j
		depth := 0
	scan:
		for ; j < n; j++ {
			ch := masked[j]
			switch {
			case ch == '(' || ch == '[' || ch == '{' || ch == '<':
				depth++
			case ch == ')' || ch == ']' || ch == '}':
				depth--
				if depth < 0 {
					break scan
				}
			case ch == '>':
				if at(masked, j-1) != '=' {
					depth = max(0, depth-1)
				}
			case ch == ';' && depth == 0:
				break scan
			case ch == '\n' && depth == 0:
				// A line break ends the alias unless the type visibly goes on.
				p := j - 1
				for p > rhs && isSpace(masked[p]) {
					p--
				}
				q := j + 1
				for q < n && isSpace(masked[q]) {
					q++
				}
				// `"|&?:.)".includes(masked[q] || "")` is true at the end of the text.
				goesOn := strings.ContainsRune("=|&?:,<(", at(masked, p)) && at(masked, p) != 0
				nextGoesOn := q >= n || strings.ContainsRune("|&?:.)", masked[q])
				if !goesOn && !nextGoesOn && !(at(masked, p) == '>' && at(masked, p-1) == '=') {
					break scan
				}
			}
		}
		ranges = append(ranges, [2]int{rhs, min(j, n)})
		pos = max(pos, min(j, n))
	}
	return ranges
}

// execTsTypeDecl is reTsTypeDecl.Exec(t, from). The pattern is anchored at a
// line start and begins with one of five words, so only such lines are handed
// to the regex engine.
func execTsTypeDecl(t []rune, from int) *Match {
	p := from
	if p > 0 && p <= len(t) && t[p-1] != '\n' {
		e := indexRune(t, '\n', p)
		if e < 0 {
			return nil
		}
		p = e + 1
	}
	for p <= len(t) {
		k := p
		for k < len(t) && (t[k] == ' ' || t[k] == '\t') {
			k++
		}
		if hasPrefixAt(t, k, "type") || hasPrefixAt(t, k, "interface") || hasPrefixAt(t, k, "export") || hasPrefixAt(t, k, "declare") || hasPrefixAt(t, k, "default") {
			if m := reTsTypeDecl.At(t, p); m != nil {
				return m
			}
		}
		e := indexRune(t, '\n', p)
		if e < 0 {
			return nil
		}
		p = e + 1
	}
	return nil
}
