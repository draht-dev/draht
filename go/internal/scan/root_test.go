package scan

import (
	"path/filepath"
	"testing"
)

func TestFindRepoRoot_GitFileGitlinkCounts(t *testing.T) {
	root := t.TempDir()
	// A worktree/submodule ".git" is a FILE, not a directory. existsSync (and
	// therefore fileExists) makes no distinction — it must still resolve.
	mustWriteFile(t, filepath.Join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n")
	sub := filepath.Join(root, "a", "b")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if got != root {
		t.Errorf("FindRepoRoot(%q) = %q, want %q", sub, got, root)
	}
}

func TestFindRepoRoot_NearestGitWins(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, ".git"))
	nested := filepath.Join(root, "nested")
	mustMkdir(t, filepath.Join(nested, ".git"))
	sub := filepath.Join(nested, "x")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if got != nested {
		t.Errorf("FindRepoRoot(%q) = %q, want nested %q (not ancestor %q)", sub, got, nested, root)
	}
}

func TestFindRepoRoot_PnpmWorkspaceFallback(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n")
	sub := filepath.Join(root, "packages", "foo")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if got != root {
		t.Errorf("FindRepoRoot(%q) = %q, want %q", sub, got, root)
	}
}

func TestFindRepoRoot_WorkspacesFieldFallback(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "package.json"), `{"name":"root","workspaces":["packages/*"]}`)
	sub := filepath.Join(root, "packages", "foo")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if got != root {
		t.Errorf("FindRepoRoot(%q) = %q, want %q", sub, got, root)
	}
}

func TestFindRepoRoot_EmptyArrayWorkspacesIsStillTruthy(t *testing.T) {
	// JS truthiness: an empty array is truthy (`if ([])` is true).
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "package.json"), `{"name":"root","workspaces":[]}`)
	sub := filepath.Join(root, "sub")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	if got != root {
		t.Errorf("FindRepoRoot(%q) = %q, want %q", sub, got, root)
	}
}

func TestFindRepoRoot_NoMarkerFallsBackToStart(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "a", "b")
	mustMkdir(t, sub)

	got, err := FindRepoRoot(sub)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	want, _ := filepath.Abs(sub)
	if got != want {
		t.Errorf("FindRepoRoot(%q) = %q, want %q (no marker found anywhere)", sub, got, want)
	}
}

func TestGraphOutDirAndCacheDir(t *testing.T) {
	root := "/repo"
	if got, want := GraphOutDir(root), filepath.Join("/repo", ".planning", "codebase"); got != want {
		t.Errorf("GraphOutDir = %q, want %q", got, want)
	}
	if got, want := CacheDir(root), filepath.Join("/repo", ".planning", "codebase", ".cache", "graph-v1"); got != want {
		t.Errorf("CacheDir = %q, want %q", got, want)
	}
}
