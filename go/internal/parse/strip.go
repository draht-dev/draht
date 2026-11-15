package parse

import (
	"bytes"
	"regexp"
)

// blockCommentRe / lineCommentRe are the verbatim CJS pair
// (draht-tools.cjs:2141-2144): `/\/\*[\s\S]*?\*\//g` then
// `/(^|[^:])\/\/.*$/gm -> "$1"`. Both are string-unaware: a `/*` inside a
// string literal is stripped through to the next `*/`, and this is
// deliberately preserved for --parser=regex parity, not "fixed".
var (
	// (?s) makes '.' match newlines, reproducing JS's [\s\S].
	blockCommentRe = regexp.MustCompile(`(?s)/\*.*?\*/`)
	// (?m) makes ^/$ match at line boundaries, reproducing JS's /gm flags.
	// The "https://" guard ([^:] before //) is preserved verbatim.
	lineCommentRe = regexp.MustCompile(`(?m)(^|[^:])//.*$`)
)

// StripComments removes block and line comments the same (string-unaware,
// regex-based) way the CJS engine does. lang is accepted for interface
// symmetry with the rest of the package but is currently unused: the CJS
// engine applies the identical C-style stripping to every language it scans
// imports for (typescript/javascript; python/go/rust never call it, since
// visExtractRawImports operates on raw content). Used by extract for
// sinks/routes.
func StripComments(src []byte, lang Lang) []byte {
	out := blockCommentRe.ReplaceAll(src, nil)
	out = lineCommentRe.ReplaceAll(out, []byte("$1"))
	return out
}

// StripCommentsPreserveLines strips the same comments but keeps every
// newline a block comment spanned, so byte offsets in the result map to the
// SAME line numbers as the raw source. The import parser uses this variant
// (lockstep with the CJS engine) because Import.Line feeds user-visible
// output via star re-export expansion; sinks/routes keep StripComments.
func StripCommentsPreserveLines(src []byte, lang Lang) []byte {
	out := blockCommentRe.ReplaceAllFunc(src, func(m []byte) []byte {
		kept := make([]byte, 0, 4)
		for _, b := range m {
			if b == '\n' {
				kept = append(kept, b)
			}
		}
		return kept
	})
	out = lineCommentRe.ReplaceAll(out, []byte("$1"))
	return out
}

// regexScanLimit: a regex literal longer than this is not treated as one
// (lockstep with VIS_REGEX_SCAN_LIMIT).
const regexScanLimit = 4096

// regexAfterKeywords are the identifiers after which a `/` starts a regex
// literal rather than a division (lockstep with visMaskNonCode's
// VIS_REGEX_AFTER_KEYWORDS).
var regexAfterKeywords = map[string]bool{
	"return": true, "typeof": true, "instanceof": true, "in": true, "of": true,
	"new": true, "delete": true, "void": true, "throw": true, "case": true,
	"do": true, "else": true, "yield": true, "await": true,
}

func isWordByte(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$' || c >= 0x80
}

// MaskNonCode is a single-pass, length- and newline-preserving masker for
// JS/TS source: comments are blanked entirely, string and regex-literal
// contents are blanked with their delimiters kept, and template literals
// keep their `${ … }` expression code (nested) while the literal text is
// blanked. The export extractor's content-level passes match against the
// result (lockstep with the CJS visMaskNonCode) so neither a commented-out
// `// export { X } from "./y"` example nor an export list inside a string can
// become a public export, and a `/*` inside a string (`"packages/*/src"`)
// can no longer swallow real code up to the next `*/`. Only '\n' is
// preserved — line numbers are derived by splitting on it — so byte offsets in
// the result map one-to-one onto the raw source while doc extraction keeps
// reading the raw lines. lang is accepted for interface symmetry.
func MaskNonCode(src []byte, lang Lang) []byte {
	n := len(src)
	out := make([]byte, n)
	copy(out, src)
	mask := func(a, b int) {
		for k := a; k < b && k < n; k++ {
			if out[k] != '\n' {
				out[k] = ' '
			}
		}
	}
	indexByte := func(c byte, from int) int {
		if from >= n {
			return -1
		}
		if k := bytes.IndexByte(src[from:], c); k >= 0 {
			return from + k
		}
		return -1
	}
	at := func(k int) byte {
		if k < n {
			return src[k]
		}
		return 0
	}
	var exprDepth []int // open `${` expressions: brace depth inside each
	inTemplate := false
	regexOk := true // may an expression (hence a regex literal) start here?
	i := 0
	for i < n {
		if inTemplate {
			start := i
			for i < n {
				c := src[i]
				if c == '\\' {
					i += 2
					continue
				}
				if c == '`' || (c == '$' && at(i+1) == '{') {
					break
				}
				i++
			}
			if i > n {
				i = n
			}
			mask(start, i)
			if i >= n {
				break
			}
			inTemplate = false
			if src[i] == '`' {
				i++
				regexOk = false
			} else {
				i += 2
				exprDepth = append(exprDepth, 0)
				regexOk = true
			}
			continue
		}
		c := src[i]
		switch {
		case c == '/':
			next := at(i + 1)
			if next == '/' { // line comment
				j := indexByte('\n', i)
				if j < 0 {
					j = n
				}
				mask(i, j)
				i = j
				continue
			}
			if next == '*' { // block comment
				end := n
				if j := bytes.Index(src[min(i+2, n):], []byte("*/")); j >= 0 {
					end = i + 2 + j + 2
				}
				mask(i, end)
				i = end
				continue
			}
			if regexOk {
				// A regex literal never spans lines; `/` inside a [...] class does not end it.
				// The scan is bounded so a stray `/` in a huge minified line cannot make
				// masking quadratic.
				inClass, close := false, -1
				for k := i + 1; k < n && k-i <= regexScanLimit; k++ {
					d := src[k]
					if d == '\n' {
						break
					}
					if d == '\\' {
						k++
						continue
					}
					if d == '[' {
						inClass = true
					} else if d == ']' {
						inClass = false
					} else if d == '/' && !inClass {
						close = k
						break
					}
				}
				if close >= 0 {
					mask(i+1, close)
					i = close + 1
					for i < n && isWordByte(src[i]) { // flags
						i++
					}
					regexOk = false
					continue
				}
			}
			i++
			regexOk = true
		case c == '\'' || c == '"': // unterminated strings end at the line break
			k := i + 1
			for k < n {
				d := src[k]
				if d == c || d == '\n' {
					break
				}
				if d == '\\' {
					k += 2
				} else {
					k++
				}
			}
			if k > n {
				k = n
			}
			mask(i+1, k)
			if k < n && src[k] == c {
				i = k + 1
			} else {
				i = k
			}
			regexOk = false
		case c == '`':
			i++
			inTemplate = true
		case c == '{':
			if len(exprDepth) > 0 {
				exprDepth[len(exprDepth)-1]++
			}
			i++
			regexOk = true
		case c == '}':
			i++
			if len(exprDepth) > 0 {
				if exprDepth[len(exprDepth)-1] == 0 {
					exprDepth = exprDepth[:len(exprDepth)-1]
					inTemplate = true
					continue
				}
				exprDepth[len(exprDepth)-1]--
			}
			regexOk = true
		case isWordByte(c):
			start := i
			for i < n && isWordByte(src[i]) {
				i++
			}
			regexOk = regexAfterKeywords[string(src[start:i])]
		case c == ')' || c == ']':
			i++
			regexOk = false
		default:
			if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
				regexOk = true
			}
			i++
		}
	}
	return out
}
