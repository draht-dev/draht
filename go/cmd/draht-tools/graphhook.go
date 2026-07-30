package main

import (
	"fmt"
	"os"

	"github.com/draht-dev/draht/go/internal/hook"
)

// runGraphHook wires `draht-tools graph-hook [install|uninstall|status]`.
// selfPath is the running binary's own absolute path (os.Executable falls
// back to os.Args[0] on the rare platform/sandbox where it errors) — see
// internal/hook's doc comment for why this, not `node <cjs path>`, is what
// gets interpolated into the installed hook body.
func runGraphHook(argv []string) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "graph-hook:", err)
		return 1
	}
	selfPath, err := os.Executable()
	if err != nil {
		selfPath = os.Args[0]
	}
	return hook.Run(cwd, selfPath, argv, os.Stdout)
}
