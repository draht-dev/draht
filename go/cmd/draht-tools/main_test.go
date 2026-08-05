package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/langset"
)

// binPath is the real CLI binary, built once in TestMain (not per-test:
// `go build` costs real wall time, and every test in this file needs the
// SAME binary — there is no per-test state it could leak). This is the
// standard way to test a package whose only entry point is func main()
// (which calls os.Exit and so cannot be called in-process without killing
// the test binary itself): build it, exec it as a subprocess, assert on its
// stdout/stderr/exit code — the exact same interface a real caller sees.
var binPath string

func runBinary(t *testing.T, executable, home string, args ...string) (string, string, int) {
	t.Helper()
	cmd := exec.Command(executable, args...)
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatalf("run managed binary: %v", err)
	}
	return stdout.String(), stderr.String(), code
}

func managedBinary(t *testing.T) (string, string, []byte) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".draht", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "draht-graph")
	if err := os.WriteFile(target, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return home, target, data
}

func writeManagedStamp(t *testing.T, target string, data []byte) {
	t.Helper()
	sum := sha256.Sum256(data)
	stamp := map[string]any{"name": "draht-graph", "version": "test", "schemaVersion": 5, "sha256": hex.EncodeToString(sum[:]), "size": len(data)}
	b, _ := json.Marshal(stamp)
	if err := os.WriteFile(filepath.Join(filepath.Dir(target), ".draht-graph.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestManagedBinaryFailsClosedOnMissingMalformedAndTamperedStamp(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(*testing.T, string, []byte)
	}{
		{"missing", func(*testing.T, string, []byte) {}},
		{"malformed", func(t *testing.T, target string, _ []byte) {
			_ = os.WriteFile(filepath.Join(filepath.Dir(target), ".draht-graph.json"), []byte("{bad"), 0o600)
		}},
		{"same-size-tampered", func(t *testing.T, target string, data []byte) {
			writeManagedStamp(t, target, data)
			data[len(data)/2] ^= 1
			_ = os.WriteFile(target, data, 0o755)
		}},
		{"stamp-before-binary", func(t *testing.T, target string, data []byte) {
			replacement := append([]byte(nil), data...)
			replacement[len(replacement)/3] ^= 1
			writeManagedStamp(t, target, replacement)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, target, data := managedBinary(t)
			tc.prepare(t, target, data)
			_, stderr, code := runBinary(t, target, home, "--version")
			if code == 0 {
				t.Fatalf("managed binary executed despite %s stamp", tc.name)
			}
			if !strings.Contains(stderr, "managed integrity") {
				t.Fatalf("stderr %q does not explain managed integrity failure", stderr)
			}
		})
	}
}

func TestManagedBinaryWithValidStampAndStandaloneBinaryStillExecute(t *testing.T) {
	home, target, data := managedBinary(t)
	writeManagedStamp(t, target, data)
	if _, stderr, code := runBinary(t, target, home, "--version"); code != 0 {
		t.Fatalf("valid managed binary failed: %s", stderr)
	}
	if _, stderr, code := runBinary(t, binPath, home, "--version"); code != 0 {
		t.Fatalf("standalone binary failed: %s", stderr)
	}
}

func TestManagedPathSymlinkCannotBypassMissingStamp(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".draht", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "draht-graph")
	if err := os.Symlink(binPath, target); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	_, stderr, code := runBinary(t, target, home, "--version")
	if code == 0 || !strings.Contains(stderr, "managed integrity") {
		t.Fatalf("managed symlink bypassed missing stamp: code=%d stderr=%q", code, stderr)
	}
}

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "draht-tools-maintest-*")
	if err != nil {
		fmt.Fprintln(os.Stderr, "mkdtemp:", err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)

	binPath = filepath.Join(dir, "draht-tools")
	// A bare `go build` does NOT inherit the outer `go test -tags …` — so
	// without forwarding langset.BuildTags explicitly here, the tagged CI
	// pass would silently test an all-206-grammar binary for everything
	// under ./cmd/..., giving false confidence exactly where the shipped
	// binary lives. Always build the shipped grammar-subset configuration.
	tags := strings.Join(langset.BuildTags(langset.CLILanguages), " ")
	build := exec.Command("go", "build", "-tags", tags, "-o", binPath, ".")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "go build cmd/draht-tools: %v\n%s\n", err, out)
		os.Exit(1)
	}

	os.Exit(m.Run())
}

