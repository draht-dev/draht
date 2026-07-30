package main

import (
	"bufio"
	"fmt"
	"io"
	"os"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/query"
)

// runGraphQuery loads the map once, then dispatches to the matching
// query.* renderer. The no-map guard is applied uniformly BEFORE argument
// validation, exactly as the CJS does (`if (!map) return graphNoMap()`
// precedes every command's own usage check) — so e.g. `graph-context` with
// no arguments in a repo with no MAP.json prints the no-map line, never the
// usage line.
func runGraphQuery(cmd string, argv []string) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, cmd+":", err)
		return 1
	}
	root := query.FindRepoRoot(cwd)

	m, err := query.LoadMap(root)
	if err != nil || m == nil {
		fmt.Fprintln(os.Stdout, query.NoMapMessage)
		return 0
	}

	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	return dispatchGraphQuery(cmd, m, argv, w)
}

func dispatchGraphQuery(cmd string, m *model.Map, argv []string, w io.Writer) int {
	switch cmd {
	case "graph-context":
		return query.Context(m, argv, w)
	case "graph-impact":
		return query.Impact(m, argv, w)
	case "graph-callers":
		return query.Callers(m, argv, w)
	case "graph-callees":
		return query.Callees(m, argv, w)
	case "graph-path":
		return query.Path(m, argv, w)
	case "graph-query":
		return query.Query(m, argv, w)
	case "graph-hotspots":
		return query.Hotspots(m, argv, w)
	case "graph-clusters":
		return query.Clusters(m, argv, w)
	}
	return 1
}
