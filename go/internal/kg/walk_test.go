package kg

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A checkout whose only code files are ignored has no files: the directory
// walk, which does not read .gitignore, must not take over.
func TestWalk_EmptyGitResultKeepsIgnores(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available on PATH")
	}
	root := t.TempDir()
	if err := exec.Command("git", "-C", root, "init", "-q").Run(); err != nil {
		t.Skipf("git init: %v", err)
	}
	write := func(rel, text string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".gitignore", "generated/\n")
	write("A.java", "class A {}\n")
	write("generated/client.js", "export function gen() {}\n")
	if files := walk(root); len(files) != 0 {
		t.Fatalf("walk = %v, want no files", files)
	}
}

// cmdWriteFile replaces a file through a sibling temporary file and leaves
// none behind.
func TestCmdWriteFile_ReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "graph.json")
	for _, data := range []string{"one", "two"} {
		if err := cmdWriteFile(p, data); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(p)
		if err != nil || string(got) != data {
			t.Fatalf("read %q, %v; want %q", got, err, data)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "graph.json" {
		t.Fatalf("left behind: %v", entries)
	}
	// a target whose name is already as long as a name can be
	long := filepath.Join(dir, strings.Repeat("x", 250)+".html")
	if err := cmdWriteFile(long, "data"); err != nil {
		t.Fatalf("long name: %v", err)
	}
	if err := cmdWriteFile(filepath.Join(dir, "missing", "x"), "data"); err == nil {
		t.Fatal("want an error for a missing directory")
	}
}
