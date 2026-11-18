package kg

// Hand-written equivalents of the two call patterns that every line of every
// TS/JS/Python file is searched with. The regexes stay the specification
// (callscan_test.go checks the scanners against them); the scanners exist
// because a backtracking engine tries these lookbehind-led patterns at every
// character.

func isIdentStart(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'
}

// identRunEnd is the end of the run of [\w$] characters that starts at i.
func identRunEnd(t []rune, i int) int {
	for i < len(t) && isIdentChar(t[i]) {
		i++
	}
	return i
}

// callParen is the offset after `\s*\(` at i, or -1.
func callParen(t []rune, i int) int {
	for i < len(t) && isSpace(t[i]) {
		i++
	}
	if i < len(t) && t[i] == '(' {
		return i + 1
	}
	return -1
}

// startsReference reports whether an identifier may start at i for the
// lookbehind (?<![\w.$#]).
func startsReference(t []rune, i int) bool {
	if i == 0 {
		return true
	}
	p := t[i-1]
	return !isIdentChar(p) && p != '.' && p != '#'
}

// callHit is one match of reCallCall: (?<![\w.$#])([A-Za-z_$][\w$]*)\s*\(
type callHit struct {
	index int
	name  string
}

// scanCalls returns every match of reCallCall in ln, as reCallCall.Iter(ln, 0) yields them.
func scanCalls(ln []rune) []callHit {
	var out []callHit
	for i := 0; i < len(ln); {
		if !isIdentChar(ln[i]) {
			i++
			continue
		}
		e := identRunEnd(ln, i)
		if isIdentStart(ln[i]) && startsReference(ln, i) {
			if end := callParen(ln, e); end >= 0 {
				out = append(out, callHit{index: i, name: string(ln[i:e])})
				i = end
				continue
			}
		}
		i = e
	}
	return out
}

// nsHit is one match of reCallNs:
// (?<![\w.$#])((?:[A-Za-z_$][\w$]*\.)+)([A-Za-z_$][\w$]*)\s*\(
type nsHit struct {
	index  int
	recv   string // group 1, with its trailing dot
	member string // group 2
}

// scanNsCalls returns every match of reCallNs in ln, as reCallNs.Iter(ln, 0) yields them.
func scanNsCalls(ln []rune) []nsHit {
	var out []nsHit
	for i := 0; i < len(ln); {
		if !isIdentChar(ln[i]) {
			i++
			continue
		}
		e := identRunEnd(ln, i)
		if !isIdentStart(ln[i]) || !startsReference(ln, i) {
			i = e
			continue
		}
		// the longest chain run(.run)* of identifiers
		last, end, runs := i, e, 1
		for end+1 < len(ln) && ln[end] == '.' && isIdentStart(ln[end+1]) {
			last = end + 1
			end = identRunEnd(ln, last)
			runs++
		}
		if runs >= 2 {
			if after := callParen(ln, end); after >= 0 {
				out = append(out, nsHit{index: i, recv: string(ln[i:last]), member: string(ln[last:end])})
				i = after
				continue
			}
		}
		i = e
	}
	return out
}
