package graph

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// parityMapFlag lets a caller supply an already-generated CJS reference
// MAP.json (`make parity PARITY_MAP=/path/to/MAP.json`), matching the
// Makefile's documented `parity` target. When unset (the common case, and
// what `make parity` now does by default), the test generates its own
// reference by shelling out to the real CJS engine
// (packages/draht-tools/bin/draht-tools.cjs) against this repo, so the gate
// is fully self-contained and never goes stale relative to a manually
// captured snapshot.
var parityMapFlag = flag.String("parity-map", "", "path to a pre-generated CJS MAP.json to compare against (optional; the test generates its own via `node .../draht-tools.cjs map-graph` when unset)")

// TestParity_RegexParserMatchesCJSEngine is the G5 acceptance gate: Go
// (--parser=regex) vs the CJS engine's MAP.json. It uses the regex parser
// (not the default tree-sitter one) because parse.NewRegex is documented as
// "the byte-parity oracle for --parser=regex" — a verbatim port of the CJS
// engine's own import-regex logic — so this test's whole point is comparing
// that port against its original, not comparing tree-sitter's (deliberately
// richer, D2-scoped) AST-based extraction against a regex-era baseline (see
// testdata/ts-vs-regex-edges.md for that separate, expected delta, which
// only applies to the default --parser=treesitter build).
//
// This gate covers every field Phase 2 added — groups, containers,
// boundedContexts, callEdges, containerEdges, entryPoints, sinks, flows,
// lanes, boxes, symbolIndex, clusters, surprisingConnections,
// rationaleIndex, hotspots — plus modules[*].depth/cluster, in addition to
// the original Phase 1 root/packages/modules/edges/stats-subset coverage.
// Nothing here is normalized away or excluded: every one of these fields is
// real in both engines' output for this repo, and this test asserts they
// match.
func TestParity_RegexParserMatchesCJSEngine(t *testing.T) {
	if os.Getenv("PARITY_SKIP") != "" {
		t.Skip("PARITY_SKIP set")
	}

	monorepoRoot := resolveMonorepoRoot(t)
	cjsMap := loadCJSReferenceMap(t, monorepoRoot)
	goMap := buildGoRegexMap(t, monorepoRoot)

	if cjsMap.Root != goMap.Root {
		t.Errorf("root: cjs=%q go=%q", cjsMap.Root, goMap.Root)
	}

	comparePackages(t, cjsMap.Packages, goMap.Packages)
	compareModules(t, cjsMap.Modules, goMap.Modules)
	compareEdges(t, cjsMap.Edges, goMap.Edges)

	compareOrdered(t, "callEdges", cjsMap.CallEdges, goMap.CallEdges)
	compareOrdered(t, "containerEdges", cjsMap.ContainerEdges, goMap.ContainerEdges)
	compareOrdered(t, "containers", cjsMap.Containers, goMap.Containers)
	compareOrdered(t, "boundedContexts", cjsMap.BoundedContexts, goMap.BoundedContexts)
	compareOrdered(t, "entryPoints", cjsMap.EntryPoints, goMap.EntryPoints)
	compareOrdered(t, "sinks", cjsMap.Sinks, goMap.Sinks)
	compareOrdered(t, "lanes", cjsMap.Lanes, goMap.Lanes)
	compareOrdered(t, "symbolIndex", cjsMap.SymbolIndex, goMap.SymbolIndex)
	compareOrdered(t, "clusters", cjsMap.Clusters, goMap.Clusters)
	compareOrdered(t, "surprisingConnections", cjsMap.SurprisingConnections, goMap.SurprisingConnections)
	compareOrdered(t, "rationaleIndex", cjsMap.RationaleIndex, goMap.RationaleIndex)
	compareOrdered(t, "hotspots.godNodes", cjsMap.Hotspots.GodNodes, goMap.Hotspots.GodNodes)
	compareOrdered(t, "hotspots.mostDependedOn", cjsMap.Hotspots.MostDependedOn, goMap.Hotspots.MostDependedOn)
	compareOrdered(t, "hotspots.orchestrators", cjsMap.Hotspots.Orchestrators, goMap.Hotspots.Orchestrators)
	compareOrdered(t, "hotspots.largest", cjsMap.Hotspots.Largest, goMap.Hotspots.Largest)
	if cjsMap.SymbolIndexTruncated != goMap.SymbolIndexTruncated {
		t.Errorf("symbolIndexTruncated: cjs=%v go=%v", cjsMap.SymbolIndexTruncated, goMap.SymbolIndexTruncated)
	}

	compareRawJSON(t, "groups", cjsMap.Groups, goMap.Groups)
	compareRawJSON(t, "flows", cjsMap.Flows, goMap.Flows)
	compareRawJSON(t, "boxes", cjsMap.Boxes, goMap.Boxes)

	// Stats SUBSET only (not the full Stats struct): Files/TotalLoc/Edges/
	// Packages are the fields directly derived from the module/edge/package
	// comparisons above and are the ones the finding's own manual
	// reproduction checked. Languages/Layers ordering is covered by other,
	// more targeted tests (stats_test.go) and is not this gate's concern.
	if cjsMap.Stats.Files != goMap.Stats.Files {
		t.Errorf("stats.files: cjs=%d go=%d", cjsMap.Stats.Files, goMap.Stats.Files)
	}
	if cjsMap.Stats.TotalLoc != goMap.Stats.TotalLoc {
		t.Errorf("stats.totalLoc: cjs=%d go=%d", cjsMap.Stats.TotalLoc, goMap.Stats.TotalLoc)
	}
	if cjsMap.Stats.Edges != goMap.Stats.Edges {
		t.Errorf("stats.edges: cjs=%d go=%d", cjsMap.Stats.Edges, goMap.Stats.Edges)
	}
	if cjsMap.Stats.Packages != goMap.Stats.Packages {
		t.Errorf("stats.packages: cjs=%d go=%d", cjsMap.Stats.Packages, goMap.Stats.Packages)
	}
	if cjsMap.Assets.Total != goMap.Assets.Total {
		t.Errorf("assets.total: cjs=%d go=%d", cjsMap.Assets.Total, goMap.Assets.Total)
	}
}

