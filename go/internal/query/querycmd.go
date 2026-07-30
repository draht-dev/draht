package query

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Query ports commands["graph-query"] (draht-tools.cjs:5503-5541): a
// ranked, deterministic keyword+doc search over every symbol node (no
// embeddings). All terms must AND-match (every term must score >0 against a
// candidate symbol); the highest-scoring 15 hits are shown.
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
		if e.Kind != "import" {
			continue
		}
		deg[e.From]++
		deg[e.To]++
	}

	var cands []QueryHit
	for _, mod := range m.Modules {
		expDoc := map[string]string{}
		for _, e := range mod.Exports {
			doc := ""
			if e.Doc != nil {
				doc = *e.Doc
			}
			expDoc[e.Name] = doc
		}
		baseLow := LowerJS(lastPathSegment(mod.Path))
		clab := ""
		if mod.Cluster != nil {
			clab = clusterLabel[*mod.Cluster]
		}

		for _, s := range mod.Symbols {
			nameLow := LowerJS(s.Name)
			doc := expDoc[s.Name]
			docLow := LowerJS(doc)

			total := 0
			ok := true
			for _, t := range terms {
				sc := 0
				switch {
				case nameLow == t:
					sc = 400
				case strings.HasPrefix(nameLow, t):
					sc = 200
				case strings.Contains(nameLow, t):
					sc = 100
				}
				if sc < 60 && strings.Contains(baseLow, t) {
					sc = 60
				}
				if sc < 40 && (strings.Contains(docLow, t) || strings.Contains(docLow, stem(t))) {
					sc = 40
				}
				if sc < 30 && strings.Contains(clab, t) {
					sc = 30
				}
				if sc == 0 {
					ok = false
					break
				}
				total += sc
			}
			if !ok {
				continue
			}

			mult := 1.0
			if s.Exported {
				mult *= 1.5
			}
			if mod.EntryPoint != nil {
				mult *= 1.3
			}

			cands = append(cands, QueryHit{
				Score:    ToFixed1(float64(total) * mult),
				Deg:      deg[mod.ID],
				Path:     mod.Path,
				Line:     s.Line,
				Kind:     s.Kind,
				Name:     s.Name,
				Exported: s.Exported,
				Doc:      doc,
			})
		}
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
		fmt.Fprintf(w, "%s:%d  %s %s%s%s\n", c.Path, c.Line, c.Kind, c.Name, docPart, expPart)
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
