package extract

import (
	"regexp"
	"strings"
)

// SignatureCap is the per-symbol budget for a rendered declaration: enough
// to carry a full parameter list and return type for typical declarations,
// short enough that a whole file's worth of signatures still fits inside an
// agent's context window.
const SignatureCap = 160

// maxSignatureLines bounds the continuation scan for declarations whose
// parameter list wraps across several lines.
const maxSignatureLines = 8

var sigWhitespaceRe = regexp.MustCompile(`\s+`)

var tsVariableDeclRe = regexp.MustCompile(`^\s*export\s+(?:declare\s+)?(?:const|let|var)\b|^\s*(?:const|let|var)\b`)

// hashCommentLangs are the languages where `#` starts a line comment. It is
// deliberately NOT applied to typescript/javascript (`#x` is a private class
// field) or rust (`#[derive(...)]` is an attribute).
var hashCommentLangs = map[string]bool{
	"python": true,
	"ruby":   true,
	"shell":  true,
}

// regexLiteralLangs are the languages where `/.../` is a literal rather than
// division. Lexing it as one matters: a regex like
// /[(){}[\]<>.,;:'"!?...]/ is full of characters that would otherwise be
// read as brackets, quotes and terminators, which corrupts everything after
// it on the line.
var regexLiteralLangs = map[string]bool{
	"typescript": true,
	"javascript": true,
	"tsx":        true,
}

// isRegexStart reports whether a `/` following prev opens a regex literal
// rather than being a division operator. prev is the last significant
// (non-space) byte emitted, or 0 at the start of the declaration. The rule
// is the usual one: a regex may only appear where a value may appear.
func isRegexStart(prev byte) bool {
	switch prev {
	case 0, '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '^', '~', '<', '>':
		return true
	}
	return false
}

// scanRegexLiteral returns the index just past the regex literal starting at
// line[start] (which must be '/'), including its trailing flags. Backslash
// escapes are honoured, and a `/` inside a `[...]` character class does not
// close the literal. An unterminated literal consumes the rest of the line.
func scanRegexLiteral(line string, start int) int {
	inClass := false
	for j := start + 1; j < len(line); j++ {
		switch line[j] {
		case '\\':
			j++
		case '[':
			inClass = true
		case ']':
			inClass = false
		case '/':
			if !inClass {
				j++
				for j < len(line) && line[j] >= 'a' && line[j] <= 'z' {
					j++
				}
				return j
			}
		}
	}
	return len(line)
}