// compareOrdered positionally compares two already-final-ordered slices of
// any comparable-by-DeepEqual element type (CallEdge, ContainerEdge,
// Container, EntryPointRef, SinkModule, Lane, SymbolIndexEntry, Cluster,
// SurprisingConnection, RationaleEntry, GodNode, ...). Every one of these
// fields' order is a documented, deterministic property of the pipeline
// (see each field's producing package's doc comments), so index-position
// comparison — not by-id matching — is the correct, and stricter, check:
// it also catches an ordering regression a by-id map comparison would miss.
func compareOrdered[T any](t *testing.T, name string, cjs, gp []T) {
	t.Helper()
	if len(cjs) != len(gp) {
		t.Errorf("%s: cjs has %d, go has %d", name, len(cjs), len(gp))
	}
	n := len(cjs)
	if len(gp) < n {
		n = len(gp)
	}
	mismatches := 0
	for i := 0; i < n; i++ {
		if !reflect.DeepEqual(cjs[i], gp[i]) {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("%s[%d] differs:\n  cjs: %+v\n  go:  %+v", name, i, cjs[i], gp[i])
			}
		}
	}
	if mismatches > 5 {
		t.Errorf("%s: %d total mismatches in the first %d (showing first 5)", name, mismatches, n)
	}
}

// compareRawJSON positionally compares two slices of pre-marshaled JSON
// objects (groups/flows/boxes — see model.Map's doc comments on why these
// three fields stay []json.RawMessage rather than typed structs: they must
// round-trip GROUPS.json/FLOWS.json curation's schema-unknown user keys).
// Each element is compacted (json.Compact strips only insignificant
// whitespace — it never reorders object keys) before a string comparison,
// so this remains sensitive to key-order and value differences (including
// the HTML-escaping defect this gate is partly here to catch) while staying
// insensitive to the two engines' incidental pretty-printing differences.
func compareRawJSON(t *testing.T, name string, cjs, gp []json.RawMessage) {
	t.Helper()
	if len(cjs) != len(gp) {
		t.Errorf("%s: cjs has %d, go has %d", name, len(cjs), len(gp))
	}
	n := len(cjs)
	if len(gp) < n {
		n = len(gp)
	}
	mismatches := 0
	for i := 0; i < n; i++ {
		cjsC, gpC := compactJSON(t, cjs[i]), compactJSON(t, gp[i])
		if cjsC != gpC {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("%s[%d] differs:\n  cjs: %s\n  go:  %s", name, i, cjsC, gpC)
			}
		}
	}
	if mismatches > 5 {
		t.Errorf("%s: %d total mismatches in the first %d (showing first 5)", name, mismatches, n)
	}
}

func compactJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatalf("json.Compact: %v\nraw: %s", err, raw)
	}
	return buf.String()
}

// resolveMonorepoRoot finds the real draht-mono worktree root (the parent
// of go/), the same way scan.FindRepoRoot does for the real CLI: walk up
// from cwd looking for ".git". go/internal/graph is nested three levels
// under it, but we do not hardcode that depth — FindRepoRoot's walk is the
// single source of truth for "what is the repo root" everywhere else in
// this codebase, so this test uses it too rather than a parallel
// filepath.Join("..","..","..") that could silently drift if this test file
// ever moves.
func resolveMonorepoRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	root, err := scan.FindRepoRoot(cwd)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	return root
}