// newTinyRepo builds a minimal, self-contained repo (a ".git" marker file so
// scan.FindRepoRoot resolves to it, plus one real TS module) in a fresh temp
// directory, so map-graph's real end-to-end path (discover -> extract ->
// assemble -> write) has something small and fast to index.
func newTinyRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: nowhere\n"), 0o644); err != nil {
		t.Fatalf("write .git marker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.ts"), []byte("export const x = 1;\n"), 0o644); err != nil {
		t.Fatalf("write index.ts: %v", err)
	}
	return root
}

// runCLI execs the built binary with args and cwd=dir, returning
// stdout/stderr/exit code. Never fails the test on a non-zero exit — that is
// exactly what several of these tests assert on.
func runCLI(t *testing.T, dir string, args ...string) (stdout, stderr string, exitCode int) {
	t.Helper()
	cmd := exec.Command(binPath, args...)
	cmd.Dir = dir
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	exitCode = 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			t.Fatalf("run %s %v: %v", binPath, args, err)
		}
	}
	return outBuf.String(), errBuf.String(), exitCode
}

// TestUnknownCommand_ExitCodeAndStderr covers the finding's "unknown-command
// exit code plus stderr text" gap.
func TestUnknownCommand_ExitCodeAndStderr(t *testing.T) {
	stdout, stderr, code := runCLI(t, t.TempDir(), "bogus-command")
	if code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if stdout != "" {
		t.Errorf("expected empty stdout, got %q", stdout)
	}
	const want = "Unknown command: bogus-command\nRun: draht-tools help\n"
	if stderr != want {
		t.Errorf("stderr = %q, want %q", stderr, want)
	}
}

// TestNoArgs_ExitCodeAndStderr covers the len(os.Args) < 2 branch (a
// distinct code path from the "unknown command" default case — the message
// text differs, an empty command name rather than a named one).
func TestNoArgs_ExitCodeAndStderr(t *testing.T) {
	stdout, stderr, code := runCLI(t, t.TempDir())
	if code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if stdout != "" {
		t.Errorf("expected empty stdout, got %q", stdout)
	}
	const want = "Unknown command: \nRun: draht-tools help\n"
	if stderr != want {
		t.Errorf("stderr = %q, want %q", stderr, want)
	}
}

// quietOutputRe matches map-graph --quiet's single-line stdout contract
// (this is the exact string the gsd-post-phase hook parses/depends on — see
// design §7/D7): "map-graph: <N> modules · schemaVersion <V> · <ms>ms → <path>".
var quietOutputRe = regexp.MustCompile(`^map-graph: \d+ modules · schemaVersion 5 · \d+ms → .+MAP\.json\n$`)

// TestMapGraphQuiet_StdoutMatchesHookContract covers the finding's
// "--quiet stdout regex (byte-parity hook path per D7)" gap: runs the real
// binary end-to-end over a tiny real repo and asserts stdout is exactly the
// single line the gsd-post-phase hook depends on, with exit 0.
func TestMapGraphQuiet_StdoutMatchesHookContract(t *testing.T) {
	root := newTinyRepo(t)
	outDir := t.TempDir()
	cacheDir := t.TempDir()

	stdout, stderr, code := runCLI(t, root, "map-graph", "--quiet",
		"--out", outDir, "--cache-dir", cacheDir)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, stderr)
	}
	if !quietOutputRe.MatchString(stdout) {
		t.Errorf("stdout = %q, want a single line matching %s", stdout, quietOutputRe.String())
	}

	mapPath := filepath.Join(outDir, "MAP.json")
	if _, err := os.Stat(mapPath); err != nil {
		t.Errorf("expected %s to exist: %v", mapPath, err)
	}
}

// dirNoteRe matches the informational note runMapGraph prints when a `dir`
// positional argument doesn't match the resolved repo root (design/WP6
// defect 22: the graph always maps the whole repo regardless of `dir`).
var dirNoteRe = regexp.MustCompile(`^note: map-graph always maps the whole repo \(.+\); '.+' ignored for the graph\n`)

