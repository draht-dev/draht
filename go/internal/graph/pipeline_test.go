package graph

import (
	"bytes"
	"context"
	"flag"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// updateGolden lets a human regenerate testdata/fixture-repo.MAP.json after
// an intentional pipeline change: `go test ./internal/graph -run
// FixtureRepoGolden -update`.
var updateGolden = flag.Bool("update", false, "update golden files (testdata/fixture-repo.MAP.json)")

// fixtureRepoLangs mirrors buildParser's treesitter branch in
// cmd/draht-tools/mapgraph.go (design D2): the 6-grammar Phase-1 subset.
// Kept as its own slice (rather than importing cmd/draht-tools, which would
// be a layering violation — graph must not depend on cmd) so this test
// exercises the SAME parser configuration the shipped CLI uses by default.
var fixtureRepoLangs = []parse.Lang{"typescript", "javascript", "python", "go", "rust"}

// copyDir recursively copies src into dst (both directories), preserving
// regular file bytes and permissions closely enough for the pipeline's
// purposes. Used so each test run gets its own throwaway copy of
// testdata/fixture-repo — the pipeline reads scan.FindRepoRoot-independent
// content from opts.Root directly, but scan.Discover also shells out to
// `git ls-files`, and a copy living outside any git working tree makes that
// call deterministically fail (ok=false), forcing the Walk fallback — the
// test must not depend on this repo's own git state or on git being
// installed at all.
func copyDir(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copyDir(%s, %s): %v", src, dst, err)
	}
}

// hugeFixtureLine is one line of the synthesized over-1MiB fixture file. Its
// length (73 bytes) times hugeFixtureLines is exactly hugeFixtureSize.
const hugeFixtureLine = "// filler filler filler filler filler filler filler filler filler filler\n"

// hugeFixtureLines / hugeFixtureSize describe packages/app/src/huge.ts, the
// fixture that exercises scan's >1MiB "stat it, list it, never read it" gate.
// 14366 * 73 == 1048718 bytes, which is what testdata/fixture-repo.MAP.json
// records for that module's size — keep all three in lockstep.
const (
	hugeFixtureLines = 14366
	hugeFixtureSize  = hugeFixtureLines * len(hugeFixtureLine)
)

// writeHugeFixture synthesizes packages/app/src/huge.ts inside a fixture copy.
// It is generated rather than committed because the file is 1.1 MiB of a single
// repeated line: checking that into git costs every clone of this monorepo
// permanently, to encode one integer's worth of information (its size).
func writeHugeFixture(t *testing.T, root string) {
	t.Helper()
	path := filepath.Join(root, "packages", "app", "src", "huge.ts")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("writeHugeFixture mkdir: %v", err)
	}
	var buf bytes.Buffer
	buf.Grow(hugeFixtureSize)
	for i := 0; i < hugeFixtureLines; i++ {
		buf.WriteString(hugeFixtureLine)
	}
	if buf.Len() != hugeFixtureSize {
		t.Fatalf("huge fixture size drift: built %d bytes, want %d", buf.Len(), hugeFixtureSize)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("writeHugeFixture: %v", err)
	}
}

// newFixtureRepo copies testdata/fixture-repo into a fresh temp directory,
// synthesizes the generated over-1MiB file, and returns its path.
func newFixtureRepo(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	copyDir(t, filepath.Join("testdata", "fixture-repo"), dst)
	writeHugeFixture(t, dst)
	return dst
}

