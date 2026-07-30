package extract

import (
	"regexp"
	"strings"
)

// The regexes below are verbatim ports of visExtractExports's per-language
// patterns (draht-tools.cjs:1390-1487), operating line-by-line exactly as
// the CJS engine does (^/$ anchors mean "start/end of this one line", not
// "start/end of the whole file" — each is matched against a single line via
// FindStringSubmatch, never FindAllString over the whole content).
var (
	tsExportRe      = regexp.MustCompile(`^\s*export\s+(?:default\s+)?(?:async\s+)?(class|interface|type|function|const|let|enum|var)\s+([A-Za-z_$][\w$]*)`)
	tsNamedExportRe = regexp.MustCompile(`^\s*export\s*\{([^}]+)\}`)
	// tsNamedExportFromRe implements design §R2's RE2 workaround for
	// namedExportRe's `(?!\s+from)`: reject a named-export match when the
	// text immediately following the matched `}` starts with `\s+from`.
	tsNamedExportFromRe = regexp.MustCompile(`^\s+from`)
	tsDefaultRe         = regexp.MustCompile(`^\s*export\s+default\s`)
	tsCommandRe         = regexp.MustCompile(`^\s*commands\s*\[\s*["']([^"']+)["']\s*\]\s*=`)
	tsAsClauseRe        = regexp.MustCompile(`^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$`)
	tsLeadTypeRe        = regexp.MustCompile(`^type\s+`)

	pyExportRe = regexp.MustCompile(`^(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)`)
	pyDocRe    = regexp.MustCompile(`^\s*("""|''')(.*)`)
	pyDocEndRe = regexp.MustCompile(`("""|''')\s*$`)

	goExportRe = regexp.MustCompile(`^\s*(?:func\s+(?:\([^)]+\)\s+)?([A-Z][a-zA-Z0-9_]*)|type\s+([A-Z][a-zA-Z0-9_]*))`)

	rustExportRe   = regexp.MustCompile(`^\s*pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)`)
	rustDocLeadRe  = regexp.MustCompile(`^\s*///`)
	rustDocStripRe = regexp.MustCompile(`^\s*///\s?`)

	// findLeadingDoc helpers.
	decoratorLineRe     = regexp.MustCompile(`^\s*@[A-Za-z]`)
	blockCommentEndRe   = regexp.MustCompile(`\*/\s*$`)
	blockCommentOpenRe  = regexp.MustCompile(`^\s*/\*\*?`)
	blockCommentLeadRe  = regexp.MustCompile(`(?m)^\s*\*\s?`)
	blockCommentAtTagRe = regexp.MustCompile(`(?m)^\s*@\w+.*$`)
	lineCommentLeadRe   = regexp.MustCompile(`^\s*//`)
	lineCommentStripRe  = regexp.MustCompile(`^\s*//\s?`)

	// looksLikeDoc rejects "section divider" comments like `// --- foo ---`
	// or `// ======` that aren't real docs (draht-tools.cjs:1483).
	dividerDocRe = regexp.MustCompile(`^[-=#*\s]+$|^-+\s*\w+\s*-+$`)
)

// findLeadingDoc ports visExtractExports' findLeadingDoc closure
// (draht-tools.cjs:1393-1423). idx is the 0-based index of the line the doc
// comment should immediately precede. Returns "" for JSON null (no doc
// found).
func findLeadingDoc(lines []string, idx int) string {
	i := idx - 1
	for i >= 0 && decoratorLineRe.MatchString(lines[i]) {
		i--
	}
	if i >= 0 && blockCommentEndRe.MatchString(lines[i]) {
		var block []string
		for i >= 0 {
			block = append([]string{lines[i]}, block...)
			if blockCommentOpenRe.MatchString(lines[i]) {
				break
			}
			i--
		}
		if i >= 0 {
			joined := strings.Join(block, "\n")
			joined = blockCommentOpenRe.ReplaceAllString(joined, "")
			joined = blockCommentEndRe.ReplaceAllString(joined, "")
			joined = blockCommentLeadRe.ReplaceAllString(joined, "")
			joined = blockCommentAtTagRe.ReplaceAllString(joined, "")
			var parts []string
			for _, s := range strings.Split(joined, "\n") {
				s = strings.TrimSpace(s)
				if s != "" {
					parts = append(parts, s)
				}
			}
			doc := strings.Join(parts, " ")
			return sliceRunes(doc, 240)
		}
	}

	var block []string
	for i >= 0 && lineCommentLeadRe.MatchString(lines[i]) {
		block = append([]string{lineCommentStripRe.ReplaceAllString(lines[i], "")}, block...)
		i--
	}
	if len(block) > 0 {
		return sliceRunes(strings.TrimSpace(strings.Join(block, " ")), 240)
	}
	return ""
}

