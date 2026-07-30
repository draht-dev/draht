package query

import (
	"fmt"
	"io"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// Clusters ports commands["graph-clusters"] (draht-tools.cjs:5559-5570):
// the structural (import-topology) neighborhoods, in map.clusters order
// (already size-DESC in a real MAP.json), plus optionally every
// surprising-connection bridge/boundary edge with --surprising. Neither
// list is capped here — the caps in GRAPH_REPORT.md's renderer do not apply
// to this command.
func Clusters(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv)

	if args.Bool("json") {
		payload := ClustersJSON{Clusters: nonNilClusters(m.Clusters)}
		if args.Bool("surprising") {
			sc := nonNilWarns(m.SurprisingConnections)
			payload.SurprisingConnections = &sc
		}
		b, err := MarshalPretty(payload)
		if err != nil {
			fmt.Fprintln(w, "{}")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	fmt.Fprintf(w, "%d clusters (structural import-topology — not semantic bounded contexts):\n", len(m.Clusters))
	for _, c := range m.Clusters {
		pkgs := c.Packages
		if len(pkgs) > 3 {
			pkgs = pkgs[:3]
		}
		fmt.Fprintf(w, "  %s  ·  %d modules  ·  %s  ·  %s\n", c.Label, c.Size, c.DominantLayer, strings.Join(pkgs, ", "))
	}

	if args.Bool("surprising") {
		fmt.Fprintf(w, "\nSurprising connections (%d):\n", len(m.SurprisingConnections))
		for _, x := range m.SurprisingConnections {
			samples := ""
			if len(x.SampleSymbols) > 0 {
				ss := x.SampleSymbols
				if len(ss) > 3 {
					ss = ss[:3]
				}
				samples = " · " + strings.Join(ss, ", ")
			}
			fmt.Fprintf(w, "  %s → %s  —  %s (%s)%s\n", Short(x.From), Short(x.To), x.Reason, formatScore(x.Score), samples)
		}
	}
	return 0
}

// formatScore renders a surprisingConnections score the way JS template
// interpolation renders a Number: integers print with no decimal point
// (score is always an integer in practice per MAP.json, but this guards
// against a stray fractional value rather than assuming).
func formatScore(score float64) string {
	if score == float64(int64(score)) {
		return fmt.Sprintf("%d", int64(score))
	}
	return fmt.Sprintf("%g", score)
}

func nonNilClusters(xs []model.Cluster) []model.Cluster {
	if xs == nil {
		return []model.Cluster{}
	}
	return xs
}