// TestMapGraphQuiet_DirArgPrintsNoteButStillMapsWholeRepo covers the
// finding's "'[dir]' note line" gap.
func TestMapGraphQuiet_DirArgPrintsNoteButStillMapsWholeRepo(t *testing.T) {
	root := newTinyRepo(t)
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", sub, err)
	}
	outDir := t.TempDir()
	cacheDir := t.TempDir()

	// A relative "dir" arg that resolves (via filepath.Abs against the
	// process cwd, which is `root`) to a path other than repoRoot itself.
	stdout, stderr, code := runCLI(t, root, "map-graph", "sub",
		"--out", outDir, "--cache-dir", cacheDir)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, stderr)
	}
	if !dirNoteRe.MatchString(stdout) {
		t.Errorf("stdout = %q, want it to start with a note matching %s", stdout, dirNoteRe.String())
	}

	// The note must not change what gets mapped: index.ts (at repo root,
	// OUTSIDE the ignored `sub` dir) must still show up.
	mapBytes, err := os.ReadFile(filepath.Join(outDir, "MAP.json"))
	if err != nil {
		t.Fatalf("read MAP.json: %v", err)
	}
	if !bytes.Contains(mapBytes, []byte(`"path": "index.ts"`)) {
		t.Errorf("expected MAP.json to still include the whole repo's index.ts despite the 'sub' dir arg")
	}
}

// gotreesitterVersionOutRe extracts the version --version prints.
var gotreesitterVersionOutRe = regexp.MustCompile(`gotreesitter@(\S+)\)`)

// TestVersion_MatchesGoModGotreesitterVersion is the end-to-end half of the
// review finding about parse.Parser.Version() hardcoding the gotreesitter
// library version as a string literal (fixed via debug.ReadBuildInfo — see
// internal/parse/treesitter.go's gotreesitterVersion). debug.ReadBuildInfo
// does not populate a `go test`-compiled binary's dependency list (a
// documented Go toolchain limitation — see
// internal/parse/version_test.go's TestGotreesitterVersion_FallsBackGracefully),
// so THIS is the test that actually proves a normally `go build`-compiled
// binary resolves the real, current go.mod-pinned version rather than a
// stale hardcoded literal: a `go get -u` of gotreesitter would change
// go.mod's version and this test would immediately catch a binary that
// still reports the old one.
func TestVersion_MatchesGoModGotreesitterVersion(t *testing.T) {
	stdout, stderr, code := runCLI(t, t.TempDir(), "--version")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, stderr)
	}
	m := gotreesitterVersionOutRe.FindStringSubmatch(stdout)
	if m == nil {
		t.Fatalf("--version output %q does not contain a gotreesitter@<version> component", stdout)
	}
	gotVersion := m[1]

	goModPath := filepath.Join("..", "..", "go.mod")
	data, err := os.ReadFile(goModPath)
	if err != nil {
		t.Fatalf("read %s: %v", goModPath, err)
	}
	reqRe := regexp.MustCompile(`(?m)^require github\.com/odvcencio/gotreesitter (\S+)$`)
	want := reqRe.FindSubmatch(data)
	if want == nil {
		t.Fatalf("could not find gotreesitter require line in %s", goModPath)
	}
	if gotVersion != string(want[1]) {
		t.Errorf("--version reports gotreesitter@%s, want %s (go.mod's pinned version) — "+
			"the binary's cache key no longer tracks the real dependency", gotVersion, want[1])
	}
}

// TestHelp_PrintsUsage is a light smoke test for the -h/--help/help paths
// (three switch cases collapsing to the same behaviour).
func TestHelp_PrintsUsage(t *testing.T) {
	for _, flag := range []string{"-h", "--help", "help"} {
		t.Run(flag, func(t *testing.T) {
			stdout, _, code := runCLI(t, t.TempDir(), flag)
			if code != 0 {
				t.Errorf("exit code = %d, want 0", code)
			}
			if !bytes.Contains([]byte(stdout), []byte("Usage: draht-tools map-graph")) {
				t.Errorf("stdout does not contain usage text: %q", stdout)
			}
		})
	}
}
