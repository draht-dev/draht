package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/draht-dev/draht/go/internal/parse"
)

// defaultMemLimitBytes is decision D8's soft memory dial: Spike 1 measured
// ~700MB RSS for a cold full-repo index run inside the gsd-post-phase hook.
// A soft GC limit of 768MiB gives the GC headroom to trigger more
// aggressively under memory pressure without OOM-killing the hook's parent
// process, while staying far enough above the measured working set that it
// never fires under normal conditions.
const defaultMemLimitBytes = 768 << 20

// version/commit are stamped by scripts/build-graph-binaries.sh via
// -ldflags "-X main.version=… -X main.commit=…". Local `go build`/`make
// build` leave them at "dev"/"" — that is the intended dev signal.
var version, commit = "dev", ""

const graphSchemaVersion = 5

type managedStamp struct {
	Name          string `json:"name"`
	Version       string `json:"version"`
	SchemaVersion int    `json:"schemaVersion"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
}

func managedExecutablePath(path string) bool {
	wantName := "draht-graph"
	if runtime.GOOS == "windows" {
		wantName += ".exe"
	}
	equalName := func(a, b string) bool {
		if runtime.GOOS == "windows" {
			return strings.EqualFold(a, b)
		}
		return a == b
	}
	clean := filepath.Clean(path)
	return equalName(filepath.Base(clean), wantName) &&
		equalName(filepath.Base(filepath.Dir(clean)), "bin") &&
		equalName(filepath.Base(filepath.Dir(filepath.Dir(clean))), ".draht")
}

func validateManagedExecutable() error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	invoked := os.Args[0]
	if !filepath.IsAbs(invoked) {
		invoked, _ = filepath.Abs(invoked)
	}
	managed := ""
	if managedExecutablePath(executable) {
		managed = executable
	} else if managedExecutablePath(invoked) {
		managed = invoked
	}
	if managed == "" {
		return nil // standalone binaries outside a .draht/bin directory remain usable
	}
	stampBytes, err := os.ReadFile(filepath.Join(filepath.Dir(managed), ".draht-graph.json"))
	if err != nil {
		return fmt.Errorf("read provenance stamp: %w", err)
	}
	var stamp managedStamp
	if err := json.Unmarshal(stampBytes, &stamp); err != nil {
		return fmt.Errorf("parse provenance stamp: %w", err)
	}
	if stamp.Name != "draht-graph" || stamp.Version == "" || stamp.SchemaVersion != graphSchemaVersion || stamp.Size < 0 || len(stamp.SHA256) != sha256.Size*2 {
		return fmt.Errorf("invalid provenance stamp schema")
	}
	f, err := os.Open(executable)
	if err != nil {
		return fmt.Errorf("open executable: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() != stamp.Size {
		return fmt.Errorf("executable size does not match provenance stamp")
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("hash executable: %w", err)
	}
	if hex.EncodeToString(h.Sum(nil)) != stamp.SHA256 {
		return fmt.Errorf("executable SHA-256 does not match provenance stamp")
	}
	return nil
}

// main dispatches to the map-graph subcommand and the global --version/
// -h/--help flags, per design §7.
func main() {
	if err := validateManagedExecutable(); err != nil {
		fmt.Fprintf(os.Stderr, "draht-graph: managed integrity check failed: %v\n", err)
		os.Exit(126)
	}
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
	case "map-serve":
		os.Exit(runMapServe(os.Args[2:]))
	case "graph-context", "graph-impact", "graph-callers", "graph-callees",
		"graph-path", "graph-query", "graph-hotspots", "graph-clusters":
		os.Exit(runGraphQuery(os.Args[1], os.Args[2:]))
	case "graph-hook":
		os.Exit(runGraphHook(os.Args[2:]))
	case "--version":
		// The gotreesitter version is printed here (not just buried in the
		// cache key) so a `go get -u` bump is visible without reading
		// go.mod, and so main_test.go can assert this binary's linked
		// dependency version matches go.mod (guards against Version()'s
		// cache key silently drifting from the real dependency).
		fmt.Printf("draht-tools (go) %s (gotreesitter@%s)\n", version, parse.LibraryVersion())
	case "-h", "--help", "help":
		fmt.Print(topLevelUsage)
		fmt.Print("\n", mapGraphUsage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nRun: draht-tools help\n", os.Args[1])
		os.Exit(1)
	}
}
