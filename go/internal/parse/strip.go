package parse

import "regexp"

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
// visExtractRawImports operates on raw content). Used by the regex parser and
// by extract for sinks/routes.
func StripComments(src []byte, lang Lang) []byte {
	out := blockCommentRe.ReplaceAll(src, nil)
	out = lineCommentRe.ReplaceAll(out, []byte("$1"))
	return out
}
