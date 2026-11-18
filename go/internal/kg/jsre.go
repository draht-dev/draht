package kg

import (
	"iter"
	"strings"

	"github.com/dlclark/regexp2"
)

// RE is a regular expression with JavaScript semantics. The kg engine is a
// port of packages/draht-tools/bin/draht-kg.cjs and its graph.json is compared
// with that engine's, so patterns are compiled by a backtracking engine in
// ECMAScript mode (lookarounds, backreferences, JS character classes) instead
// of being rewritten for RE2. Text is matched as []rune: offsets are rune
// offsets, which equal JavaScript's UTF-16 offsets for everything inside the
// Basic Multilingual Plane.
//
// A JS regex object carries its own cursor (`lastIndex`); here the cursor is
// always an explicit argument, so an RE is safe for concurrent use.
type RE struct {
	re     *regexp2.Regexp
	sticky *regexp2.Regexp
}

// Match is one match: Index/End are rune offsets into the matched text.
type Match struct {
	m *regexp2.Match
}

// mustRE compiles a JS pattern. flags: any of "i", "m", "s" ("g", "y", "d" and
// "u" are accepted and ignored: how the pattern is applied is the caller's
// choice of method).
func mustRE(pattern, flags string) *RE {
	opts := regexp2.RegexOptions(regexp2.ECMAScript)
	if strings.Contains(flags, "i") {
		opts |= regexp2.IgnoreCase
	}
	if strings.Contains(flags, "m") {
		opts |= regexp2.Multiline
	}
	if strings.Contains(flags, "s") {
		opts |= regexp2.Singleline
	}
	return &RE{
		re:     regexp2.MustCompile(pattern, opts),
		sticky: regexp2.MustCompile(`\G(?:`+pattern+`)`, opts),
	}
}

// Exec returns the first match at or after `from` (a `g` regex with
// lastIndex = from), or nil.
func (r *RE) Exec(t []rune, from int) *Match {
	if from < 0 {
		from = 0
	}
	if from > len(t) {
		return nil
	}
	m, err := r.re.FindRunesMatchStartingAt(t, from)
	if err != nil || m == nil {
		return nil
	}
	return &Match{m}
}

// At returns the match that starts exactly at `at` (a `y` regex with
// lastIndex = at), or nil.
func (r *RE) At(t []rune, at int) *Match {
	if at < 0 || at > len(t) {
		return nil
	}
	m, err := r.sticky.FindRunesMatchStartingAt(t, at)
	if err != nil || m == nil || m.Index != at {
		return nil
	}
	return &Match{m}
}

// Find is Exec from the start: `text.match(re)` / `re.exec(text)` without `g`.
func (r *RE) Find(t []rune) *Match { return r.Exec(t, 0) }

// FindS is Find on a string.
func (r *RE) FindS(s string) *Match { return r.Exec([]rune(s), 0) }

// Test reports whether the pattern matches anywhere in t.
func (r *RE) Test(t []rune) bool { return r.Exec(t, 0) != nil }

// TestS is Test on a string.
func (r *RE) TestS(s string) bool { return r.Exec([]rune(s), 0) != nil }

// Search is `text.search(re)`: the index of the first match, or -1.
func (r *RE) Search(t []rune) int {
	if m := r.Exec(t, 0); m != nil {
		return m.Index()
	}
	return -1
}

// Iter yields every match from `from` on, as `matchAll` or a `while
// ((m = re.exec(text)) !== null)` loop does: the next search starts where the
// match ended, one further after an empty match. A loop that moves the cursor
// itself must call Exec instead.
func (r *RE) Iter(t []rune, from int) iter.Seq[*Match] {
	return func(yield func(*Match) bool) {
		pos := from
		for {
			m := r.Exec(t, pos)
			if m == nil {
				return
			}
			if !yield(m) {
				return
			}
			pos = m.End()
			if m.Len() == 0 {
				pos++
			}
		}
	}
}

// IterS is Iter over a string from its start.
func (r *RE) IterS(s string) iter.Seq[*Match] { return r.Iter([]rune(s), 0) }

// ReplaceS is `s.replace(re /* g */, fn)`.
func (r *RE) ReplaceS(s string, fn func(m *Match) string) string {
	t := []rune(s)
	var b strings.Builder
	last := 0
	for m := range r.Iter(t, 0) {
		b.WriteString(string(t[last:m.Index()]))
		b.WriteString(fn(m))
		last = m.End()
	}
	if last == 0 {
		return s
	}
	b.WriteString(string(t[last:]))
	return b.String()
}

// ReplaceLit is `s.replace(re /* g */, lit)` for a replacement without `$`
// patterns.
func (r *RE) ReplaceLit(s, lit string) string {
	return r.ReplaceS(s, func(*Match) string { return lit })
}

// ReplaceFirstLit is `s.replace(re, lit)` without `g`: the first match only.
func (r *RE) ReplaceFirstLit(s, lit string) string {
	t := []rune(s)
	m := r.Exec(t, 0)
	if m == nil {
		return s
	}
	return string(t[:m.Index()]) + lit + string(t[m.End():])
}

// SplitS is `s.split(re)` for a pattern without capture groups.
func (r *RE) SplitS(s string) []string {
	t := []rune(s)
	var out []string
	last := 0
	for m := range r.Iter(t, 0) {
		if m.Len() == 0 {
			continue
		}
		out = append(out, string(t[last:m.Index()]))
		last = m.End()
	}
	return append(out, string(t[last:]))
}

// Index is the offset of the match (`m.index`).
func (m *Match) Index() int { return m.m.Index }

// End is the offset after the match (`re.lastIndex` after a successful exec).
func (m *Match) End() int { return m.m.Index + m.m.Length }

// Len is `m[0].length`.
func (m *Match) Len() int { return m.m.Length }

// Has reports whether group g took part in the match (`m[g] !== undefined`).
func (m *Match) Has(g int) bool {
	grp := m.m.GroupByNumber(g)
	return grp != nil && len(grp.Captures) > 0
}

// S is the text of group g (0 = the whole match); "" when the group did not
// take part. Use Has where JS distinguishes undefined from "".
func (m *Match) S(g int) string {
	grp := m.m.GroupByNumber(g)
	if grp == nil || len(grp.Captures) == 0 {
		return ""
	}
	return grp.String()
}

// R is the text of group g as runes.
func (m *Match) R(g int) []rune {
	grp := m.m.GroupByNumber(g)
	if grp == nil || len(grp.Captures) == 0 {
		return nil
	}
	return grp.Runes()
}

// Start is the offset where group g starts (`m.indices[g][0]`), -1 when it
// did not take part.
func (m *Match) Start(g int) int {
	grp := m.m.GroupByNumber(g)
	if grp == nil || len(grp.Captures) == 0 {
		return -1
	}
	return grp.Index
}

// Stop is the offset after group g (`m.indices[g][1]`), -1 when it did not
// take part.
func (m *Match) Stop(g int) int {
	grp := m.m.GroupByNumber(g)
	if grp == nil || len(grp.Captures) == 0 {
		return -1
	}
	return grp.Index + grp.Length
}
