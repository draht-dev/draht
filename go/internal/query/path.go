package query

import (
	"fmt"
	"io"

	"github.com/draht-dev/draht/go/internal/model"
)

// Path ports commands["graph-path"] (draht-tools.cjs:5483-5501): shortest
// import path between two files, forward first, then reverse
// ("reached-by") if no forward path exists. --json is parsed but ignored,
// matching the CJS (graph-path never supports --json).
func Path(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv)
	resolver := NewResolver(m)

	var f0, f1 string
	if len(args.Files) > 0 {
		f0 = args.Files[0]
	}
	if len(args.Files) > 1 {
		f1 = args.Files[1]
	}
	a := resolver.Resolve(f0)
	b := resolver.Resolve(f1)
	if a == nil || b == nil {
		fmt.Fprintln(w, "usage: graph-path <from> <to>  (both files must resolve)")
		return 0
	}

	adj := BuildImportAdj(m)
	sym := map[string]string{}
	for _, ce := range m.CallEdges {
		key := ce.From + "|" + ce.To
		if _, ok := sym[key]; !ok {
			sym[key] = ce.Symbol
		}
	}

	bfs := func(src, dst string) []string {
		prev := map[string]*string{src: nil}
		queue := []string{src}
		for len(queue) > 0 {
			id := queue[0]
			queue = queue[1:]
			if id == dst {
				break
			}
			for _, n := range adj.Fwd[id] {
				if _, ok := prev[n]; !ok {
					idCopy := id
					prev[n] = &idCopy
					queue = append(queue, n)
				}
			}
		}
		if _, ok := prev[dst]; !ok {
			return nil
		}
		var chain []string
		cur := dst
		for {
			chain = append([]string{cur}, chain...)
			p := prev[cur]
			if p == nil {
				break
			}
			cur = *p
		}
		return chain
	}

	chain := bfs(a.ID, b.ID)
	reversed := false
	if chain == nil {
		chain = bfs(b.ID, a.ID)
		reversed = true
	}
	if chain == nil {
		fmt.Fprintf(w, "no import path between %s and %s\n", a.ID, b.ID)
		return 0
	}

	if reversed {
		fmt.Fprintf(w, "(no forward path) reverse: %s is reached-by %s in %d hops\n", b.ID, a.ID, len(chain)-1)
	} else {
		fmt.Fprintf(w, "path %s → %s  (%d hops)\n", a.ID, b.ID, len(chain)-1)
	}

	render := chain
	if reversed {
		render = reverseStrs(chain)
	}
	line := ""
	for i, c := range render {
		line += Short(c)
		if i < len(render)-1 {
			key := c + "|" + render[i+1]
			if s, ok := sym[key]; ok && s != "" {
				line += fmt.Sprintf(" —%s→ ", s)
			} else {
				line += " → "
			}
		}
	}
	fmt.Fprintf(w, "  %s\n", line)
	return 0
}

func reverseStrs(xs []string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[len(xs)-1-i] = x
	}
	return out
}
