package scan

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// PlanningDir is the ".planning" directory name, relative to repo root.
const PlanningDir = ".planning"

// fileExists reports whether p exists (following symlinks), matching Node's
// fs.existsSync.
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// FindRepoRoot resolves the repository root from cwd: pass 1 looks for a
// ".git" entry (file or directory, nearest wins); pass 2 looks for
// pnpm-workspace.yaml then a package.json with a truthy `workspaces` field;
// fallback is filepath.Abs(cwd). Verbatim port of findRepoRoot
// (draht-tools.cjs:91-111): two independent walks to the filesystem root.
func FindRepoRoot(cwd string) (string, error) {
	start, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("scan: resolve cwd %q: %w", cwd, err)
	}

	// Pass 1: nearest ancestor (inclusive) containing a ".git" entry. A
	// worktree/submodule gitlink ".git" FILE counts, not just a directory —
	// existsSync makes no distinction, and neither do we.
	dir := start
	for {
		if fileExists(filepath.Join(dir, ".git")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	// Pass 2: restart at start, look for pnpm-workspace.yaml or a
	// package.json with a truthy `workspaces` field.
	dir = start
	for {
		if fileExists(filepath.Join(dir, "pnpm-workspace.yaml")) {
			return dir, nil
		}
		if hasWorkspacesField(filepath.Join(dir, "package.json")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return start, nil
}

// hasWorkspacesField reports whether pkgJSONPath exists, parses as JSON, and
// has a truthy `workspaces` field (JS truthiness: false/0/""/null/undefined
// are falsy; everything else — including an empty array or object — is
// truthy). Any read/parse error is swallowed, matching the CJS try/catch.
func hasWorkspacesField(pkgJSONPath string) bool {
	data, err := os.ReadFile(pkgJSONPath)
	if err != nil {
		return false
	}
	var pj struct {
		Workspaces json.RawMessage `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &pj); err != nil {
		return false
	}
	if len(pj.Workspaces) == 0 {
		return false
	}
	var v any
	if err := json.Unmarshal(pj.Workspaces, &v); err != nil {
		return false
	}
	return jsTruthy(v)
}

// jsTruthy reproduces JavaScript truthiness for a decoded JSON value.
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	default:
		// Arrays ([]any) and objects (map[string]any) are always truthy in
		// JS, regardless of contents (an empty array/object is truthy).
		return true
	}
}

// GraphOutDir returns "<repoRoot>/.planning/codebase".
func GraphOutDir(repoRoot string) string {
	return filepath.Join(repoRoot, PlanningDir, "codebase")
}

// CacheDir returns "<repoRoot>/.planning/codebase/.cache/graph-v1" (see
// design §5.1 — this directory is NOT covered by the root .gitignore, so
// cache.NewFileStore self-ignores on first Commit).
func CacheDir(repoRoot string) string {
	return filepath.Join(GraphOutDir(repoRoot), ".cache", "graph-v1")
}
