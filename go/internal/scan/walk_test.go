package scan

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWalk_IgnoreHiddenAndSymlinks(t *testing.T) {
	root := t.TempDir()

	// Ignored by basename: a directory...
	mustWriteFile(t, filepath.Join(root, "node_modules", "ignored.txt"), "x")
	// ...and a FILE sharing an ignored basename.
	mustWriteFile(t, filepath.Join(root, "dist"), "x")

	// Dot-directory skipped (VIS_HIDDEN_DIR_ALLOWLIST is empty).
	mustWriteFile(t, filepath.Join(root, ".hidden", "nested.txt"), "x")
	// Dot-FILE kept (only directories are hidden-filtered).
	mustWriteFile(t, filepath.Join(root, ".dotfile"), "x")

	mustWriteFile(t, filepath.Join(root, "keepdir", "a.txt"), "x")
	mustWriteFile(t, filepath.Join(root, "keep.txt"), "x")

	if err := os.Symlink(filepath.Join(root, "keep.txt"), filepath.Join(root, "linkfile")); err != nil {
		t.Skipf("symlinks unsupported on this platform: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "keepdir"), filepath.Join(root, "linkdir")); err != nil {
		t.Skipf("symlinks unsupported on this platform: %v", err)
	}

	res, err := Walk(WalkOptions{Root: root})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{".dotfile", "keep.txt", "keepdir/a.txt"}
	if !reflect.DeepEqual(res.Files, want) {
		t.Errorf("Files = %v, want %v", res.Files, want)
	}
	if res.Truncated {
		t.Error("Truncated = true, want false")
	}
}

func TestWalk_UnreadableDirYieldsNothingNoError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root; permission bits are not enforced")
	}
	root := t.TempDir()
	secret := filepath.Join(root, "secretdir")
	mustMkdir(t, secret)
	mustWriteFile(t, filepath.Join(secret, "secret.txt"), "x")
	if err := os.Chmod(secret, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(secret, 0o755) }) // let TempDir cleanup succeed

	res, err := Walk(WalkOptions{Root: root})
	if err != nil {
		t.Fatalf("Walk returned an error, want nil (unreadable dirs are swallowed): %v", err)
	}
	if len(res.Files) != 0 {
		t.Errorf("Files = %v, want empty", res.Files)
	}
	if res.Truncated {
		t.Error("Truncated = true, want false")
	}
}

func TestWalk_TruncationSelectsLIFOSubset(t *testing.T) {
	// Sorted dirents at root: adir, bdir, m.txt. adir is pushed first, then
	// bdir — so bdir (pushed LAST) is popped and visited FIRST, before adir.
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "adir", "a1.txt"), "x")
	mustWriteFile(t, filepath.Join(root, "adir", "a2.txt"), "x")
	mustWriteFile(t, filepath.Join(root, "bdir", "b1.txt"), "x")
	mustWriteFile(t, filepath.Join(root, "m.txt"), "x")

	res, err := Walk(WalkOptions{Root: root, MaxFiles: 3})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if !res.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	// Pre-sort visit order is [m.txt, bdir/b1.txt, adir/a1.txt] (root's file
	// first, then bdir visited before adir, capped at 3 before adir/a2.txt is
	// ever reached). The final result is sorted ascending.
	want := []string{"adir/a1.txt", "bdir/b1.txt", "m.txt"}
	if !reflect.DeepEqual(res.Files, want) {
		t.Errorf("Files = %v, want %v (adir/a2.txt must be excluded by the cap)", res.Files, want)
	}
}

func TestWalk_DefaultMaxFilesAndOptions(t *testing.T) {
	if DefaultMaxFiles != 5000 {
		t.Errorf("DefaultMaxFiles = %d, want 5000", DefaultMaxFiles)
	}
	if MaxFileBytes != 1<<20 {
		t.Errorf("MaxFileBytes = %d, want %d", MaxFileBytes, 1<<20)
	}
	if len(DefaultIgnores) != 25 {
		t.Errorf("len(DefaultIgnores) = %d, want 25", len(DefaultIgnores))
	}
	if len(HiddenDirAllowlist) != 0 {
		t.Errorf("HiddenDirAllowlist = %v, want empty (defect 19)", HiddenDirAllowlist)
	}
}

func TestWalk_CustomIgnoresOverrideDefault(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "keepdir", "a.txt"), "x") // "keepdir" not in DefaultIgnores
	mustWriteFile(t, filepath.Join(root, "custom", "b.txt"), "x")

	res, err := Walk(WalkOptions{Root: root, Ignores: []string{"custom"}})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{"keepdir/a.txt"}
	if !reflect.DeepEqual(res.Files, want) {
		t.Errorf("Files = %v, want %v", res.Files, want)
	}
}
