package kg

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestParity_MatchesCJSEngine is the acceptance gate of the port: for every
// fixture repository the Go engine and the JavaScript engine
// (packages/draht-tools/bin/draht-kg.cjs) must write the same graph.json and
// the same report and export files, byte for byte, and print the same
// stdout / stderr with the same exit code for every subcommand. Nothing is
// normalized away except the build duration (`· 12ms`).
//
// Fixtures: testdata/parity/* (the fixture repositories of the JavaScript
// engine's own test suite, one per behaviour it pins: Go package scopes, Rust
// module trees, Python src layouts and re-exports, TS barrels, CommonJS, id
// collisions, …), internal/graph's multi-language fixture repo, and a slice of
// this monorepo's real sources.
//
// Like internal/graph's parity test it shells out to node, so it is skipped in
// -short mode and when node is not on PATH.
func TestParity_MatchesCJSEngine(t *testing.T) {
	if os.Getenv("PARITY_SKIP") != "" {
		t.Skip("PARITY_SKIP set")
	}
	if testing.Short() {
		t.Skip("skipping CJS-shellout parity check in -short mode")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available on PATH")
	}
	pkgDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	monorepo := filepath.Clean(filepath.Join(pkgDir, "..", "..", ".."))
	cjs := filepath.Join(monorepo, "packages", "draht-tools", "bin", "draht-kg.cjs")
	if _, err := os.Stat(cjs); err != nil {
		t.Skipf("CJS engine not found at %s: %v", cjs, err)
	}

	type fixture struct {
		name string
		srcs map[string]string // destination subdirectory -> source directory
	}
	var fixtures []fixture
	entries, err := os.ReadDir(filepath.Join(pkgDir, "testdata", "parity"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() {
			fixtures = append(fixtures, fixture{e.Name(), map[string]string{"": filepath.Join(pkgDir, "testdata", "parity", e.Name())}})
		}
	}
	fixtures = append(fixtures,
		fixture{"graph-fixture-repo", map[string]string{"": filepath.Join(pkgDir, "..", "graph", "testdata", "fixture-repo")}},
		fixture{"monorepo-slice", map[string]string{
			"go/internal/kg":       pkgDir,
			"go/internal/cluster":  filepath.Join(pkgDir, "..", "cluster"),
			"packages/tui/src":     filepath.Join(monorepo, "packages", "tui", "src"),
			"packages/agent/src":   filepath.Join(monorepo, "packages", "agent", "src"),
			"packages/draht-tools": filepath.Join(monorepo, "packages", "draht-tools", "test"),
		}},
	)

	for _, fx := range fixtures {
		t.Run(fx.name, func(t *testing.T) {
			// One directory for both engines, run one after the other: the
			// output names the absolute path of what was written.
			root := t.TempDir()
			if resolved, err := filepath.EvalSymlinks(root); err == nil {
				root = resolved
			}
			for dst, src := range fx.srcs {
				copyTree(t, src, filepath.Join(root, filepath.FromSlash(dst)))
			}
			runJS := func(args ...string) cmdResult {
				cmd := exec.Command("node", append([]string{cjs}, args...)...)
				cmd.Dir = root
				var stdout, stderr bytes.Buffer
				cmd.Stdout, cmd.Stderr = &stdout, &stderr
				code := 0
				if err := cmd.Run(); err != nil {
					exit, ok := err.(*exec.ExitError)
					if !ok {
						t.Fatalf("node %v: %v", args, err)
					}
					code = exit.ExitCode()
				}
				return cmdResult{code, stdout.String(), stderr.String(), snapshot(t, root)}
			}
			runGo := func(args ...string) cmdResult {
				t.Chdir(root)
				var stdout, stderr bytes.Buffer
				code := Main(args, &stdout, &stderr)
				return cmdResult{code, stdout.String(), stderr.String(), snapshot(t, root)}
			}
			reset := func() {
				if err := os.RemoveAll(filepath.Join(root, ".planning")); err != nil {
					t.Fatal(err)
				}
			}

			js := runJS("build")
			reset()
			goRes := runGo("build")
			compare(t, []string{"build"}, js, goRes)
			if t.Failed() {
				return
			}

			var graph struct {
				Nodes []struct {
					ID         string `json:"id"`
					Label      string `json:"label"`
					SourceFile string `json:"source_file"`
				} `json:"nodes"`
			}
			if err := json.Unmarshal([]byte(goRes.files[".planning/codebase/graph.json"]), &graph); err != nil {
				t.Fatalf("graph.json: %v", err)
			}
			commands := [][]string{
				{"stats"}, {"report"}, {"export", "tree"}, {"export", "wiki"}, {"export", "graphml"}, {"export"},
				{"export", "nope"}, {"help"}, {}, {"nope"}, {"explain"}, {"path", "x"}, {"affected"}, {"query"},
				{"explain", "zzz_no_such_node"}, {"path", "zzz_a", "zzz_b"}, {"build", "--quiet"},
				{"query", "how does it load and save the session store"}, {"query", "render"}, {"query", "the and for"},
				{"query", "parse", "--dfs"}, {"query", "parse", "--depth", "1"}, {"query", "main", "--budget", "200"},
				{"query", "store", "--context", "call"},
			}
			step := len(graph.Nodes)/6 + 1
			var labels []string
			for i := 0; i < len(graph.Nodes); i += step {
				n := graph.Nodes[i]
				label := strings.TrimSuffix(n.Label, "()")
				labels = append(labels, label)
				commands = append(commands,
					[]string{"explain", label}, []string{"explain", n.ID}, []string{"affected", label},
					[]string{"affected", label, "--depth", "3"}, []string{"affected", label, "--relation", "calls"},
					[]string{"query", label},
				)
			}
			for i := 0; i+1 < len(labels); i++ {
				commands = append(commands, []string{"path", labels[i], labels[i+1]})
			}
			for _, args := range commands {
				a := runJS(args...)
				b := runGo(args...)
				compare(t, args, a, b)
			}
		})
	}
}

type cmdResult struct {
	code   int
	stdout string
	stderr string
	files  map[string]string // everything under .planning, by "/" path
}

var parityDuration = regexp.MustCompile(`· \d+ms`)

func compare(t *testing.T, args []string, js, goRes cmdResult) {
	t.Helper()
	norm := func(s string) string { return parityDuration.ReplaceAllString(s, "· Nms") }
	if js.code != goRes.code {
		t.Errorf("kg %v: exit code js=%d go=%d", args, js.code, goRes.code)
	}
	if a, b := norm(js.stdout), norm(goRes.stdout); a != b {
		t.Errorf("kg %v: stdout differs\n%s", args, firstDiff(a, b))
	}
	if a, b := norm(js.stderr), norm(goRes.stderr); a != b {
		t.Errorf("kg %v: stderr differs\n%s", args, firstDiff(a, b))
	}
	names := map[string]bool{}
	for k := range js.files {
		names[k] = true
	}
	for k := range goRes.files {
		names[k] = true
	}
	sorted := make([]string, 0, len(names))
	for k := range names {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		a, inJS := js.files[k]
		b, inGo := goRes.files[k]
		switch {
		case !inJS:
			t.Errorf("kg %v: %s written by go only", args, k)
		case !inGo:
			t.Errorf("kg %v: %s written by js only", args, k)
		case a != b:
			t.Errorf("kg %v: %s differs\n%s", args, k, firstDiff(a, b))
		}
	}
}

// firstDiff shows the first line where two texts part.
func firstDiff(a, b string) string {
	x, y := strings.Split(a, "\n"), strings.Split(b, "\n")
	for i := 0; i < len(x) || i < len(y); i++ {
		var l, r string
		if i < len(x) {
			l = x[i]
		}
		if i < len(y) {
			r = y[i]
		}
		if l != r {
			clip := func(s string) string {
				if len(s) > 300 {
					return s[:300] + "…"
				}
				return s
			}
			return "  line " + itoa(i+1) + " (js " + itoa(len(x)) + " lines, go " + itoa(len(y)) + ")\n   js: " + clip(l) + "\n   go: " + clip(r)
		}
	}
	return "  (no line differs)"
}

func itoa(n int) string { return strconv.Itoa(n) }

func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	base := filepath.Join(root, ".planning")
	_ = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(root, p)
		out[filepath.ToSlash(rel)] = string(raw)
		return nil
	})
	return out
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			if d.Name() == ".planning" || d.Name() == "node_modules" || (d.Name() == "testdata" && rel != ".") {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), raw, 0o644)
	})
	if err != nil {
		t.Fatalf("copy %s: %v", src, err)
	}
}
