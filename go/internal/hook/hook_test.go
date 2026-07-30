package hook

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func mkGitRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	return root
}

func TestRun_NotAGitRepo(t *testing.T) {
	root := t.TempDir() // no .git
	var buf bytes.Buffer
	code := Run(root, "/abs/self", nil, &buf)
	if code != 0 {
		t.Fatalf("code = %d, want 0", code)
	}
	if got, want := buf.String(), "not a git repository (no .git)\n"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
}

func TestRun_StatusDefaultAndUnrecognizedSub(t *testing.T) {
	root := mkGitRepo(t)
	for _, argv := range [][]string{nil, {"status"}, {"bogus"}} {
		var buf bytes.Buffer
		code := Run(root, "/abs/self", argv, &buf)
		if code != 0 {
			t.Fatalf("code = %d, want 0", code)
		}
		want := "draht post-commit hook: not installed (run `draht-tools graph-hook install`)\n"
		if got := buf.String(); got != want {
			t.Errorf("argv=%v output = %q, want %q", argv, got, want)
		}
	}
}

func TestRun_InstallThenStatusThenUninstall(t *testing.T) {
	root := mkGitRepo(t)
	self := "/abs/path/to/draht-tools"

	var buf bytes.Buffer
	code := Run(root, self, []string{"install"}, &buf)
	if code != 0 {
		t.Fatalf("install code = %d, want 0", code)
	}
	want := "installed post-commit hook → .git/hooks/post-commit\n  refreshes .planning/codebase/MAP.json after each commit (lands in the next commit).\n"
	if got := buf.String(); got != want {
		t.Errorf("install output = %q, want %q", got, want)
	}

	hookPath := filepath.Join(root, ".git", "hooks", "post-commit")
	content, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatalf("read hook: %v", err)
	}
	wantContent := "#!/bin/sh\n\n# >>> draht map-graph >>>\n\"/abs/path/to/draht-tools\" map-graph --quiet 2>/dev/null || true\n# <<< draht map-graph <<<\n"
	if string(content) != wantContent {
		t.Errorf("hook content = %q, want %q", content, wantContent)
	}
	info, err := os.Stat(hookPath)
	if err != nil {
		t.Fatalf("stat hook: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("hook mode = %v, want 0755", info.Mode().Perm())
	}

	// Reinstalling is idempotent: same output, same content (no duplicate
	// blocks).
	buf.Reset()
	code = Run(root, self, []string{"install"}, &buf)
	if code != 0 {
		t.Fatalf("reinstall code = %d, want 0", code)
	}
	if got := buf.String(); got != want {
		t.Errorf("reinstall output = %q, want %q", got, want)
	}
	content2, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatalf("read hook after reinstall: %v", err)
	}
	if string(content2) != wantContent {
		t.Errorf("hook content after reinstall = %q, want %q (no duplicate block)", content2, wantContent)
	}

	buf.Reset()
	code = Run(root, self, []string{"status"}, &buf)
	if code != 0 {
		t.Fatalf("status code = %d, want 0", code)
	}
	if got, want := buf.String(), "draht post-commit hook: INSTALLED\n"; got != want {
		t.Errorf("status output = %q, want %q", got, want)
	}

	buf.Reset()
	code = Run(root, self, []string{"uninstall"}, &buf)
	if code != 0 {
		t.Fatalf("uninstall code = %d, want 0", code)
	}
	if got, want := buf.String(), "removed draht post-commit hook block.\n"; got != want {
		t.Errorf("uninstall output = %q, want %q", got, want)
	}
	if _, err := os.Stat(hookPath); !os.IsNotExist(err) {
		t.Errorf("expected hook file to be removed (remainder was only the shebang), got err=%v", err)
	}

	buf.Reset()
	code = Run(root, self, []string{"uninstall"}, &buf)
	if code != 0 {
		t.Fatalf("second uninstall code = %d, want 0", code)
	}
	if got, want := buf.String(), "draht hook not installed.\n"; got != want {
		t.Errorf("second uninstall output = %q, want %q", got, want)
	}
}

// TestRun_InstallPreservesExistingHookContent covers the fallback where an
// existing, non-draht hook script's content survives around the managed
// block, and where uninstall leaves the surviving content in place (only
// removing the file when nothing but the shebang would remain).
func TestRun_InstallPreservesExistingHookContent(t *testing.T) {
	root := mkGitRepo(t)
	hookPath := filepath.Join(root, ".git", "hooks", "post-commit")
	if err := os.MkdirAll(filepath.Dir(hookPath), 0o755); err != nil {
		t.Fatalf("mkdir hooks dir: %v", err)
	}
	if err := os.WriteFile(hookPath, []byte("#!/bin/sh\necho custom\n"), 0o755); err != nil {
		t.Fatalf("seed hook: %v", err)
	}

	var buf bytes.Buffer
	if code := Run(root, "/self", []string{"install"}, &buf); code != 0 {
		t.Fatalf("install code = %d, want 0", code)
	}
	content, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatalf("read hook: %v", err)
	}
	wantContent := "#!/bin/sh\necho custom\n\n# >>> draht map-graph >>>\n\"/self\" map-graph --quiet 2>/dev/null || true\n# <<< draht map-graph <<<\n"
	if string(content) != wantContent {
		t.Errorf("hook content = %q, want %q", content, wantContent)
	}

	buf.Reset()
	if code := Run(root, "/self", []string{"uninstall"}, &buf); code != 0 {
		t.Fatalf("uninstall code = %d, want 0", code)
	}
	content2, err := os.ReadFile(hookPath)
	if err != nil {
		t.Fatalf("read hook after uninstall (should survive): %v", err)
	}
	if string(content2) != "#!/bin/sh\necho custom\n" {
		t.Errorf("hook content after uninstall = %q, want the original custom script preserved", content2)
	}
}