// buildFixture runs the full pipeline over a fresh copy of testdata/fixture-repo
// with a fresh cache dir, using the same tree-sitter parser configuration the
// CLI ships by default (design D2's 6-grammar subset).
func buildFixture(t *testing.T, jobs int) (*model.Map, Report) {
	t.Helper()
	root := newFixtureRepo(t)

	p, err := parse.NewTreeSitter(fixtureRepoLangs)
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })

	m, report, err := Build(context.Background(), Options{
		Root:     root,
		OutDir:   t.TempDir(),
		CacheDir: t.TempDir(),
		Jobs:     jobs,
		Parser:   p,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return m, report
}

// normalize strips the two volatile fields (GeneratedAt/BuildMs — see
// model.WriteIfChanged's own normalizedJSON, which does the same thing for
// the same reason) and re-serializes m so byte-for-byte comparisons across
// runs/golden files are meaningful.
func normalize(t *testing.T, m *model.Map) []byte {
	t.Helper()
	clone := *m
	clone.GeneratedAt = ""
	clone.BuildMs = 0
	var buf bytes.Buffer
	if err := model.WriteMapJSON(&buf, &clone); err != nil {
		t.Fatalf("WriteMapJSON: %v", err)
	}
	return buf.Bytes()
}

// TestBuild_FixtureRepoGolden is the pipeline_test.go end-to-end gate the
// review flagged as missing (G-series pipeline test): a full Build run over
// a committed multi-language fixture repo (nested workspace package, barrel
// re-export, dynamic import, require, an unresolvable relative import, a
// node: import, a >1MiB unreadable file, a .test.ts file), asserted against
// a committed golden (testdata/fixture-repo.MAP.json, deliberately a
// SIBLING of testdata/fixture-repo/ rather than nested inside it — nesting
// it would make the golden describe a repo that includes itself).
//
// To regenerate the golden after an intentional pipeline change: run this
// test with -update (see the flag below), inspect the diff, and commit it.
func TestBuild_FixtureRepoGolden(t *testing.T) {
	m, report := buildFixture(t, 4)
	got := normalize(t, m)

	goldenPath := filepath.Join("testdata", "fixture-repo.MAP.json")
	if *updateGolden {
		if err := os.WriteFile(goldenPath, got, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("updated golden %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden %s: %v (run `go test ./internal/graph -run FixtureRepoGolden -update` to create it)", goldenPath, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("Build output does not match %s.\nRe-run with -update if this is an intentional change.\n--- got ---\n%s", goldenPath, got)
	}

	if report.Modules == 0 {
		t.Fatal("expected at least one module")
	}
}

// TestBuild_FixtureRepoStructuralExpectations asserts the specific
// behaviours the fixture was built to exercise, independent of the golden
// byte-comparison (so a future intentional golden update can't silently
// drop coverage of one of these categories without a human noticing a
// still-failing assertion here).
func TestBuild_FixtureRepoStructuralExpectations(t *testing.T) {
	m, report := buildFixture(t, 4)

	byPath := map[string]model.Module{}
	for _, mod := range m.Modules {
		byPath[mod.Path] = mod
	}

	// Every language file became a module.
	for _, want := range []string{
		"packages/core/src/index.ts",
		"packages/core/src/utils.ts",
		"packages/app/src/main.ts",
		"packages/app/src/lazy.ts",
		"packages/app/src/legacy.js",
		"packages/app/src/main.test.ts",
		"packages/app/src/Widget.tsx",
		"packages/app/src/huge.ts",
		"scripts/build.py",
		"cmd/tool/main.go",
		"src/lib.rs",
	} {
		if _, ok := byPath[want]; !ok {
			t.Errorf("expected a module for %s, not found (modules: %d)", want, len(m.Modules))
		}
	}

	// README.md is a non-code asset: never a module.
	if _, ok := byPath["README.md"]; ok {
		t.Error("README.md must not become a module")
	}
	if m.Assets.Total == 0 {
		t.Error("expected at least one non-code asset (README.md) counted in assets.total")
	}

	// The >1MiB file is unreadable: it's still a module, but with zeroed
	// facts (no exports/symbols/sinks/routes were ever read from it).
	huge, ok := byPath["packages/app/src/huge.ts"]
	if !ok {
		t.Fatal("expected packages/app/src/huge.ts as a module")
	}
	if huge.Size < 1<<20 {
		t.Errorf("expected huge.ts Size >= 1MiB, got %d", huge.Size)
	}
	if len(huge.Exports) != 0 || len(huge.Symbols) != 0 {
		t.Errorf("expected huge.ts to have zero exports/symbols (unread, over the size gate), got exports=%d symbols=%d", len(huge.Exports), len(huge.Symbols))
	}

	// The .test.ts file is flagged IsTest.
	testMod, ok := byPath["packages/app/src/main.test.ts"]
	if !ok || !testMod.IsTest {
		t.Errorf("expected packages/app/src/main.test.ts to be IsTest=true, got %+v", testMod)
	}

	// Edge kind/target coverage: workspace-resolved import, barrel
	// re-export, dynamic import, require, unresolvable relative import
	// (external), and a node: import (external).
	var (
		sawWorkspaceImport   bool
		sawReExport          bool
		sawDynamicTarget     bool
		sawRequireTarget     bool
		sawUnresolvedMissing bool
		sawNodeExternal      bool
	)
	for _, e := range m.Edges {
		switch {
		case e.From == "packages/app/src/main.ts" && e.To == "packages/core/src/index.ts" && e.Kind == model.EdgeKindImport:
			sawWorkspaceImport = true
		case e.From == "packages/core/src/index.ts" && e.To == "packages/core/src/utils.ts" && e.Kind == model.EdgeKindReExport:
			sawReExport = true
		case e.From == "packages/app/src/main.ts" && e.To == "packages/app/src/lazy.ts" && e.Kind == model.EdgeKindImport:
			sawDynamicTarget = true
		case e.From == "packages/app/src/main.ts" && e.To == "packages/app/src/legacy.js" && e.Kind == model.EdgeKindImport:
			sawRequireTarget = true
		case e.From == "packages/app/src/main.ts" && e.To == "./missing" && e.Kind == model.EdgeKindExternal:
			sawUnresolvedMissing = true
		case e.From == "packages/app/src/main.ts" && e.To == "node:fs" && e.Kind == model.EdgeKindExternal:
			sawNodeExternal = true
		}
	}
	if !sawWorkspaceImport {
		t.Error("expected a resolved workspace import edge main.ts -> packages/core/src/index.ts")
	}
	if !sawReExport {
		t.Error("expected a re-export edge index.ts -> utils.ts")
	}
	if !sawDynamicTarget {
		t.Error("expected a resolved dynamic-import edge main.ts -> lazy.ts")
	}
	if !sawRequireTarget {
		t.Error("expected a resolved require edge main.ts -> legacy.js")
	}
	if !sawUnresolvedMissing {
		t.Error("expected an unresolved external edge main.ts -> ./missing")
	}
	if !sawNodeExternal {
		t.Error("expected an external edge main.ts -> node:fs")
	}

	if report.Modules != len(m.Modules) {
		t.Errorf("report.Modules = %d, want %d", report.Modules, len(m.Modules))
	}
}

// TestBuild_ColdRunsAreDeterministic runs the full pipeline twice against
// the SAME fixture copy (so m.Root — which is filepath.Base(opts.Root) —
// stays constant; two different t.TempDir() fixture copies would legitimately
// produce two different Root values, which is not the nondeterminism this
// test is guarding against), each time with a FRESH cache dir (so both runs
// are genuinely cold), and asserts the normalized output is byte-identical —
// the pipeline_test.go-level counterpart to determinism_test.go's
// Assemble-only coverage.
func TestBuild_ColdRunsAreDeterministic(t *testing.T) {
	root := newFixtureRepo(t)

	build := func() *model.Map {
		p, err := parse.NewTreeSitter(fixtureRepoLangs)
		if err != nil {
			t.Fatalf("NewTreeSitter: %v", err)
		}
		defer p.Close()
		m, _, err := Build(context.Background(), Options{
			Root:     root,
			OutDir:   t.TempDir(),
			CacheDir: t.TempDir(),
			Jobs:     4,
			Parser:   p,
		})
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		return m
	}

	got1 := normalize(t, build())
	got2 := normalize(t, build())
	if !bytes.Equal(got1, got2) {
		t.Fatalf("two independent cold Build runs over the same fixture diverged")
	}
}

// TestBuild_CancelledContextReturnsErrorAndDoesNotWrite guards the fix for
// the review finding that Build never re-checked ctx.Err() after the
// concurrent extract stage: a cancelled context must produce a non-nil
// error and must NOT overwrite a pre-existing MAP.json with truncated
// content.
func TestBuild_CancelledContextReturnsErrorAndDoesNotWrite(t *testing.T) {
	root := newFixtureRepo(t)
	outDir := t.TempDir()
	outPath := filepath.Join(outDir, "MAP.json")

	// Seed a "good" prior MAP.json so we can assert it survives untouched.
	sentinel := []byte(`{"schemaVersion":5,"sentinel":true}`)
	if err := os.WriteFile(outPath, sentinel, 0o644); err != nil {
		t.Fatalf("seed sentinel MAP.json: %v", err)
	}

	p, err := parse.NewTreeSitter(fixtureRepoLangs)
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer p.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before Build even starts its extract stage

	_, _, err = Build(ctx, Options{
		Root:     root,
		OutDir:   outDir,
		CacheDir: t.TempDir(),
		Jobs:     4,
		Parser:   p,
	})
	if err == nil {
		t.Fatal("expected Build to return an error for an already-cancelled context")
	}

	after, readErr := os.ReadFile(outPath)
	if readErr != nil {
		t.Fatalf("read MAP.json after cancelled Build: %v", readErr)
	}
	if !bytes.Equal(after, sentinel) {
		t.Fatalf("cancelled Build must not modify an existing MAP.json; got %s", after)
	}
}
