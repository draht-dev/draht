package extract

import (
	"regexp"
	"strings"
)

var (
	tsSymbolRe = regexp.MustCompile(`^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=`)
	tsClassRe  = regexp.MustCompile(`^\s*(?:async\s+)?class\b`)
	tsFuncRe   = regexp.MustCompile(`^\s*(?:async\s+)?function\b`)

	pySymbolRe = regexp.MustCompile(`^(?:class|def)\s+([A-Za-z_][\w]*)`)
	pyClassRe  = regexp.MustCompile(`^class\b`)

	goSymbolRe = regexp.MustCompile(`^func\s+(?:\([^)]*\)\s+)?([a-z][\w]*)|^type\s+([a-z][\w]*)`)
	goFuncRe   = regexp.MustCompile(`^func\b`)

	rustSymbolRe = regexp.MustCompile(`^\s*(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)`)
)

// buildSymbols ports visBuildSymbols (draht-tools.cjs:1815-1845): exported
// names first (from the already-computed, untruncated exports slice), hard
// stop at 60, then a per-language best-effort non-exported top-level
// declaration scan.
func buildSymbols(lang string, content []byte, exports []Export) []Symbol {
	var syms []Symbol
	seen := make(map[string]bool)

	// Split once, up front: both the exported pass (which needs it for
	// signatures) and the non-exported declaration scan below read it.
	lines := strings.Split(string(content), "\n")

	for _, e := range exports {
		if seen[e.Name] {
			continue
		}
		seen[e.Name] = true
		syms = append(syms, Symbol{
			Name:     e.Name,
			Kind:     e.Kind,
			Line:     e.Line,
			Exported: true,
			Sig:      signatureAt(lang, lines, e.Line-1),
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
			syms = append(syms, Symbol{
				Name:     name,
				Kind:     kindOf(line),
				Line:     i + 1,
				Exported: false,
				Sig:      signatureAt(lang, lines, i),
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
