package scan

import (
	"context"
	"path/filepath"
	"testing"
)

func TestGitFiles_TrackedUntrackedAndIgnored(t *testing.T) {
	requireGit(t)
	root := t.TempDir()
	runGit(t, root, "init", "-q")

	mustWriteFile(t, filepath.Join(root, "tracked.txt"), "a")
	mustWriteFile(t, filepath.Join(root, "untracked.txt"), "b")
	mustWriteFile(t, filepath.Join(root, "ignored.txt"), "c")
	mustWriteFile(t, filepath.Join(root, ".gitignore"), "ignored.txt\n")

	runGit(t, root, "add", "tracked.txt", ".gitignore")
	runGit(t, root, "commit", "-q", "-m", "init")

	files, ok := GitFiles(context.Background(), root)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	set := toSet(files)
	for _, want := range []string{"tracked.txt", "untracked.txt", ".gitignore"} {
		if _, present := set[want]; !present {
			t.Errorf("%q missing from GitFiles result: %v", want, files)
		}
	}
	if _, present := set["ignored.txt"]; present {
		t.Errorf("ignored.txt should be excluded, got %v", files)
	}
}

func TestGitFiles_NonRepoFallsBack(t *testing.T) {
	requireGit(t)
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "file.txt"), "x")

	files, ok := GitFiles(context.Background(), root)
	if ok {
		t.Errorf("ok = true for a non-repository directory, want false (files=%v)", files)
	}
	if files != nil {
		t.Errorf("files = %v, want nil when ok=false", files)
	}
}
