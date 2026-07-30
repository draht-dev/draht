package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/draht-dev/draht/go/internal/query"
	"github.com/draht-dev/draht/go/internal/serve"
)

// runMapServe wires `draht-tools map-serve [port] [--port N|-p N]
// [--open|--no-open]`. Serving happens from findRepoRoot(cwd), not cwd
// itself (WP6: serving from a subdirectory still serves the whole repo's
// map), matching map-graph and the graph-* commands.
func runMapServe(argv []string) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "map-serve:", err)
		return 1
	}
	root := query.FindRepoRoot(cwd)
	opts := serve.ParseOptions(argv)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	return serve.Run(ctx, root, opts, os.Stdout, os.Stderr)
}
