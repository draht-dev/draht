package kg

import (
	"strings"

	"github.com/draht-dev/draht/go/internal/jsutil"
)

// Python words that start a statement which is not an assignment.
var pyStatementWords = strSet(
	"if", "elif", "else", "try", "except", "finally", "for", "while", "with", "def", "class", "return", "import", "from",
	"lambda", "pass", "raise", "global", "nonlocal", "assert", "del", "async", "await", "match", "case", "yield", "not", "print",
)

var (
	reDeclTsDoc = mustRE(`^\s*\/\*\*?([\s\S]*?)\*\/`, "")
	// JS: /^\s*\*\s?/gm. `^` with the m flag also matches after \r,
	// and   in JavaScript but only after \n in regexp2, and on a CRLF
	// file that changes which characters the replace removes, so the line
	// start is spelled out.
	reDeclTsDocStar    = mustRE(`(?<![^\n\r  ])\s*\*\s?`, "")
	reDeclTypePrefix   = mustRE(`^type\s+`, "")
	reDeclImportName   = mustRE(`^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$`, "")
	reDeclImport       = mustRE(`import\s+(?:type\s+(?!from\s*["']))?(?:(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s*as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*)?["']([^"']+)["']`, "")
	reDeclReExport     = mustRE(`export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']`, "")
	reDeclStar         = mustRE(`export\s+(?:type\s+)?\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s*["']([^"']+)["']`, "")
	reDeclCjs          = mustRE(`(?:\b(?:const|let|var)\s+|,\s*)(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)(?:\s*\.\s*([A-Za-z_$][\w$]*))?`, "")
	reDeclCjsNameStart = mustRE(`[A-Za-z_$\{]`, "")
	reDeclCjsPiece     = mustRE(`^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$`, "")
	reDeclDynamic      = mustRE(`(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)`, "")

	rePyDoc       = mustRE(`^(?:#[^\n]*\n|\s*\n)*\s*("""|''')([\s\S]*?)\1`, "")
	rePyDecorator = mustRE(`^[ \t]*@`, "")
	rePyClass     = mustRE(`^[ \t]*class\s+([A-Za-z_][\w]*)\s*(\()?`, "")
	rePyBase      = mustRE(`^((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\s*(?:\[[\s\S]*\])?$`, "")
	rePyDef       = mustRE(`^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)`, "")
	rePyAssign    = mustRE(`^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]*\S[^=\n]*(?:=(?!=)|$)|=(?!=))`, "")
	rePyContinued = mustRE(`\\\s*$`, "")
	rePyImport    = mustRE(`^[ \t]*from\s+(\S+)\s+import\s+([^\n(]+|\([^)]*\))|^[ \t]*import\s+([^\n]+)`, "m")
	rePyImportAs  = mustRE(`^([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?$`, "")
	rePyAsSplit   = mustRE(`\s+as\s+`, "")

	reGoImport      = mustRE(`^import\s+(?:([\w.]+)\s+)?"([^"]+)"|^import\s+\(([^)]*)\)`, "m")
	reGoImportEntry = mustRE(`^\s*(?:([\w.]+)\s+)?"([^"]+)"`, "m")
)

// pyScopeRef is the `ref` of a Python scope: a class, a function, or a
// throwaway `{}` (both nil).
type pyScopeRef struct {
	cls *Class
	fn  *Func
}

func (r pyScopeRef) setEnd(end int) {
	if r.cls != nil {
		r.cls.End = end
	}
	if r.fn != nil {
		r.fn.End = end
	}
}

type pyScope struct {
	ref    pyScopeRef
	indent int
	kind   string // "class", "def", "inner"
}

type goImportEntry struct {
	alias string // "" for none
	spec  string
}

