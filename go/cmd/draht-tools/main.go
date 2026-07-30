package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"github.com/draht-dev/draht/go/internal/parse"
)

// defaultMemLimitBytes is decision D8's soft memory dial: Spike 1 measured
// ~700MB RSS for a cold full-repo index run inside the gsd-post-phase hook.
// A soft GC limit of 768MiB gives the GC headroom to trigger more
// aggressively under memory pressure without OOM-killing the hook's parent
// process, while staying far enough above the measured working set that it
// never fires under normal conditions.
const defaultMemLimitBytes = 768 << 20

// main dispatches to the map-graph subcommand and the global --version/
// -h/--help flags, per design §7.
func main() {
	// D8: on by default, but never overrides an operator's explicit
	// GOMEMLIMIT (debug.SetMemoryLimit is also settable via that env var
	// natively by the Go runtime at startup — we only set our own default
	// when the operator hasn't already expressed a preference).
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(defaultMemLimitBytes)
	}

	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Unknown command: \nRun: draht-tools help")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "map-graph":
		os.Exit(runMapGraph(os.Args[2:]))
	case "--version":
		// The gotreesitter version is printed here (not just buried in the
		// cache key) so a `go get -u` bump is visible without reading
		// go.mod, and so main_test.go can assert this binary's linked
		// dependency version matches go.mod (guards against Version()'s
		// cache key silently drifting from the real dependency).
		fmt.Printf("draht-tools (go) dev (gotreesitter@%s)\n", parse.LibraryVersion())
	case "-h", "--help", "help":
		fmt.Print(mapGraphUsage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nRun: draht-tools help\n", os.Args[1])
		os.Exit(1)
	}
}