// signatureAt renders the declaration beginning at lines[idx] as one compact
// line: continuation lines are folded in until the parameter list closes,
// the body opener is dropped, and line comments and runs of whitespace are
// collapsed. The result is capped at SignatureCap runes.
//
// This is a TEXT extractor, not a type checker. It reports what the source
// literally declares — the same "declared annotations only, nothing
// inferred" contract the outline format uses — so a parameter with no type
// annotation stays untyped here rather than being guessed at. Declarations
// with no parameter list (a `const` binding, a type alias) yield their
// leading text up to the initializer, which is the part worth keeping.
//
// Returns "" when idx is out of range or the declaration reduces to nothing.
func signatureAt(lang string, lines []string, idx int) string {
	if idx < 0 || idx >= len(lines) {
		return ""
	}
	last := idx + maxSignatureLines
	if last > len(lines) {
		last = len(lines)
	}
	hashComments := hashCommentLangs[lang]
	regexLiterals := regexLiteralLangs[lang]
	variableDecl := regexLiterals && tsVariableDeclRe.MatchString(lines[idx])
	variableArrow := variableDecl && strings.Contains(strings.Join(lines[idx:last], "\n"), "=>")

	// One entry per source line consumed, joined structurally by foldParts
	// rather than with a blind space (a wrapped parameter list must come
	// back out as `foo(a, b)`, not `foo( a, b, )`).
	var parts []string
	depth := 0      // nesting depth of () and []
	opened := false // a bracketed parameter list was seen
	closed := false // ...and it closed again

	for i := idx; i < last; i++ {
		var sb strings.Builder
		line := lines[i]
		var quote byte
		var lastSig byte // last non-space byte emitted; drives isRegexStart
		stop := false

		for j := 0; j < len(line); j++ {
			c := line[j]

			if quote != 0 {
				sb.WriteByte(c)
				// A backslash escapes the next byte, so a `\"` inside a
				// double-quoted string does not close it.
				if c == '\\' && j+1 < len(line) {
					j++
					sb.WriteByte(line[j])
					continue
				}
				if c == quote {
					quote = 0
				}
				continue
			}

			if c == '/' && j+1 < len(line) {
				// A line or block comment ends the declaration text here.
				if line[j+1] == '/' || line[j+1] == '*' {
					break
				}
				if regexLiterals && isRegexStart(lastSig) {
					end := scanRegexLiteral(line, j)
					sb.WriteString(line[j:end])
					lastSig = '/'
					j = end - 1
					continue
				}
			}
			if c == '#' && hashComments {
				break
			}

			// An escape outside a string (a regex-adjacent `\]`, a shell
			// line continuation) hides the next byte from the scanner.
			if c == '\\' {
				sb.WriteByte(c)
				if j+1 < len(line) {
					j++
					sb.WriteByte(line[j])
				}
				lastSig = '\\'
				continue
			}

			switch c {
			case '"', '\'', '`':
				quote = c
			case '(', '[':
				depth++
				opened = true
			case ')', ']':
				if depth > 0 {
					depth--
					if depth == 0 && opened {
						closed = true
					}
				}
			case '{':
				// The body opener — but only at depth 0, so an inline
				// object type inside a parameter list is kept.
				if depth == 0 {
					stop = true
				}
			case ';':
				if depth == 0 {
					stop = true
				}
			case '=':
				// Variable initializers are implementation details and may contain
				// credentials. Keep only the declared name/type. Arrow functions
				// are the exception: their parameter and return-type syntax lives
				// on the initializer side and is still declaration information.
				if depth == 0 && variableDecl && !variableArrow {
					stop = true
				}
				// `=>` once the parameter list has closed is the arrow of
				// an arrow function, i.e. the start of its body.
				if depth == 0 && closed && j+1 < len(line) && line[j+1] == '>' {
					stop = true
				}
			}
			if stop {
				break
			}
			sb.WriteByte(c)
			if c != ' ' && c != '\t' {
				lastSig = c
			}
		}

		parts = append(parts, strings.TrimSpace(sigWhitespaceRe.ReplaceAllString(sb.String(), " ")))

		// Depth 0 at end of line means the declaration is complete: either
		// it never opened a parameter list, or the one it opened has
		// closed. Only an unbalanced line continues onto the next.
		//
		// An unclosed quote means the scan lost track of the source (an
		// apostrophe in a comment, a template literal spanning lines), so
		// folding further would splice in unrelated code — stop instead and
		// keep only what this line yielded.
		if stop || depth == 0 || quote != 0 {
			break
		}
	}

	return normalizeSignature(foldParts(parts))
}

// foldParts joins the per-line fragments of a wrapped declaration back into
// one line. A separating space is inserted only where the source would need
// one: never right after an opening bracket, and never before a closing
// bracket or a comma. A trailing comma directly before a closing bracket is
// dropped, so a trailing-comma parameter list reads like a single-line one.
func foldParts(parts []string) string {
	var out string
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out == "" {
			out = p
			continue
		}
		if strings.HasPrefix(p, ")") || strings.HasPrefix(p, "]") {
			out = strings.TrimSuffix(out, ",")
		}
		switch {
		case strings.HasSuffix(out, "(") || strings.HasSuffix(out, "["):
		case strings.HasPrefix(p, ")") || strings.HasPrefix(p, "]") || strings.HasPrefix(p, ","):
		default:
			out += " "
		}
		out += p
	}
	return out
}

// normalizeSignature collapses whitespace and strips the dangling operators
// a cut-off declaration leaves behind (`=`, `:`, `,`, a lone `{`), then caps
// the result at SignatureCap runes.
func normalizeSignature(s string) string {
	s = strings.TrimSpace(sigWhitespaceRe.ReplaceAllString(s, " "))
	for {
		t := strings.TrimSpace(strings.TrimRight(s, " \t{=:;,"))
		if t == s {
			break
		}
		s = t
	}
	return sliceRunes(s, SignatureCap)
}