// sliceRunes truncates s to at most n runes, matching JS String.slice(0,n)
// (a UTF-16-code-unit slice; runes are the closest practical Go analogue).
func sliceRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// looksLikeDoc rejects a doc string that is empty, too short, or looks like
// a divider comment (draht-tools.cjs:1483).
func looksLikeDoc(d string) bool {
	if len(d) <= 8 {
		return false
	}
	return !dividerDocRe.MatchString(strings.TrimSpace(d))
}

// extractExports ports visExtractExports (draht-tools.cjs:1390-1487) for
// typescript/javascript/python/go/rust, including findLeadingDoc (decorator
// skip, /** */ block, // run), the 200-entry break, and name dedup.
func extractExports(lang string, content []byte) []Export {
	lines := strings.Split(string(content), "\n")
	var out []Export

	switch lang {
	case "typescript", "javascript":
		for i := 0; i < len(lines); i++ {
			line := lines[i]
			if m := tsExportRe.FindStringSubmatch(line); m != nil {
				out = append(out, Export{Name: m[2], Kind: m[1], Line: i + 1, Doc: findLeadingDoc(lines, i)})
			} else if m := tsNamedExportRe.FindStringSubmatch(line); m != nil && !tsNamedExportFromRe.MatchString(line[len(m[0]):]) {
				doc := findLeadingDoc(lines, i)
				for _, part := range strings.Split(m[1], ",") {
					t := strings.TrimSpace(part)
					t = tsLeadTypeRe.ReplaceAllString(t, "")
					if am := tsAsClauseRe.FindStringSubmatch(t); am != nil {
						name := am[2]
						if name == "" {
							name = am[1]
						}
						out = append(out, Export{Name: name, Kind: "named", Line: i + 1, Doc: doc})
					}
				}
			} else if tsDefaultRe.MatchString(line) && !hasExportName(out, "default") {
				out = append(out, Export{Name: "default", Kind: "default", Line: i + 1, Doc: findLeadingDoc(lines, i)})
			} else if m := tsCommandRe.FindStringSubmatch(line); m != nil {
				out = append(out, Export{Name: m[1], Kind: "command", Line: i + 1, Doc: findLeadingDoc(lines, i)})
			}
			if len(out) > 200 {
				break
			}
		}
	case "python":
		for i := 0; i < len(lines); i++ {
			m := pyExportRe.FindStringSubmatch(lines[i])
			if m != nil {
				doc := ""
				for j := i + 1; j < len(lines) && j < i+6; j++ {
					if dm := pyDocRe.FindStringSubmatch(lines[j]); dm != nil {
						doc = strings.TrimSpace(pyDocEndRe.ReplaceAllString(dm[2], ""))
						break
					}
				}
				out = append(out, Export{Name: m[2], Kind: m[1], Line: i + 1, Doc: sliceRunes(doc, 220)})
			}
			if len(out) > 200 {
				break
			}
		}
	case "go":
		for i := 0; i < len(lines); i++ {
			m := goExportRe.FindStringSubmatch(lines[i])
			if m != nil {
				name, kind := m[1], "func"
				if name == "" {
					name, kind = m[2], "type"
				}
				out = append(out, Export{Name: name, Kind: kind, Line: i + 1, Doc: findLeadingDoc(lines, i)})
			}
			if len(out) > 200 {
				break
			}
		}
	case "rust":
		for i := 0; i < len(lines); i++ {
			m := rustExportRe.FindStringSubmatch(lines[i])
			if m != nil {
				j := i - 1
				var block []string
				for j >= 0 && rustDocLeadRe.MatchString(lines[j]) {
					block = append([]string{rustDocStripRe.ReplaceAllString(lines[j], "")}, block...)
					j--
				}
				doc := ""
				if len(block) > 0 {
					doc = sliceRunes(strings.TrimSpace(strings.Join(block, " ")), 240)
				}
				out = append(out, Export{Name: m[1], Kind: "rust-pub", Line: i + 1, Doc: doc})
			}
			if len(out) > 200 {
				break
			}
		}
	}

	seen := make(map[string]bool, len(out))
	deduped := make([]Export, 0, len(out))
	for _, e := range out {
		if seen[e.Name] {
			continue
		}
		seen[e.Name] = true
		if !looksLikeDoc(e.Doc) {
			e.Doc = ""
		}
		deduped = append(deduped, e)
	}
	return deduped
}

func hasExportName(exports []Export, name string) bool {
	for _, e := range exports {
		if e.Name == name {
			return true
		}
	}
	return false
}
