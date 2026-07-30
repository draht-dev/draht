// Rationale marker extraction — the inline NOTE/WHY/HACK/TODO/... comment
// scanner (draht-tools.cjs:1758-1811, 2934-2936).
//
// INTEGRATION NOTE (read before wiring): internal/extract's Facts record
// (go/internal/extract/facts.go) currently stores NEITHER the file's raw
// content NOR any rationale hits — it is deliberately a cacheable,
// source-free payload. This package therefore cannot "consume" anything
// extract already computes; ExtractRationale takes raw file content
// directly. The integrator must thread the following into the assembler
// (NOT into this package, and NOT by modifying internal/extract from here —
// that package may be owned by a different work package in this phase):
//
//  1. Raw content for every file that is scanned for comments. The CJS
//     engine runs this over ALL scanned files with a recognised comment
//     style (draht-tools.cjs:2159), not just the TS/JS/Go/... "code"
//     languages that become graph modules — markdown, html and sql files
//     contribute rationale hits too, even though they never become
//     `modules[]` entries. If the current pipeline only extracts facts for
//     discovery.CodeFiles(), a second raw-content pass (or an extension of
//     extract.Facts to a RationaleHit field, cache-schema-bumped) is needed
//     to reach non-code files — otherwise rationaleIndex will silently miss
//     markdown/html/sql markers. (In THIS repo's reference MAP.json that gap
//     happens to be invisible: 0 of 58 entries come from a non-code file —
//     do not treat that as proof the path is unnecessary.)
//  2. The per-file repo-relative path, to populate RationaleEntry.File.
//  3. Files must be visited in file-scan order (path ascending) when
//     appending each file's ExtractRationale hits into the flat slice
//     passed to BuildRationaleIndex — this package's sort is stable and
//     relies on that input order for the final (file, line) tie-break.
package symindex

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/draht-dev/draht/go/internal/model"
)

// RationalePerFile is the per-file cap on rationale hits
// (draht-tools.cjs:1809 — break after the 30th push).
const RationalePerFile = 30

// RationaleGlobalCap is the cap on the rolled-up rationaleIndex
// (draht-tools.cjs:2936).
const RationaleGlobalCap = 600

// Markers is the ordered list of recognised rationale tags, verbatim from
// RATIONALE_TAG_RE's alternation (draht-tools.cjs:1758). Order here is
// documentation only — Severity is what drives the final sort.
var Markers = []string{
	"SECURITY", "BUG", "FIXME", "HACK", "XXX", "TODO", "WARNING", "GOTCHA", "PERF", "NOTE", "WHY",
}

// Severity mirrors RATIONALE_SEVERITY (draht-tools.cjs:1759-1760): lower is
// more urgent and sorts first.
var Severity = map[string]int{
	"SECURITY": 0,
	"BUG":      1,
	"FIXME":    2,
	"HACK":     3,
	"XXX":      4,
	"WARNING":  5,
	"GOTCHA":   6,
	"PERF":     7,
	"TODO":     8,
	"NOTE":     9,
	"WHY":      10,
}

// rationaleTagRe is RATIONALE_TAG_RE verbatim
// (draht-tools.cjs:1758): `\b(TAG)\b\s*[:\-]?\s*(.+)`. No /g flag in the
// source — only the leftmost match per comment fragment is used, which
// Go's regexp package (leftmost-first alternation, like the JS engine, NOT
// POSIX leftmost-longest) reproduces exactly.
var rationaleTagRe = regexp.MustCompile(
	`\b(SECURITY|BUG|FIXME|HACK|XXX|TODO|WARNING|GOTCHA|PERF|NOTE|WHY)\b\s*[:\-]?\s*(.+)`,
)

// Hit is one rationale marker found in a single file, prior to the file
// path being attached (the caller supplies that — see the package doc).
type Hit struct {
	Line int
	Tag  string
	Text string
}

// ExtractRationale is the verbatim port of visExtractRationale
// (draht-tools.cjs:1805-1811): run ExtractComments over content, match each
// fragment's text against rationaleTagRe, and keep the first RationalePerFile
// hits whose captured text is non-empty after trimming. text is trimmed and
// then sliced to 120 UTF-16 code units, matching JS `.slice(0, 120)` exactly
// (not a byte or rune count — see sliceUTF16).
func ExtractRationale(content []byte, language string) []Hit {
	comments := ExtractComments(content, language)
	if len(comments) == 0 {
		return nil
	}

	var hits []Hit
	for _, c := range comments {
		m := rationaleTagRe.FindStringSubmatch(c.Text)
		if m == nil {
			continue
		}
		text := strings.TrimSpace(m[2])
		if text == "" {
			continue
		}
		hits = append(hits, Hit{Line: c.Line, Tag: m[1], Text: sliceUTF16(text, 120)})
		if len(hits) >= RationalePerFile {
			break
		}
	}
	return hits
}

// HitsToEntries attaches a repo-relative file path to every Hit, producing
// the model.RationaleEntry records BuildRationaleIndex consumes. This is a
// convenience for callers threading ExtractRationale's per-file output into
// the global rollup; it performs no filtering or capping itself.
func HitsToEntries(file string, hits []Hit) []model.RationaleEntry {
	if len(hits) == 0 {
		return nil
	}
	out := make([]model.RationaleEntry, len(hits))
	for i, h := range hits {
		out[i] = model.RationaleEntry{File: file, Line: h.Line, Tag: h.Tag, Text: h.Text}
	}
	return out
}

// BuildRationaleIndex is the verbatim port of the rationaleIndex rollup
// (draht-tools.cjs:2934-2936): sort by Severity[tag] ASCENDING, then File
// ASCENDING, then Line ASCENDING, with ties beyond that resolved by the
// input's own order (the JS sort is stable; this uses sort.SliceStable so
// the caller's file-scan order is the final tie-break). all must already be
// in file-scan order (path ascending) — see the package doc for why that is
// the caller's responsibility. The result is capped at RationaleGlobalCap
// and is always a freshly allocated slice (all is never mutated).
func BuildRationaleIndex(all []model.RationaleEntry) []model.RationaleEntry {
	out := make([]model.RationaleEntry, len(all))
	copy(out, all)

	sort.SliceStable(out, func(i, j int) bool {
		si, sj := Severity[out[i].Tag], Severity[out[j].Tag]
		if si != sj {
			return si < sj
		}
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})

	if len(out) > RationaleGlobalCap {
		out = out[:RationaleGlobalCap]
	}
	return out
}

// sliceUTF16 truncates s to at most n UTF-16 code units, matching JS
// String.prototype.slice(0, n) exactly (JS strings are UTF-16; a naive byte
// or rune slice diverges on astral-plane characters, which encode as a
// surrogate PAIR — two code units — in JS but one rune in Go).
func sliceUTF16(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}
