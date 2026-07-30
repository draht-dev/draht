package parse

import (
	"bytes"
	"context"
	"regexp"
	"strings"
)

// The five regexes below are verbatim ports of visParseImports (draht-tools.cjs
// 1313-1364) and visExtractRawImports (1365-1389). They are RE2-compatible:
// neither function uses lookahead/lookbehind/backreferences.
var (
	// import Foo, { a, b as c } from "./x"; import type X from "y"; import "side-effect";
	// (side-effect-only imports, with neither a default/namespace/named clause, are NOT
	// matched by this regex — verbatim CJS behaviour: visParseImports has no separate
	// pattern for bare `import "x";`.)
	reImportFrom = regexp.MustCompile(
		`import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]+)\})?\s*from\s*["']([^"']+)["']`)

	// require("x") / import("x") — a single alternation, exactly as CJS's reqRe, so the
	// ORIGINAL FILE ORDER of the two forms is preserved as one interleaved pass. The
	// keyword capture group lets us classify Kind without a second scan.
	reRequireOrDynamic = regexp.MustCompile(`(require|import)\s*\(\s*["']([^"']+)["']\s*\)`)

	// export { foo, bar as baz } from "./x"
	reNamedReExport = regexp.MustCompile(`export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']`)

	// export * from "./x"  |  export * as Foo from "./x"
	reStarReExport = regexp.MustCompile(`export\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s+["']([^"']+)["']`)

	// visExtractRawImports, one regex per language (specifier-only; no names/default/namespace).
	rePyImport = regexp.MustCompile(`(?:^|\n)\s*(?:from\s+(\S+)\s+import|import\s+(\S+))`)
	reGoImport = regexp.MustCompile(`(?:^|\n)\s*import\s+(?:"([^"]+)"|\(([^)]+)\))`)
	reGoQuoted = regexp.MustCompile(`"([^"]+)"`)
	reRustUse  = regexp.MustCompile(`(?:^|\n)\s*use\s+([a-zA-Z0-9_:]+)`)
	reAsClause = regexp.MustCompile(`^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$`)
	reLeadType = regexp.MustCompile(`^type\s+`)
)

type regexParser struct{}

// NewRegex returns the verbatim port of visParseImports + visExtractRawImports
// (draht-tools.cjs:1313-1389). Supports: typescript, javascript (full),
// python, go, rust (specifier-only). It exists both as the D1 fallback
// implementation and as the byte-parity oracle for --parser=regex: its
// Result.Imports emission order MUST stay the CJS 4-pass order so downstream
// edge assembly reproduces edges[] exactly.
func NewRegex() Parser { return &regexParser{} }

func (p *regexParser) Supports(lang Lang) bool {
	switch lang {
	case "typescript", "javascript", "python", "go", "rust":
		return true
	default:
		return false
	}
}

// Extract never touches the filesystem and never panics (regexp.MustCompile
// package-level vars are validated at init time; regexp.(*Regexp) methods do
// not panic on arbitrary input), so no recover() is needed here — unlike the
// tree-sitter implementation, which wraps a third-party native-ish parser.
func (p *regexParser) Extract(ctx context.Context, lang Lang, path string, src []byte) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	// visParseImports/visExtractRawImports both operate on the STRIPPED copy
	// (draht-tools.cjs:2146-2149 strips once, then passes the stripped text
	// to visParseImports, which for non-ts/js languages forwards that SAME
	// stripped text into visExtractRawImports) — never the raw content.
	stripped := StripComments(src, lang)

	var imports []Import
	switch lang {
	case "typescript", "javascript":
		imports = parseJSImports(stripped)
	case "python":
		imports = extractRawImports(stripped, rePyImport, 1, 2)
	case "go":
		imports = extractGoImports(stripped)
	case "rust":
		imports = extractRawImports(stripped, reRustUse, 1)
	default:
		return Result{}, nil
	}

	return Result{Imports: imports}, nil
}

func (p *regexParser) Version() string { return "re/1" }

func (p *regexParser) Close() error { return nil }

