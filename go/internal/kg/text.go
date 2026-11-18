package kg

import (
	"sort"
	"strings"
)

// Helpers over []rune text that mirror the JavaScript string operations the
// engine was written with: an index past either end reads as "no character"
// (the zero rune, which compares unequal to every real character, as
// `undefined` does), and slices clamp instead of panicking.

// at is `t[i]`: the zero rune outside the text.
func at(t []rune, i int) rune {
	if i < 0 || i >= len(t) {
		return 0
	}
	return t[i]
}

// sub is `t.slice(a, b)` for non-negative arguments.
func sub(t []rune, a, b int) []rune {
	if a < 0 {
		a = 0
	}
	if b > len(t) {
		b = len(t)
	}
	if a >= b {
		return nil
	}
	return t[a:b]
}

// str is `t.slice(a, b)` as a string.
func str(t []rune, a, b int) string { return string(sub(t, a, b)) }

// indexRune is `t.indexOf(c, from)`.
func indexRune(t []rune, c rune, from int) int {
	if from < 0 {
		from = 0
	}
	for i := from; i < len(t); i++ {
		if t[i] == c {
			return i
		}
	}
	return -1
}

// indexStr is `t.indexOf(s, from)` for a non-empty s.
func indexStr(t []rune, s string, from int) int {
	needle := []rune(s)
	if from < 0 {
		from = 0
	}
	if len(needle) == 0 {
		if from > len(t) {
			return len(t)
		}
		return from
	}
	for i := from; i+len(needle) <= len(t); i++ {
		if t[i] != needle[0] {
			continue
		}
		ok := true
		for k := 1; k < len(needle); k++ {
			if t[i+k] != needle[k] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

// eolAt is the offset of the line break at or after `from`, or len(t).
func eolAt(t []rune, from int) int {
	if e := indexRune(t, '\n', from); e >= 0 {
		return e
	}
	return len(t)
}

// hasPrefixAt is `t.startsWith(s, i)`.
func hasPrefixAt(t []rune, i int, s string) bool {
	if i < 0 {
		return false
	}
	k := i
	for _, c := range s {
		if k >= len(t) || t[k] != c {
			return false
		}
		k++
	}
	return true
}

// isSpace is the regex class `\s` of JavaScript.
func isSpace(c rune) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\v', '\f', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return c >= 0x2000 && c <= 0x200a
}

// leadSpace is `t.match(/^\s*/)[0].length`.
func leadSpace(t []rune) int {
	i := 0
	for i < len(t) && isSpace(t[i]) {
		i++
	}
	return i
}

// trimRunes is `t.trim()`.
func trimRunes(t []rune) []rune {
	a, b := 0, len(t)
	for a < b && isSpace(t[a]) {
		a++
	}
	for b > a && isSpace(t[b-1]) {
		b--
	}
	return t[a:b]
}

// trimEndRunes is `t.trimEnd()`.
func trimEndRunes(t []rune) []rune {
	b := len(t)
	for b > 0 && isSpace(t[b-1]) {
		b--
	}
	return t[:b]
}

// jsTrim is `s.trim()` on a string.
func jsTrim(s string) string { return strings.TrimFunc(s, isSpace) }

// isIdentChar: [A-Za-z0-9_$].
func isIdentChar(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$'
}

// matchClose is the index of the bracket that closes the one at `open`, or -1.
func matchClose(text []rune, open int) int {
	o := at(text, open)
	var c rune
	switch o {
	case '{':
		c = '}'
	case '(':
		c = ')'
	case '[':
		c = ']'
	case '<':
		c = '>'
	default:
		return -1
	}
	depth := 0
	for i := open; i < len(text); i++ {
		ch := text[i]
		if ch == o {
			depth++
		} else if ch == c {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// splitTopLevel returns the pieces of text split at commas outside every bracket.
func splitTopLevel(text []rune) [][]rune {
	var out [][]rune
	depth, from := 0, 0
	for i, ch := range text {
		switch ch {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case ',':
			if depth == 0 {
				out = append(out, text[from:i])
				from = i + 1
			}
		}
	}
	return append(out, text[from:])
}

// lineIndex returns the 1-based line number of a rune offset in content.
func lineIndex(content []rune) func(int) int {
	starts := []int{0}
	for i, c := range content {
		if c == '\n' {
			starts = append(starts, i+1)
		}
	}
	return func(idx int) int {
		lo, hi := 0, len(starts)-1
		for lo < hi {
			mid := (lo + hi + 1) >> 1
			if starts[mid] <= idx {
				lo = mid
			} else {
				hi = mid - 1
			}
		}
		return lo + 1
	}
}

// blankRanges returns text with the given [start, end) ranges turned to
// spaces (line breaks kept). The input is not modified.
func blankRanges(text []rune, ranges [][2]int) []rune {
	if len(ranges) == 0 {
		return text
	}
	sorted := append([][2]int(nil), ranges...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i][0] != sorted[j][0] {
			return sorted[i][0] < sorted[j][0]
		}
		return sorted[i][1] > sorted[j][1]
	})
	out := append([]rune(nil), text...)
	cur := 0
	for _, r := range sorted {
		a, b := r[0], r[1]
		if a < cur {
			continue
		}
		if b > len(out) {
			b = len(out)
		}
		for i := a; i < b; i++ {
			if out[i] != '\r' && out[i] != '\n' {
				out[i] = ' '
			}
		}
		// JS: `at = b` even when b < a (an empty slice); later ranges that
		// start before it are skipped.
		cur = r[1]
	}
	return out
}

// splitLines is `t.split("\n")`.
func splitLines(t []rune) [][]rune {
	var out [][]rune
	from := 0
	for i, c := range t {
		if c == '\n' {
			out = append(out, t[from:i])
			from = i + 1
		}
	}
	return append(out, t[from:])
}

// lessStr orders strings as JavaScript's `<` does for text inside the Basic
// Multilingual Plane.
func lessStr(a, b string) bool { return a < b }
