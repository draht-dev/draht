package extract

import (
	"regexp"
	"strings"
)

var (
	tsSymbolRe = regexp.MustCompile(`^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=`)
	tsClassRe  = regexp.MustCompile(`^\s*(?:async\s+)?class\b`)
	tsFuncRe   = regexp.MustCompile(`^\s*(?:async\s+)?function\b`)
	tsDeclRe   = regexp.MustCompile(`^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b`)

	pySymbolRe = regexp.MustCompile(`^(?:class|def)\s+([A-Za-z_][\w]*)`)
	pyClassRe  = regexp.MustCompile(`^class\b`)

	goSymbolRe = regexp.MustCompile(`^func\s+(?:\([^)]*\)\s+)?([a-z][\w]*)|^type\s+([a-z][\w]*)`)
	goFuncRe   = regexp.MustCompile(`^func\b`)

	rustSymbolRe = regexp.MustCompile(`^\s*(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)`)

	// tsNamedExportStmtRe matches one assembled `export { ... }` statement in
	// namedExportLocalAt (signature resolution only — exports extraction
	// itself uses the content-level tsNamedBlockRe in exports.go).
	tsNamedExportStmtRe = regexp.MustCompile(`^\s*export\s*\{([^}]+)\}`)
)

// buildSymbols ports visBuildSymbols (draht-tools.cjs:1815-1845): exported
// names first (from the already-computed, untruncated exports slice), hard
// stop at 60, then a per-language best-effort non-exported top-level
// declaration scan.
func buildSymbols(lang string, content []byte, exports []Export, withSignatures bool) []Symbol {
	var syms []Symbol
	seen := make(map[string]bool)

	// Split once, up front: both the exported pass (which needs it for
	// signatures) and the non-exported declaration scan below read it.
	lines := strings.Split(string(content), "\n")
	tsDeclLines := make(map[string]int)
	if withSignatures && (lang == "typescript" || lang == "javascript") {
		for i, line := range lines {
			if m := tsDeclRe.FindStringSubmatch(line); m != nil {
				tsDeclLines[m[1]] = i
			}
		}
	}

	for _, e := range exports {
		if seen[e.Name] {
			continue
		}
		seen[e.Name] = true
		sig := ""
		if withSignatures {
			sig = signatureAt(lang, lines, e.Line-1)
		}
		if withSignatures && e.Kind == "named" && (lang == "typescript" || lang == "javascript") {
			sig = ""
			if local := namedExportLocalAt(lines, e.Line-1, e.Name); local != "" {
				if declLine, ok := tsDeclLines[local]; ok {
					sig = signatureAt(lang, lines, declLine)
				}
			}
		}
		syms = append(syms, Symbol{
			Name:     e.Name,
			Kind:     e.Kind,
			Line:     e.Line,
			Exported: true,
			Sig:      sig,
		})
		if len(syms) >= 60 {
			return syms
		}
	}

	addDecl := func(re *regexp.Regexp, kindOf func(line string) string) bool {
		for i, line := range lines {
			m := re.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			name := ""
			for _, g := range m[1:] {
				if g != "" {
					name = g
					break
				}
			}
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			sig := ""
			if withSignatures {
				sig = signatureAt(lang, lines, i)
			}
			syms = append(syms, Symbol{
				Name:     name,
				Kind:     kindOf(line),
				Line:     i + 1,
				Exported: false,
				Sig:      sig,
			})
			if len(syms) >= 60 {
				return true
			}
		}
		return false
	}

	switch lang {
	case "typescript", "javascript":
		addDecl(tsSymbolRe, func(l string) string {
			if tsClassRe.MatchString(l) {
				return "class"
			}
			if tsFuncRe.MatchString(l) {
				return "function"
			}
			return "const"
		})
	case "python":
		addDecl(pySymbolRe, func(l string) string {
			if pyClassRe.MatchString(l) {
				return "class"
			}
			return "def"
		})
	case "go":
		addDecl(goSymbolRe, func(l string) string {
			if goFuncRe.MatchString(l) {
				return "func"
			}
			return "type"
		})
	case "rust":
		addDecl(rustSymbolRe, func(string) string { return "rust-item" })
	}

	return syms
}

// namedExportLocalAt returns the local binding behind one `export { ... }`
// entry. It deliberately resolves only simple identifier clauses; anything
// ambiguous stays unresolved so callers omit a signature instead of storing
// the syntactically useless word "export".
func namedExportLocalAt(lines []string, idx int, exported string) string {
	if idx < 0 || idx >= len(lines) {
		return ""
	}
	var statement strings.Builder
	for i := idx; i < len(lines) && i < idx+maxSignatureLines; i++ {
		statement.WriteString(lines[i])
		statement.WriteByte(' ')
		if strings.Contains(lines[i], "}") {
			break
		}
	}
	m := tsNamedExportStmtRe.FindStringSubmatch(statement.String())
	if m == nil {
		return ""
	}
	for _, part := range strings.Split(m[1], ",") {
		clause := strings.TrimSpace(tsLeadTypeRe.ReplaceAllString(strings.TrimSpace(part), ""))
		if am := tsAsClauseRe.FindStringSubmatch(clause); am != nil {
			name := am[2]
			if name == "" {
				name = am[1]
			}
			if name == exported {
				return am[1]
			}
		}
	}
	return ""
}
