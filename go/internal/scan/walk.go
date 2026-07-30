package scan

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DefaultIgnores is the verbatim 25-token ignore list from
// draht-tools.cjs:1100-1105 (VIS_DEFAULT_IGNORES). Matched on basename, at
// every depth, against both files and directories.
var DefaultIgnores = []string{
	"node_modules", ".git", "dist", "build", "out", "target", ".next",
	".turbo", ".cache", "coverage", ".nyc_output", ".planning",
	".venv", "venv", "__pycache__", ".pytest_cache", ".idea", ".vscode",
	".DS_Store", ".sst", ".astro", ".svelte-kit", "vendor", "tmp", ".tmp",
}

// defaultIgnoreSet is DefaultIgnores as a lookup set. Used both by Walk (when
// the caller does not override Ignores) and by ExpandWorkspacePattern, which
// always consults VIS_DEFAULT_IGNORES directly regardless of any caller
// configuration (draht-tools.cjs:1666,1680,1694).
var defaultIgnoreSet = toSet(DefaultIgnores)

// HiddenDirAllowlist is intentionally empty: no dot-directory is ever
// walked (VIS_HIDDEN_DIR_ALLOWLIST, draht-tools.cjs:1265 — "defect 19":
// .github, .changeset, .dev etc. must NOT be walked). Kept as a named slice
// so the rule is documented, not implicit.
var HiddenDirAllowlist []string

const (
	// DefaultMaxFiles caps the walk (matches the CJS engine's cap).
	DefaultMaxFiles = 5000
	// MaxFileBytes is the strict "<" read gate (1 MiB).
	MaxFileBytes = 1 << 20
)

// WalkOptions configures Walk.
type WalkOptions struct {
	Root     string
	MaxFiles int
	Ignores  []string
}

// WalkResult is the sorted file list produced by Walk.
type WalkResult struct {
	// Files are repo-relative POSIX paths, sorted ascending.
	Files     []string
	Truncated bool
}

func toSet(names []string) map[string]struct{} {
	m := make(map[string]struct{}, len(names))
	for _, n := range names {
		m[n] = struct{}{}
	}
	return m
}

func isDefaultIgnored(name string) bool {
	_, ok := defaultIgnoreSet[name]
	return ok
}

// Walk performs the LIFO directory walk described in design §6 (WP-A
// walk.go): os.ReadDir per directory, re-sorted ascending by name,
// subdirectories pushed onto a LIFO stack (alphabetically-last visited
// first), files appended, symlinks dropped, unreadable directories
// swallowed, final result sort.Strings'd. Verbatim port of visWalk
// (draht-tools.cjs:1268-1295).
//
// Never returns an error for filesystem conditions (unreadable root,
// unreadable subdirectories) — those degrade to an empty/partial result,
// matching the CJS engine exactly. An error is returned only if opts.Root
// cannot be resolved to an absolute path at all.
func Walk(opts WalkOptions) (WalkResult, error) {
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return WalkResult{}, fmt.Errorf("scan: resolve walk root: %w", err)
	}

	maxFiles := opts.MaxFiles
	if maxFiles <= 0 {
		maxFiles = DefaultMaxFiles
	}

	ignore := defaultIgnoreSet
	if len(opts.Ignores) > 0 {
		ignore = toSet(opts.Ignores)
	}

	allow := toSet(HiddenDirAllowlist)

	var files []string
	stack := []string{root}
	truncated := false

outer:
	for len(stack) > 0 && len(files) < maxFiles {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

		for _, e := range entries {
			name := e.Name()
			if _, skip := ignore[name]; skip {
				continue
			}
			if e.IsDir() && strings.HasPrefix(name, ".") {
				if _, ok := allow[name]; !ok {
					continue
				}
			}
			full := filepath.Join(dir, name)
			if e.IsDir() {
				stack = append(stack, full)
			} else if e.Type().IsRegular() {
				// Symlinks (to files or directories) match neither IsDir()
				// nor Type().IsRegular() and are silently dropped, matching
				// visWalk's lstat-based dirents.
				files = append(files, full)
			}
			if len(files) >= maxFiles {
				truncated = true
				break outer
			}
		}
	}

	rel := make([]string, 0, len(files))
	for _, abs := range files {
		r, err := filepath.Rel(root, abs)
		if err != nil {
			r = abs
		}
		rel = append(rel, filepath.ToSlash(r))
	}
	sort.Strings(rel)

	return WalkResult{Files: rel, Truncated: truncated}, nil
}
