package graph

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// fixtureAssembleInput builds a non-trivial, multi-package fixture that
// exercises the resolver (relative + workspace + external + unresolvable
// specifiers), edge kinds (import/re-export/external), and the stats/assets
// rollup all at once.
func fixtureAssembleInput(t *testing.T) AssembleInput {
	t.Helper()

	pkgs := []scan.Package{
		{Name: "draht-monorepo", Path: ".", Main: "index.ts"},
		{Name: "@draht/ai", Path: "packages/ai", Main: "dist/index.js"},
		{Name: "@draht/coding-agent", Path: "packages/coding-agent", Main: "dist/index.js"},
	}
	modulePaths := []string{
		"index.ts",
		"packages/ai/src/index.ts",
		"packages/ai/src/models.ts",
		"packages/coding-agent/src/index.ts",
		"packages/coding-agent/src/main.ts",
	}
	workspaceEntry := BuildWorkspaceEntries(pkgs, toSet(modulePaths))
	resolver := NewResolver(NewResolverIndex(modulePaths, workspaceEntry))

	mi := []ModuleImports{
		{
			Path: "packages/ai/src/index.ts",
			Imports: []parse.Import{
				{Kind: parse.KindReExport, Specifier: "./models"},
			},
		},
		{
			Path: "packages/coding-agent/src/main.ts",
			Imports: []parse.Import{
				{Kind: parse.KindImport, Specifier: "@draht/ai/models", Default: "ai"},
				{Kind: parse.KindImport, Specifier: "node:fs", Namespace: "fs"},
				{Kind: parse.KindImport, Specifier: "./nonexistent"},
			},
		},
	}
	edges := BuildEdges(mi, resolver)

	modules := []model.Module{
		{ID: "index.ts", Path: "index.ts", Language: "typescript", Loc: 10, Layer: model.LayerSupport,
			Exports: []model.Export{}, Symbols: []model.Symbol{}, Sinks: []string{}, SinkSites: []model.SinkSite{}, Routes: []model.Route{}},
		{ID: "packages/ai/src/index.ts", Path: "packages/ai/src/index.ts", Language: "typescript", Loc: 5, Layer: model.LayerSupport,
			Exports: []model.Export{}, Symbols: []model.Symbol{}, Sinks: []string{}, SinkSites: []model.SinkSite{}, Routes: []model.Route{}},
		{ID: "packages/ai/src/models.ts", Path: "packages/ai/src/models.ts", Language: "typescript", Loc: 40, Layer: model.LayerDomain,
			Exports: []model.Export{}, Symbols: []model.Symbol{}, Sinks: []string{}, SinkSites: []model.SinkSite{}, Routes: []model.Route{}},
		{ID: "packages/coding-agent/src/index.ts", Path: "packages/coding-agent/src/index.ts", Language: "typescript", Loc: 8, Layer: model.LayerSupport,
			Exports: []model.Export{}, Symbols: []model.Symbol{}, Sinks: []string{}, SinkSites: []model.SinkSite{}, Routes: []model.Route{}},
		{ID: "packages/coding-agent/src/main.ts", Path: "packages/coding-agent/src/main.ts", Language: "typescript", Loc: 60, Layer: model.LayerPresentation, IsTest: false,
			Exports: []model.Export{}, Symbols: []model.Symbol{}, Sinks: []string{}, SinkSites: []model.SinkSite{}, Routes: []model.Route{},
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "draht-agent"}},
	}

	modelPkgs := make([]model.Package, len(pkgs))
	for i, p := range pkgs {
		modelPkgs[i] = model.Package{Name: p.Name, Path: p.Path, Dependencies: []string{}, DevDependencies: []string{}, PeerDependencies: []string{}, WorkspaceDeps: []string{}}
	}

	langCounts := []scan.LangCount{
		{Lang: scan.LangTypeScript, Count: 5},
		{Lang: scan.Lang("markdown"), Count: 3},
		{Lang: scan.LangOther, Count: 1},
	}

	fixedNow := func() time.Time {
		return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	}

	return AssembleInput{
		Root:       "draht-graph-go",
		Modules:    modules,
		Edges:      edges,
		Packages:   modelPkgs,
		LangCounts: langCounts,
		Truncated:  false,
		Now:        fixedNow,
	}
}

func toSet(paths []string) map[string]struct{} {
	out := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		out[p] = struct{}{}
	}
	return out
}