func parseDecls(rel string, content []rune, lang string) *Decls {
	d := &Decls{}
	// ONE masked copy (see maskSource) with the same offsets and line structure
	// as `content`: declarations, brace depth and import statements are all
	// found on it, so a `{` inside `const marker = "{";`, an `export function`
	// inside a template literal or an `import` inside a string cannot
	// desynchronize `depth` or fabricate a symbol or dependency. Import
	// specifiers are read back from `content` at the match offsets.
	var multiline []int
	masked := maskSource(content, lang, &multiline)
	d.Masked = masked
	var importRanges [][2]int // import statements are not call sites either
	maskedLines := splitLines(masked)
	lineOf := lineIndex(content)
	specAt := func(m *Match, g int) string { return str(content, m.Start(g), m.Stop(g)) }

	if tsLike(lang) {
		// Leading /** */ or run of // as module rationale
		if dm := reDeclTsDoc.Find(content); dm != nil {
			d.Docstring = jsutil.SliceUTF16(jsTrim(reDeclTsDocStar.ReplaceLit(dm.S(1), "")), 500)
		}

		parseTsDecls(d, masked, lineOf, lang)
		// imports (content-level, multi-line safe), on the masked copy so
		// commented-out examples and import text inside strings or templates are
		// not dependencies. A statement-level `type` (`import type OpenAI from
		// "openai"`) is skipped unless it is itself the default binding
		// (`import type from "./type"`).
		importNames := func(list string) []ImportName {
			var out []ImportName
			for _, x := range splitStr(list, ",") {
				t := reDeclTypePrefix.ReplaceFirstLit(jsTrim(x), "")
				if t == "" {
					continue
				}
				if am := reDeclImportName.FindS(t); am != nil {
					local := am.S(2)
					if local == "" {
						local = am.S(1)
					}
					out = append(out, ImportName{Imported: am.S(1), Local: local})
				}
			}
			return out
		}
		for m2 := range reDeclImport.Iter(masked, 0) {
			importRanges = append(importRanges, [2]int{m2.Index(), m2.Index() + m2.Len()})
			d.Imports = append(d.Imports, &Import{Spec: specAt(m2, 4), Default: m2.S(1), Namespace: m2.S(2), Names: importNames(m2.S(3)), ReExport: false, Dynamic: false, Line: lineOf(m2.Index())})
		}
		for m2 := range reDeclReExport.Iter(masked, 0) {
			importRanges = append(importRanges, [2]int{m2.Index(), m2.Index() + m2.Len()})
			d.Imports = append(d.Imports, &Import{Spec: specAt(m2, 2), Names: importNames(m2.S(1)), ReExport: true, Dynamic: false, Line: lineOf(m2.Index())})
		}
		// `export * from` re-exports every name (namespace "*"); `export * as ns
		// from` exposes only `ns`, so it carries that name instead.
		for m2 := range reDeclStar.Iter(masked, 0) {
			importRanges = append(importRanges, [2]int{m2.Index(), m2.Index() + m2.Len()})
			ns := m2.S(1)
			if ns == "" {
				ns = "*"
			}
			d.Imports = append(d.Imports, &Import{Spec: specAt(m2, 2), Namespace: ns, ReExport: true, Dynamic: false, Line: lineOf(m2.Index())})
		}
		// CommonJS: `const x = require("m")`, `const { a, b: c } = require("m")`,
		// `const y = require("m").y`, and the comma-continued form
		// (`var a = require("a")\n  , b = require("b")`) bind like imports.
		var cjsRanges [][2]int
		for m2 := range reDeclCjs.Iter(masked, 0) {
			cjsRanges = append(cjsRanges, [2]int{m2.Index(), m2.Index() + m2.Len()})
			rec := &Import{Spec: specAt(m2, 3), ReExport: false, Dynamic: false, Cjs: true, Line: lineOf(m2.Index() + reDeclCjsNameStart.Search(m2.R(0)))}
			if m2.Has(2) {
				for _, piece := range splitStr(m2.S(2), ",") {
					if pm := reDeclCjsPiece.FindS(jsTrim(piece)); pm != nil {
						local := pm.S(2)
						if local == "" {
							local = pm.S(1)
						}
						rec.Names = append(rec.Names, ImportName{Imported: pm.S(1), Local: local})
					}
				}
			} else if m2.S(4) != "" {
				rec.Names = append(rec.Names, ImportName{Imported: m2.S(4), Local: m2.S(1)})
			} else {
				rec.Namespace = m2.S(1)
			}
			d.Imports = append(d.Imports, rec)
		}
		for m2 := range reDeclDynamic.Iter(masked, 0) {
			inCjs := false
			for _, r := range cjsRanges {
				if m2.Index() >= r[0] && m2.Index() < r[1] {
					inCjs = true
					break
				}
			}
			if inCjs {
				continue
			}
			d.Imports = append(d.Imports, &Import{Spec: specAt(m2, 1), ReExport: false, Dynamic: true, Line: lineOf(m2.Index())})
		}
	} else if lang == "python" {
		if dm := rePyDoc.Find(content); dm != nil {
			d.Docstring = jsutil.SliceUTF16(jsTrim(dm.S(2)), 500)
		}
		// Scope follows indentation: a class or def ends before the next logical
		// line at its own indent or less, so module-level code after it (an
		// `if __name__ == "__main__":` block) belongs to the file, and `self.x()`
		// can only bind inside the enclosing class. Lines inside brackets, after a
		// backslash, or inside a triple-quoted string continue the previous
		// statement and never open or close a scope.
		inString := map[int]bool{}
		for k := 0; k+1 < len(multiline); k += 2 {
			for l := lineOf(multiline[k]) + 1; l <= lineOf(multiline[k+1]-1); l++ {
				inString[l-1] = true
			}
		}
		// Declarations count wherever module-level code can put them: under an
		// `if TYPE_CHECKING:`, a `try:`, a platform check. Only a def or class
		// body ends module level. A decorator belongs to what it decorates, so
		// `start` is the first decorator line.
		var scopes []pyScope
		bracket, continued, lastCode := 0, false, 0
		decoStart := 0 // 0: null
		lineStarts := []int{0}
		for k := indexRune(masked, '\n', 0); k >= 0; k = indexRune(masked, '\n', k+1) {
			lineStarts = append(lineStarts, k+1)
		}
		for i := 0; i < len(maskedLines); i++ {
			ln := maskedLines[i]
			hasCode := false
			for _, ch := range ln {
				if !isSpace(ch) {
					hasCode = true
					break
				}
			}
			if hasCode && bracket == 0 && !continued && !inString[i] {
				indent := 0
				for _, ch := range ln {
					if ch == ' ' {
						indent++
					} else if ch == '\t' {
						indent += 8
					} else {
						break
					}
				}
				for len(scopes) > 0 && indent <= scopes[len(scopes)-1].indent {
					scopes[len(scopes)-1].ref.setEnd(lastCode)
					scopes = scopes[:len(scopes)-1]
				}
				var top *pyScope
				if len(scopes) > 0 {
					t := scopes[len(scopes)-1]
					top = &t
				}
				if rePyDecorator.Test(ln) {
					if decoStart == 0 {
						decoStart = i + 1
					}
				} else {
					start := i + 1
					if decoStart != 0 {
						start = decoStart
					}
					decoStart = 0
					if m := rePyClass.Find(ln); m != nil {
						if top != nil {
							scopes = append(scopes, pyScope{indent: indent, kind: "inner"})
						} else {
							var basesText []rune
							if m.S(2) != "" {
								open := lineStarts[i] + m.Len() - 1
								close := matchClose(masked, open)
								if close > open {
									basesText = sub(masked, open+1, close)
								}
							}
							bases := []PyBase{}
							for _, piece := range splitTopLevel(basesText) {
								if bm := rePyBase.Find(trimRunes(piece)); bm != nil {
									bases = append(bases, PyBase{Module: strings.TrimSuffix(bm.S(1), "."), Name: bm.S(2)})
								}
							}
							cls := &Class{Name: m.S(1), Line: i + 1, Start: start, Bases: bases, BodyStart: -1, BodyEnd: -1}
							d.Classes = append(d.Classes, cls)
							scopes = append(scopes, pyScope{ref: pyScopeRef{cls: cls}, indent: indent, kind: "class"})
						}
					} else if m := rePyDef.Find(ln); m != nil {
						if top == nil {
							fn := &Func{Name: m.S(1), Line: i + 1, Start: start, BodyStart: -1, BodyEnd: -1}
							d.Functions = append(d.Functions, fn)
							scopes = append(scopes, pyScope{ref: pyScopeRef{fn: fn}, indent: indent, kind: "def"})
						} else if top.kind == "class" {
							meth := &Func{Name: m.S(1), Line: i + 1, Start: start, BodyStart: -1, BodyEnd: -1}
							ref := pyScopeRef{}
							if addMethod(top.ref.cls, meth) {
								ref.fn = meth
							}
							scopes = append(scopes, pyScope{ref: ref, indent: indent, kind: "def"})
						} else {
							scopes = append(scopes, pyScope{indent: indent, kind: "inner"})
						}
					} else if top == nil {
						if m := rePyAssign.Find(ln); m != nil && !pyStatementWords[m.S(1)] {
							d.Types = append(d.Types, &TypeDecl{Name: m.S(1), Line: i + 1, Kind: "const"})
						}
					}
				}
			}
			for _, ch := range ln {
				if ch == '(' || ch == '[' || ch == '{' {
					bracket++
				} else if (ch == ')' || ch == ']' || ch == '}') && bracket > 0 {
					bracket--
				}
			}
			continued = rePyContinued.Test(ln)
			if hasCode {
				lastCode = i + 1
			}
		}
		for _, sc := range scopes {
			sc.ref.setEnd(lastCode)
		}
		// `import a.b as c, d` binds `c` and `d`; without an alias the dotted path
		// itself is the name calls go through (`a.b.f()`).
		for m2 := range rePyImport.Iter(masked, 0) {
			importRanges = append(importRanges, [2]int{m2.Index(), m2.Index() + m2.Len()})
			line := lineOf(m2.Index() + leadSpace(m2.R(0)))
			if m2.S(3) != "" {
				for _, piece := range splitStr(m2.S(3), ",") {
					if im := rePyImportAs.FindS(jsTrim(piece)); im != nil {
						ns := im.S(2)
						if ns == "" {
							ns = im.S(1)
						}
						d.Imports = append(d.Imports, &Import{Spec: im.S(1), Namespace: ns, ReExport: false, Dynamic: false, Line: line})
					}
				}
			} else {
				var names []ImportName
				list := strings.ReplaceAll(strings.ReplaceAll(m2.S(2), "(", ""), ")", "")
				for _, x := range splitStr(list, ",") {
					q := rePyAsSplit.SplitS(jsTrim(x))
					if q[0] == "" {
						continue
					}
					local := q[0]
					if len(q) > 1 && q[1] != "" {
						local = q[1]
					}
					names = append(names, ImportName{Imported: q[0], Local: local})
				}
				d.Imports = append(d.Imports, &Import{Spec: m2.S(1), Names: names, ReExport: false, Dynamic: false, Line: line})
			}
		}
	} else if lang == "go" {
		parseGoDecls(d, masked, lineOf)
		// Named (`import foo "path"`), blank (`_`) and dot (`.`) imports all count;
		// a named alias becomes the local namespace so call binding can resolve
		// through it. Applies to both single-line and block forms.
		for m2 := range reGoImport.Iter(masked, 0) {
			var entries []goImportEntry
			if m2.S(2) != "" {
				entries = append(entries, goImportEntry{alias: m2.S(1), spec: specAt(m2, 2)})
			} else if m2.S(3) != "" {
				block := m2.Start(3)
				for lm := range reGoImportEntry.Iter(m2.R(3), 0) {
					entries = append(entries, goImportEntry{alias: lm.S(1), spec: str(content, block+lm.Start(2), block+lm.Stop(2))})
				}
			}
			for _, e := range entries {
				ns := e.alias
				if e.alias == "" || e.alias == "_" || e.alias == "." {
					parts := splitStr(e.spec, "/")
					ns = parts[len(parts)-1]
				}
				d.Imports = append(d.Imports, &Import{Spec: e.spec, Namespace: ns, ReExport: false, Dynamic: false, Line: lineOf(m2.Index()), GoAlias: e.alias})
			}
		}
	} else if lang == "rust" {
		parseRustDecls(d, masked, lineOf)
	}
	// What the call scans read: the masked text minus import statements and, in
	// TypeScript, interface bodies and type aliases.
	if lang == "typescript" {
		d.CallText = blankRanges(masked, append(importRanges, typeDeclRanges(masked)...))
	} else {
		d.CallText = blankRanges(masked, importRanges)
	}
	return d
}
