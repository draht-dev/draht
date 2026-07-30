// Package hook ports `draht-tools graph-hook` (draht-tools.cjs:5573-5597):
// install/uninstall/status for a git post-commit hook that keeps MAP.json
// fresh. Unlike internal/query, this package WRITES files, so it is kept
// separate rather than folded into the pure query engine.
package hook

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Action is one of the three graph-hook subcommands.
type Action string

const (
	ActionStatus    Action = "status" // also the fallback for any unrecognized sub
	ActionInstall   Action = "install"
	ActionUninstall Action = "uninstall"
)

// BeginMarker/EndMarker delimit the managed block inside the post-commit
// hook file, verbatim from the CJS engine's BEGIN/END constants.
const (
	BeginMarker = "# >>> draht map-graph >>>"
	EndMarker   = "# <<< draht map-graph <<<"
)

// stripBlockRe ports the CJS's per-install regex:
//
//	new RegExp("\\n*" + escape(BEGIN) + "[\\s\\S]*?" + escape(END) + "\\n*", "g")
//
// "(?s)" makes "." match newlines too, mirroring JS's [\s\S] idiom.
var stripBlockRe = regexp.MustCompile(`(?s)\n*` + regexp.QuoteMeta(BeginMarker) + `.*?` + regexp.QuoteMeta(EndMarker) + `\n*`)

// leadingNewlinesRe ports the CJS's trailing `.replace(/^\n+/, "")` pass
// that runs after stripBlockRe.
var leadingNewlinesRe = regexp.MustCompile(`^\n+`)

// trailingNewlinesRe ports `cur.replace(/\n*$/, "\n")` used by install to
// normalize the hook body to end in exactly one newline before appending the
// managed block.
var trailingNewlinesRe = regexp.MustCompile(`\n*$`)

// stripBlock removes every occurrence of the BEGIN..END managed block
// (including surrounding blank lines it introduced) from s.
func stripBlock(s string) string {
	s = stripBlockRe.ReplaceAllString(s, "\n")
	return leadingNewlinesRe.ReplaceAllString(s, "")
}

func readHook(hookPath string) string {
	b, err := os.ReadFile(hookPath)
	if err != nil {
		return ""
	}
	return string(b)
}

// buildHookBody renders the managed block. The CJS interpolates
// `node "${__filename}"`; the Go binary is a standalone executable with no
// CJS-equivalent runtime, so the hook invokes selfPath directly instead of
// shelling out to node. This is the one place graph-hook output cannot be
// byte-identical to the CJS engine (a different absolute path, and a
// different launcher) — the surrounding message TEXT stays identical.
func buildHookBody(selfPath string) string {
	return fmt.Sprintf("%s\n\"%s\" map-graph --quiet 2>/dev/null || true\n%s", BeginMarker, selfPath, EndMarker)
}

// Run ports graph-hook (cjs:5573-5597). cwd is process.cwd() (NOT the repo
// root — the CJS checks cwd/.git literally, so running from a subdirectory
// of a valid repo prints "not a git repository (no .git)"; replicate this
// faithfully, it is not a bug). selfPath is the absolute path of the running
// binary, interpolated into the installed hook body. argv[0] (if present) is
// the subcommand; any value other than "install"/"uninstall" — including
// nothing, "status", or garbage — falls through to the status branch.
func Run(cwd, selfPath string, argv []string, w io.Writer) int {
	sub := string(ActionStatus)
	if len(argv) > 0 {
		sub = argv[0]
	}

	gitDir := filepath.Join(cwd, ".git")
	if _, err := os.Stat(gitDir); err != nil {
		fmt.Fprintln(w, "not a git repository (no .git)")
		return 0
	}
	hookPath := filepath.Join(gitDir, "hooks", "post-commit")

	switch sub {
	case string(ActionInstall):
		return runInstall(cwd, hookPath, selfPath, w)
	case string(ActionUninstall):
		return runUninstall(hookPath, w)
	default:
		return runStatus(hookPath, w)
	}
}

func runInstall(cwd, hookPath, selfPath string, w io.Writer) int {
	cur := readHook(hookPath)
	if strings.Contains(cur, BeginMarker) {
		cur = stripBlock(cur)
	}
	if strings.TrimSpace(cur) == "" {
		cur = "#!/bin/sh\n"
	}
	cur = trailingNewlinesRe.ReplaceAllString(cur, "\n")
	next := cur + "\n" + buildHookBody(selfPath) + "\n"

	if err := os.MkdirAll(filepath.Dir(hookPath), 0o755); err != nil {
		fmt.Fprintf(w, "graph-hook: mkdir %s: %v\n", filepath.Dir(hookPath), err)
		return 1
	}
	if err := os.WriteFile(hookPath, []byte(next), 0o644); err != nil {
		fmt.Fprintf(w, "graph-hook: write %s: %v\n", hookPath, err)
		return 1
	}
	// chmodSync errors are swallowed in the CJS (try/catch with an empty
	// body); mirror that rather than failing the command over a chmod
	// that doesn't affect the hook's content.
	_ = os.Chmod(hookPath, 0o755)

	rel, err := filepath.Rel(cwd, hookPath)
	if err != nil {
		rel = hookPath
	}
	fmt.Fprintf(w, "installed post-commit hook → %s\n  refreshes .planning/codebase/MAP.json after each commit (lands in the next commit).\n", rel)
	return 0
}

func runUninstall(hookPath string, w io.Writer) int {
	cur := readHook(hookPath)
	if !strings.Contains(cur, BeginMarker) {
		fmt.Fprintln(w, "draht hook not installed.")
		return 0
	}
	next := stripBlock(cur)
	trimmed := strings.TrimSpace(next)
	if trimmed != "" && trimmed != "#!/bin/sh" {
		_ = os.WriteFile(hookPath, []byte(next), 0o644)
	} else {
		_ = os.Remove(hookPath)
	}
	fmt.Fprintln(w, "removed draht post-commit hook block.")
	return 0
}

func runStatus(hookPath string, w io.Writer) int {
	cur := readHook(hookPath)
	if strings.Contains(cur, BeginMarker) {
		fmt.Fprintln(w, "draht post-commit hook: INSTALLED")
	} else {
		fmt.Fprintln(w, "draht post-commit hook: not installed (run `draht-tools graph-hook install`)")
	}
	return 0
}
