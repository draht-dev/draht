package query

import (
	"fmt"
	"io"

	"github.com/draht-dev/draht/go/internal/model"
)

// Hotspots ports commands["graph-hotspots"] (draht-tools.cjs:5544-5556):
// the four ranked hotspot lists straight from map.hotspots, each section
// preceded by a blank line (including the very first — the CJS's
// `console.log("\n"+title)` for every section means the printed output
// literally starts with "\n").
func Hotspots(m *model.Map, argv []string, w io.Writer) int {
	args := ParseArgs(argv, "limit")
	limit := max(1, args.IntOr("limit", 10))

	if args.Bool("json") {
		b, err := MarshalPretty(m.Hotspots)
		if err != nil {
			fmt.Fprintln(w, "{}")
			return 0
		}
		fmt.Fprintf(w, "%s\n", b)
		return 0
	}

	section := func(title string, arr []model.GodNode) {
		fmt.Fprintf(w, "\n%s\n", title)
		n := len(arr)
		if n > limit {
			n = limit
		}
		for _, g := range arr[:n] {
			fmt.Fprintf(w, "  %s  [in %d · out %d · %d LOC]  %s\n", g.Path, g.InDegree, g.OutDegree, g.Loc, g.Reason)
		}
	}
	section("God nodes (most connected):", m.Hotspots.GodNodes)
	section("Most depended-on:", m.Hotspots.MostDependedOn)
	section("Orchestrators (most deps):", m.Hotspots.Orchestrators)
	section("Largest:", m.Hotspots.Largest)
	return 0
}