// TestAssembleDeterminism assembles the SAME fixture input twice and
// asserts the serialized MAP.json output is byte-identical, covering the
// full assemble path: resolver -> edges -> stats/assets -> model.Map ->
// model.WriteMapJSON. This is the "assembles the same input twice" gate
// required of the graph package.
func TestAssembleDeterminism(t *testing.T) {
	in1 := fixtureAssembleInput(t)
	in2 := fixtureAssembleInput(t) // independently constructed, same values

	m1 := Assemble(in1)
	m2 := Assemble(in2)

	var buf1, buf2 bytes.Buffer
	if err := model.WriteMapJSON(&buf1, m1); err != nil {
		t.Fatalf("WriteMapJSON(m1): %v", err)
	}
	if err := model.WriteMapJSON(&buf2, m2); err != nil {
		t.Fatalf("WriteMapJSON(m2): %v", err)
	}

	if buf1.Len() == 0 {
		t.Fatal("expected non-empty output")
	}
	if !bytes.Equal(buf1.Bytes(), buf2.Bytes()) {
		t.Fatalf("Assemble output is not deterministic:\nrun1:\n%s\nrun2:\n%s", buf1.String(), buf2.String())
	}
}

// TestAssembleDeterminismManyRuns repeats the same assembly 10 times and
// asserts all outputs match the first, catching any latent nondeterminism
// (e.g. an accidental map-iteration dependency) that a single repeat might
// miss.
func TestAssembleDeterminismManyRuns(t *testing.T) {
	const runs = 10
	var first []byte
	for i := 0; i < runs; i++ {
		in := fixtureAssembleInput(t)
		m := Assemble(in)
		var buf bytes.Buffer
		if err := model.WriteMapJSON(&buf, m); err != nil {
			t.Fatalf("run %d: WriteMapJSON: %v", i, err)
		}
		if i == 0 {
			first = buf.Bytes()
			continue
		}
		if !bytes.Equal(first, buf.Bytes()) {
			t.Fatalf("run %d diverged from run 0", i)
		}
	}
}

// TestAssembleFixtureContent sanity-checks the fixture actually exercises
// what it claims to: a real import edge, a re-export edge, and an external
// edge for BOTH an unresolvable relative specifier and a genuinely bare
// external specifier — so TestAssembleDeterminism is not vacuously true
// over an empty edge set.
func TestAssembleFixtureContent(t *testing.T) {
	in := fixtureAssembleInput(t)
	m := Assemble(in)

	var kinds = map[string]int{}
	for _, e := range m.Edges {
		kinds[e.Kind]++
	}
	if kinds[model.EdgeKindImport] == 0 {
		t.Error("expected at least one import edge in the fixture")
	}
	if kinds[model.EdgeKindReExport] == 0 {
		t.Error("expected at least one re-export edge in the fixture")
	}
	if kinds[model.EdgeKindExternal] < 2 {
		t.Errorf("expected at least 2 external edges (node:fs + unresolvable relative), got %d", kinds[model.EdgeKindExternal])
	}
	if m.Stats.Files != 5 {
		t.Errorf("Stats.Files = %d, want 5", m.Stats.Files)
	}
	if m.GeneratedAt != "2026-01-01T00:00:00.000Z" {
		t.Errorf("GeneratedAt = %q, want the fixed Now value", m.GeneratedAt)
	}
}

// TestBuild_JobsCountDoesNotAffectOutput is this package's substitute for
// `go test -race`, which cannot run on this machine (no C compiler:
// CGO_ENABLED=1 is required for -race, and cc/gcc/clang are all absent —
// see go/README.md). extractAll's bounded worker pool (graph/pipeline.go)
// is the pipeline's ONLY concurrent stage; this test runs the full Build
// pipeline over the fixture repo 5 times at jobs=1 and 5 times at jobs=8
// (matching the spec's designated determinism gate: "5 runs x {jobs=1,
// jobs=8} => 10 byte-identical outputs") and asserts every one of the 10
// normalized outputs is byte-identical to the first. This does not detect a
// benign/harmless data race the way -race's instrumentation would, but it
// does catch any ordering-dependent observable nondeterminism (a map
// iterated without sorting, a result written to the wrong slot, a
// channel-order dependency) — which is the class of bug most likely to
// actually corrupt MAP.json output.
func TestBuild_JobsCountDoesNotAffectOutput(t *testing.T) {
	root := newFixtureRepo(t)

	build := func(jobs int) []byte {
		t.Helper()
		p, err := parse.NewTreeSitter(fixtureRepoLangs)
		if err != nil {
			t.Fatalf("NewTreeSitter: %v", err)
		}
		defer p.Close()
		m, _, err := Build(context.Background(), Options{
			Root:     root,
			OutDir:   t.TempDir(),
			CacheDir: t.TempDir(), // fresh cache every run: exercise the concurrent extract path, not a warm no-op
			Jobs:     jobs,
			Parser:   p,
		})
		if err != nil {
			t.Fatalf("Build(jobs=%d): %v", jobs, err)
		}
		return normalize(t, m)
	}

	var first []byte
	const runsPerJobCount = 5
	for _, jobs := range []int{1, 8} {
		for i := 0; i < runsPerJobCount; i++ {
			got := build(jobs)
			if first == nil {
				first = got
				continue
			}
			if !bytes.Equal(first, got) {
				t.Fatalf("jobs=%d run %d diverged from the first run's output", jobs, i)
			}
		}
	}
}