// parseJSImports reproduces visParseImports's 4 passes over stripped content,
// in CJS order: import…from, then require/dynamic, then export{…}from, then
// export * from. Each pass's matches are emitted in file order.
func parseJSImports(stripped []byte) []Import {
	var out []Import

	for _, m := range reImportFrom.FindAllSubmatchIndex(stripped, -1) {
		def := submatchText(stripped, m, 1)
		ns := submatchText(stripped, m, 2)
		named := submatchText(stripped, m, 3)
		spec := submatchText(stripped, m, 4)
		out = append(out, Import{
			Kind:      KindImport,
			Specifier: spec,
			Default:   def,
			Namespace: ns,
			Names:     parseNamedList(named),
			Line:      lineOf(stripped, m[0]),
			Offset:    m[0],
		})
	}

	for _, m := range reRequireOrDynamic.FindAllSubmatchIndex(stripped, -1) {
		keyword := submatchText(stripped, m, 1)
		spec := submatchText(stripped, m, 2)
		kind := KindRequire
		if keyword == "import" {
			kind = KindDynamic
		}
		out = append(out, Import{
			Kind:      kind,
			Specifier: spec,
			Line:      lineOf(stripped, m[0]),
			Offset:    m[0],
		})
	}

	for _, m := range reNamedReExport.FindAllSubmatchIndex(stripped, -1) {
		named := submatchText(stripped, m, 1)
		spec := submatchText(stripped, m, 2)
		names := parseNamedList(named)
		if len(names) == 0 {
			continue // CJS filters out entries whose `imported` ends up empty
		}
		out = append(out, Import{
			Kind:      KindReExport,
			Specifier: spec,
			Names:     names,
			Line:      lineOf(stripped, m[0]),
			Offset:    m[0],
		})
	}

	for _, m := range reStarReExport.FindAllSubmatchIndex(stripped, -1) {
		ns := submatchText(stripped, m, 1)
		spec := submatchText(stripped, m, 2)
		if ns == "" {
			ns = "*"
		}
		out = append(out, Import{
			Kind:      KindReExport,
			Specifier: spec,
			Namespace: ns,
			Line:      lineOf(stripped, m[0]),
			Offset:    m[0],
		})
	}

	return out
}

// parseNamedList splits a `{ a, b as c }` clause's inner text on commas,
// stripping a leading `type ` modifier per entry (verbatim CJS behaviour),
// and expands "X as Y" into Name{Imported:X, Local:Y}.
func parseNamedList(named string) []Name {
	if named == "" {
		return nil
	}
	var out []Name
	for _, part := range strings.Split(named, ",") {
		t := strings.TrimSpace(part)
		t = reLeadType.ReplaceAllString(t, "")
		if t == "" {
			continue
		}
		if am := reAsClause.FindStringSubmatch(t); am != nil {
			out = append(out, Name{Imported: am[1], Local: am[2]})
		} else {
			out = append(out, Name{Imported: t})
		}
	}
	return out
}

// extractRawImports ports visExtractRawImports's python/rust branches: one
// regex, whose FIRST non-empty of the given submatch group indices (1-based)
// is the specifier.
func extractRawImports(stripped []byte, re *regexp.Regexp, groups ...int) []Import {
	var out []Import
	for _, m := range re.FindAllSubmatchIndex(stripped, -1) {
		var spec string
		for _, g := range groups {
			if s := submatchText(stripped, m, g); s != "" {
				spec = s
				break
			}
		}
		if spec == "" {
			continue
		}
		out = append(out, Import{
			Kind:      KindImport,
			Specifier: spec,
			Line:      lineOf(stripped, m[0]),
			Offset:    m[0],
		})
	}
	return out
}

// extractGoImports ports visExtractRawImports's go branch: `import "x"` or
// `import ( ... )` with one quoted path per line inside the parens.
func extractGoImports(stripped []byte) []Import {
	var out []Import
	for _, m := range reGoImport.FindAllSubmatchIndex(stripped, -1) {
		if single := submatchText(stripped, m, 1); single != "" {
			out = append(out, Import{
				Kind:      KindImport,
				Specifier: single,
				Line:      lineOf(stripped, m[0]),
				Offset:    m[0],
			})
			continue
		}
		if m[4] < 0 {
			continue // capture group 2 (the parenthesised block) did not participate
		}
		blockStart := m[4] // start offset, within stripped, of the parenthesised block
		block := stripped[m[4]:m[5]]
		lineStart := 0
		for _, line := range bytes.Split(block, []byte("\n")) {
			if im := reGoQuoted.FindSubmatchIndex(line); im != nil {
				offset := blockStart + lineStart + im[0] // start of the opening quote
				out = append(out, Import{
					Kind:      KindImport,
					Specifier: string(line[im[2]:im[3]]),
					Line:      lineOf(stripped, offset),
					Offset:    offset,
				})
			}
			lineStart += len(line) + 1 // +1 for the "\n" bytes.Split consumed
		}
	}
	return out
}

func submatchText(src []byte, m []int, group int) string {
	i := group * 2
	if i+1 >= len(m) || m[i] < 0 || m[i+1] < 0 {
		return ""
	}
	return string(src[m[i]:m[i+1]])
}

func lineOf(src []byte, offset int) int {
	if offset > len(src) {
		offset = len(src)
	}
	return 1 + bytes.Count(src[:offset], []byte("\n"))
}
