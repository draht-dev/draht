package query

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Query ports commands["graph-query"] (draht-tools.cjs): term coverage is
// satisfied at the MODULE level (any symbol/path/doc/cluster hit), scaled by
// coverage² — graphify's scheme. The old per-symbol AND required every term
// to hit the same symbol, so "auth session" only matched files that packed
// both words into one identifier. Tests are demoted below the code they
// test; partial matches are labeled "(m/n terms)".
func Query(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv)
	var terms []string
	for _, f := range args.Files {
		t := LowerJS(f)
		if LenUTF16(t) >= 3 {
			terms = append(terms, t)
		}
	}
	if len(terms) == 0 {
		fmt.Fprintln(w, "usage: graph-query <term...> [--json]  (terms ≥3 chars)")
		return 0
	}

	clusterLabel := map[string]string{}
	for _, c := range m.Clusters {
		clusterLabel[c.ID] = LowerJS(c.Label)
	}

	deg := map[string]int{}
	for _, e := range m.Edges {
		if e.Kind != "import" && e.Kind != "re-export" {
			continue
		}
		deg[e.From]++
		deg[e.To]++
	}

	var cands []QueryHit
	for _, mod := range m.Modules {
		expDoc := map[string]string{}
		var docParts []string
		for _, e := range mod.Exports {
			doc := ""
			if e.Doc != nil {
				doc = *e.Doc
			}
			expDoc[e.Name] = doc
			if doc != "" {
				docParts = append(docParts, doc)
			}
		}
		baseLow := LowerJS(lastPathSegment(mod.Path))
		pathLow := LowerJS(mod.Path)
		clab := ""
		if mod.Cluster != nil {
			clab = clusterLabel[*mod.Cluster]
		}
		allDocsLow := LowerJS(strings.Join(docParts, " "))

		symScores := map[string]int{} // symbol name -> summed per-term score, for display pick
		matched := 0
		sum := 0
		for _, t := range terms {
			best := 0
			for _, s := range mod.Symbols {
				nameLow := LowerJS(s.Name)
				sc := 0
				switch {
				case nameLow == t:
					sc = 400
				case strings.HasPrefix(nameLow, t):
					sc = 200
				case strings.Contains(nameLow, t):
					sc = 100
				}
				if sc < 40 {
					dl := LowerJS(expDoc[s.Name])
					if dl != "" && (strings.Contains(dl, t) || strings.Contains(dl, stem(t))) {
						sc = 40
					}
				}
				if sc > 0 {
					symScores[s.Name] += sc
				}
				if sc > best {
					best = sc
				}
			}
			if best < 60 && strings.Contains(baseLow, t) {
				best = 60
			}
			if best < 50 && strings.Contains(pathLow, t) {
				best = 50
			}
			if best < 40 && allDocsLow != "" && (strings.Contains(allDocsLow, t) || strings.Contains(allDocsLow, stem(t))) {
				best = 40
			}
			if best < 30 && strings.Contains(clab, t) {
				best = 30
			}
			if best > 0 {
				matched++
			}
			sum += best
		}
		if matched == 0 {
			continue
		}
		coverage := float64(matched) / float64(len(terms))
		mult := coverage * coverage
		if mod.EntryPoint != nil {
			mult *= 1.3
		}
		if mod.IsTest {
			mult *= 0.7 // tests match everything; keep them below the code they test
		}
		// Display anchor: best-scoring symbol (exported preferred, first-in-file
		// on ties), else the module itself.
		var bestSym *model.Symbol
		bestVal := 0.0
		for i := range mod.Symbols {
			s := &mod.Symbols[i]
			v := float64(symScores[s.Name])
			if s.Exported {
				v *= 1.5
			}
			if v > bestVal {
				bestVal = v
				bestSym = s
			}
		}
		if bestSym != nil && bestSym.Exported {
			mult *= 1.5
		}
		hit := QueryHit{
			Score:   ToFixed1(float64(sum) * mult),
			Matched: matched,
			Terms:   len(terms),
			Deg:     deg[mod.ID],
			Path:    mod.Path,
			Line:    1,
			Kind:    "module",
			Name:    lastPathSegment(mod.Path),
		}
		if bestSym != nil {
			hit.Line = bestSym.Line
			hit.Kind = bestSym.Kind
			hit.Name = bestSym.Name
			hit.Exported = bestSym.Exported
			hit.Doc = expDoc[bestSym.Name]
		}
		cands = append(cands, hit)
	}

	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if a.Deg != b.Deg {
			return a.Deg > b.Deg
		}
		la, lb := LenUTF16(a.Path), LenUTF16(b.Path)
		if la != lb {
			return la < lb
		}
		return LessJS(a.Path, b.Path)
	})

	top := cands
	if len(top) > 15 {
		top = top[:15]
	}

	if args.Bool("json") {
		b, err := MarshalPretty(nonNilHits(top))
		if err != nil {
			fmt.Fprintln(w, "[]")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	fmt.Fprintf(w, "query \"%s\" — %d/%d hits\n", strings.Join(terms, " "), len(top), len(cands))
	for _, c := range top {
		docPart := ""
		if c.Doc != "" {
			docPart = "  — " + SliceUTF16(c.Doc, 60)
		}
		expPart := ""
		if c.Exported {
			expPart = "  [exported]"
		}
		partial := ""
		if c.Matched < c.Terms {
			partial = fmt.Sprintf("  (%d/%d terms)", c.Matched, c.Terms)
		}
		fmt.Fprintf(w, "%s:%d  %s %s%s%s%s\n", c.Path, c.Line, c.Kind, c.Name, docPart, expPart, partial)
	}
	if len(cands) > 15 {
		fmt.Fprintf(w, "(%d more: --json for all)\n", len(cands)-15)
	}
	return 0
}

// stem ports `s.replace(/(ing|tion|ed|s)$/, "")`. Because "tion", "ing",
// "ed" and "s" all end in a different final character (n, g, d, s
// respectively), a string can satisfy at most one of these suffix checks,
// so a plain first-match HasSuffix scan (checked longest-to-shortest, to
// mirror the regex engine trying the smaller start index — i.e. the longer
// remaining tail — first) reproduces the JS regex exactly; verified against
// node for tion/ing/ed/s-ending and non-matching inputs (see querycmd_test.go).
func stem(s string) string {
	for _, suf := range [...]string{"tion", "ing", "ed", "s"} {
		if strings.HasSuffix(s, suf) {
			return s[:len(s)-len(suf)]
		}
	}
	return s
}

func nonNilHits(xs []QueryHit) []QueryHit {
	if xs == nil {
		return []QueryHit{}
	}
	return xs
}