// loadCJSReferenceMap returns the CJS engine's MAP.json for monorepoRoot,
// either from -parity-map (if set) or by running the real engine now.
func loadCJSReferenceMap(t *testing.T, monorepoRoot string) *model.Map {
	t.Helper()
	if *parityMapFlag != "" {
		return loadMapFile(t, *parityMapFlag)
	}

	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available on PATH; pass -parity-map=<path> to a pre-generated CJS MAP.json instead")
	}
	cjsScript := filepath.Join(monorepoRoot, "packages", "draht-tools", "bin", "draht-tools.cjs")
	if _, err := os.Stat(cjsScript); err != nil {
		t.Skipf("CJS engine not found at %s: %v", cjsScript, err)
	}

	cmd := exec.CommandContext(context.Background(), "node", cjsScript, "map-graph", "--quiet")
	cmd.Dir = monorepoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node %s map-graph --quiet: %v\n%s", cjsScript, err, out)
	}
	t.Logf("cjs reference: %s", out)

	// .planning/codebase/MAP.json is gitignored (verified: `git check-ignore
	// -v .planning/codebase/MAP.json` matches .gitignore:52) — writing it
	// here never dirties git status.
	return loadMapFile(t, filepath.Join(monorepoRoot, ".planning", "codebase", "MAP.json"))
}

func loadMapFile(t *testing.T, path string) *model.Map {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var m model.Map
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	return &m
}

// buildGoRegexMap runs the Go pipeline over monorepoRoot with the regex
// parser (the byte-parity oracle — see parse.NewRegex's doc comment) into
// throwaway output/cache dirs, so this test never touches the real
// .planning/codebase/MAP.json the CJS run above just wrote.
func buildGoRegexMap(t *testing.T, monorepoRoot string) *model.Map {
	t.Helper()
	p := parse.NewRegex()
	defer p.Close()

	m, _, err := Build(context.Background(), Options{
		Root:     monorepoRoot,
		OutDir:   t.TempDir(),
		CacheDir: t.TempDir(),
		Parser:   p,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return m
}

func comparePackages(t *testing.T, cjs, gp []model.Package) {
	t.Helper()
	if len(cjs) != len(gp) {
		t.Errorf("packages: cjs has %d, go has %d", len(cjs), len(gp))
	}
	byName := func(pkgs []model.Package) map[string]model.Package {
		out := make(map[string]model.Package, len(pkgs))
		for _, p := range pkgs {
			out[p.Name] = p
		}
		return out
	}
	cjsByName, goByName := byName(cjs), byName(gp)
	mismatches := 0
	for name, cp := range cjsByName {
		gpk, ok := goByName[name]
		if !ok {
			t.Errorf("packages: %q present in cjs, missing in go", name)
			mismatches++
			continue
		}
		if !reflect.DeepEqual(cp, gpk) {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("packages[%q] differs:\n  cjs: %+v\n  go:  %+v", name, cp, gpk)
			}
		}
	}
	for name := range goByName {
		if _, ok := cjsByName[name]; !ok {
			t.Errorf("packages: %q present in go, missing in cjs", name)
		}
	}
	if mismatches > 5 {
		t.Errorf("packages: %d total mismatches (showing first 5)", mismatches)
	}
}

func compareModules(t *testing.T, cjs, gp []model.Module) {
	t.Helper()
	if len(cjs) != len(gp) {
		t.Errorf("modules: cjs has %d, go has %d", len(cjs), len(gp))
	}
	byPath := func(mods []model.Module) map[string]model.Module {
		out := make(map[string]model.Module, len(mods))
		for _, m := range mods {
			out[m.Path] = m
		}
		return out
	}
	cjsByPath, goByPath := byPath(cjs), byPath(gp)
	mismatches := 0
	for path, cm := range cjsByPath {
		gm, ok := goByPath[path]
		if !ok {
			t.Errorf("modules: %q present in cjs, missing in go", path)
			mismatches++
			continue
		}
		if !reflect.DeepEqual(cm, gm) {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("modules[%q] differs:\n  cjs: %+v\n  go:  %+v", path, cm, gm)
			}
		}
	}
	for path := range goByPath {
		if _, ok := cjsByPath[path]; !ok {
			t.Errorf("modules: %q present in go, missing in cjs", path)
		}
	}
	if mismatches > 5 {
		t.Errorf("modules: %d total mismatches (showing first 5)", mismatches)
	}
}

func compareEdges(t *testing.T, cjs, gp []model.Edge) {
	t.Helper()
	if len(cjs) != len(gp) {
		t.Errorf("edges: cjs has %d, go has %d (see the delta explained in testdata/ts-vs-regex-edges.md if using the default tree-sitter parser; this test uses --parser=regex specifically to avoid that delta)", len(cjs), len(gp))
	}
	n := len(cjs)
	if len(gp) < n {
		n = len(gp)
	}
	mismatches := 0
	for i := 0; i < n; i++ {
		if !reflect.DeepEqual(cjs[i], gp[i]) {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("edges[%d] differs:\n  cjs: %+v\n  go:  %+v", i, cjs[i], gp[i])
			}
		}
	}
	if mismatches > 5 {
		t.Errorf("edges: %d total mismatches in the first %d (showing first 5)", mismatches, n)
	}
}
