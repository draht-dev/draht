package symindex

import (
	"strings"
)

// CommentScanCap is the per-file cap on how many comment fragments
// visExtractComments will return, checked once per source line
// (draht-tools.cjs:1779 — `out.length < 400`). Because the check happens
// once per line and a single line can yield up to 3 pushes (a block close,
// a line comment, and a block open), the actual returned length can exceed
// 400 by a couple of entries; this mirrors the CJS behaviour exactly and
// must not be "fixed" into a hard cap.
const CommentScanCap = 400

// CommentStyle is one language's comment-delimiter pair, mirroring the CJS
// COMMENT_STYLE table (draht-tools.cjs:1758-1773). A style with no line
// marker (BlockOnly languages, e.g. html/markdown) leaves Line == ""; a
// style with no block markers (e.g. python/shell/ruby) leaves BlockOpen ==
// BlockClose == "".
type CommentStyle struct {
	Line       string
	BlockOpen  string
	BlockClose string
}

// commentStyles mirrors COMMENT_STYLE verbatim. Languages not present here
// (json, yaml, css, "other", ...) return ok=false from StyleFor, matching
// the CJS `if (!style) return [];` early exit.
var commentStyles = map[string]CommentStyle{
	"typescript": {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"javascript": {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"go":         {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"rust":       {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"java":       {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"kotlin":     {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"swift":      {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"csharp":     {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"c":          {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"cpp":        {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"php":        {Line: "//", BlockOpen: "/*", BlockClose: "*/"},
	"sql":        {Line: "--", BlockOpen: "/*", BlockClose: "*/"},
	"python":     {Line: "#"},
	"shell":      {Line: "#"},
	"ruby":       {Line: "#"},
	"html":       {BlockOpen: "<!--", BlockClose: "-->"},
	"markdown":   {BlockOpen: "<!--", BlockClose: "-->"},
}

// StyleFor returns the comment style for language, mirroring
// COMMENT_STYLE[language]. ok is false for any language absent from the
// table (json, yaml, css, "other", ...), matching the CJS `if (!style)
// return [];` guard in visExtractComments.
func StyleFor(language string) (CommentStyle, bool) {
	s, ok := commentStyles[language]
	return s, ok
}

// Comment is one extracted comment fragment: the 1-based source line it
// starts on, and the raw (untrimmed) comment text.
type Comment struct {
	Line int
	Text string
}

// ExtractComments is the verbatim port of visExtractComments
// (draht-tools.cjs:1774-1803). It returns [] immediately for any language
// StyleFor doesn't recognise.
//
// Per line: if a block comment is open from a previous line, look for its
// close; if found, push the pre-close fragment, consume the closer, and
// fall through to check the REMAINDER of the line for a line comment / new
// block open. Otherwise push the entire line as block content and move on.
// A line-comment match (with a "//" URL guard so `http://` doesn't trigger
// a false comment) truncates the working line before the block-open check
// runs, so a `//`-preceded `/*` on the same line is never treated as a
// block opener. The out.length>=400 guard is checked once per source line,
// not once per push (see CommentScanCap).
func ExtractComments(content []byte, language string) []Comment {
	style, ok := StyleFor(language)
	if !ok {
		return nil
	}

	lines := strings.Split(string(content), "\n")
	var out []Comment
	inBlock := false

	hasBlock := style.BlockOpen != ""

	for i, ln := range lines {
		if len(out) >= CommentScanCap {
			break
		}

		if inBlock {
			ci := -1
			if hasBlock {
				ci = strings.Index(ln, style.BlockClose)
			}
			if ci < 0 {
				out = append(out, Comment{Line: i + 1, Text: ln})
				continue
			}
			out = append(out, Comment{Line: i + 1, Text: ln[:ci]})
			ln = ln[ci+len(style.BlockClose):]
			inBlock = false
		}

		if style.Line != "" {
			idx := strings.Index(ln, style.Line)
			for idx > 0 && style.Line == "//" && ln[idx-1] == ':' {
				next := strings.Index(ln[idx+2:], style.Line)
				if next < 0 {
					idx = -1
				} else {
					idx = idx + 2 + next
				}
			}
			if idx >= 0 {
				out = append(out, Comment{Line: i + 1, Text: ln[idx+len(style.Line):]})
				ln = ln[:idx]
			}
		}

		if hasBlock {
			oi := strings.Index(ln, style.BlockOpen)
			if oi >= 0 {
				ci := strings.Index(ln[oi+len(style.BlockOpen):], style.BlockClose)
				if ci >= 0 {
					inner := ln[oi+len(style.BlockOpen) : oi+len(style.BlockOpen)+ci]
					out = append(out, Comment{Line: i + 1, Text: inner})
				} else {
					out = append(out, Comment{Line: i + 1, Text: ln[oi+len(style.BlockOpen):]})
					inBlock = true
				}
			}
		}
	}

	return out
}
