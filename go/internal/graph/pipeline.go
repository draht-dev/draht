package graph

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/draht-dev/draht/go/internal/cache"
	"github.com/draht-dev/draht/go/internal/extract"
	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// Options configures a Build run. See design §7 for the CLI flag mapping.
type Options struct {
	Root        string
	OutDir      string
	CacheDir    string
	Jobs        int
	Parser      parse.Parser
	NoCache     bool
	ASTMaxBytes int
	ASTMaxLine  int
	Quiet       bool
}

// Report is the run summary the CLI prints and the caller inspects.
type Report struct {
	Modules     int
	Edges       int
	TotalLoc    int
	BuildMs     int64
	CacheHits   int
	CacheMisses int
	Warnings    []string
	Changed     bool
}

// maxWorkers caps the default worker-pool size (design §4.2: measured
// diminishing returns above 8 workers on an 8-logical-core box, and higher
// counts multiply per-worker arena retention for the tree-sitter parser).
const maxWorkers = 8

// Build runs the five-stage pipeline described in design §4.1:
//
//  1. DISCOVER   scan.FindRepoRoot -> scan.Discover -> scan.ScanPackages
//  2. CACHE LOAD  cache.Store.Load
//  3. EXTRACT     bounded worker pool over extract.File (the only concurrency)
//  4. ASSEMBLE    modules[]/layer/edges/stats (via Assemble)
//  5. EMIT        model.WriteIfChanged + cache.Store.Commit
//
// Build degrades gracefully wherever the design specifies a non-fatal
// failure (cache load/commit errors, per-file extraction errors, a git
// failure surfaced through scan) — those are recorded in Report.Warnings,
// never returned as an error. It returns a non-nil error only for the
// unrecoverable cases: repo-root/discovery/package-scan failure, or a
// failure to create/write the output directory.
func Build(ctx context.Context, opts Options) (*model.Map, Report, error) {
	start := time.Now()
	report := Report{}

	root := opts.Root
	if root == "" {
		r, err := scan.FindRepoRoot(".")
		if err != nil {
			return model.NewMap(), report, fmt.Errorf("graph: resolve repo root: %w", err)
		}
		root = r
	}

	discovery, err := scan.Discover(root)
	if err != nil {
		return model.NewMap(), report, fmt.Errorf("graph: discover: %w", err)
	}

	pkgs, err := scan.ScanPackages(root)
	if err != nil {
		return model.NewMap(), report, fmt.Errorf("graph: scan packages: %w", err)
	}

	parser := opts.Parser
	if parser == nil {
		parser = parse.NewRegex()
	}

	store := newStore(opts, root)
	snap, loadErr := store.Load(ctx)
	if loadErr != nil {
		report.Warnings = append(report.Warnings, fmt.Sprintf("cache load: %v", loadErr))
	}
	if snap == nil {
		snap = cache.NewSnapshot()
	}

	codeFiles := discovery.CodeFiles()
	factsVersion := cache.ComposeVersion(extract.FactsSchema, parser.Version(), extract.Version)
	facts, warnings := extractAll(ctx, codeFiles, parser, snap, factsVersion, workerCount(opts.Jobs))
	report.Warnings = append(report.Warnings, warnings...)

	// extractAll's job-feed loop breaks early on ctx.Done() (see its
	// comment), leaving unprocessed indices nil in facts/results. Build MUST
	// NOT proceed past this point on cancellation: doing so used to
	// silently assemble a near-empty map from those nil entries and
	// overwrite a perfectly good MAP.json via WriteIfChanged, returning a
	// nil error the whole way — a caller cancelling this ctx (there is
	// exactly one exported entry point, Build, and its ctx parameter
	// promises cancellation is honored) would get a truncated map with no
	// indication anything went wrong.
	if err := ctx.Err(); err != nil {
		return model.NewMap(), report, fmt.Errorf("graph: build: %w", err)
	}

	binFiles := BuildBinFiles(pkgs)

	modules := make([]model.Module, len(codeFiles))
	modulePaths := make([]string, len(codeFiles))
	for i, f := range codeFiles {
		modules[i] = buildModule(f, facts[i], pkgs, binFiles)
		modulePaths[i] = f.Rel
	}

	workspaceEntry := BuildWorkspaceEntries(pkgs, toModuleSet(modulePaths))
	resolver := NewResolver(NewResolverIndex(modulePaths, workspaceEntry))

	mi := make([]ModuleImports, 0, len(codeFiles))
	sitesByPath := make(map[string][]extract.CallSite)
	for i, f := range codeFiles {
		if f.Lang != scan.LangTypeScript && f.Lang != scan.LangJavaScript {
			continue // design D3: edges are built from TS/JS modules only
		}
		if facts[i] == nil {
			continue
		}
		mi = append(mi, ModuleImports{Path: f.Rel, Imports: facts[i].Imports})
		if len(facts[i].CallSites) > 0 {
			sitesByPath[f.Rel] = facts[i].CallSites
		}
	}
	edges := BuildEdges(mi, resolver)
	callEdges := BuildCallEdgesAll(mi, resolver, sitesByPath)

	// Phase 2: inline SECURITY/BUG/.../WHY marker scan over EVERY eligible
	// scanned file (not just code modules — draht-tools.cjs:2159 reaches
	// markdown/html/sql too).
	rationale := buildRationaleAll(discovery.Files, workerCount(opts.Jobs))

	pkgHasBin := buildPkgHasBin(pkgs)

	graphOutDir := scan.GraphOutDir(root)
	groupsJSON, _ := os.ReadFile(filepath.Join(graphOutDir, "GROUPS.json"))
	flowsJSON, _ := os.ReadFile(filepath.Join(graphOutDir, "FLOWS.json"))

	planning := readPlanningDocs(root)

	modelPkgs := make([]model.Package, len(pkgs))
	for i, p := range pkgs {
		modelPkgs[i] = convertPackage(p)
	}

	m := Assemble(AssembleInput{
		Root:             filepath.Base(root),
		Modules:          modules,
		Edges:            edges,
		Packages:         modelPkgs,
		LangCounts:       discovery.LangCounts,
		Truncated:        discovery.Truncated,
		CallEdges:        callEdges,
		RationaleEntries: rationale,
		PkgHasBin:        pkgHasBin,
		GroupsJSON:       groupsJSON,
		FlowsJSON:        flowsJSON,
		PlanningState:    planning.state,
		PlanningRoadmap:  planning.roadmap,
		PlanningProject:  planning.project,
		PlanningDomain:   planning.domain,
	})
	m.BuildMs = int(time.Since(start).Milliseconds())

	outDir := opts.OutDir
	if outDir == "" {
		outDir = scan.GraphOutDir(root)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return m, report, fmt.Errorf("graph: create out dir: %w", err)
	}
	outPath := filepath.Join(outDir, "MAP.json")
	changed, err := model.WriteIfChanged(outPath, m)
	if err != nil {
		return m, report, fmt.Errorf("graph: write MAP.json: %w", err)
	}
	report.Changed = changed

	if commitErr := store.Commit(ctx, snap); commitErr != nil {
		report.Warnings = append(report.Warnings, fmt.Sprintf("cache commit: %v", commitErr))
	}

	cstats := snap.Stats()
	report.CacheHits = cstats.Hits
	report.CacheMisses = cstats.Misses
	report.Modules = len(modules)
	report.Edges = len(edges)
	report.TotalLoc = m.Stats.TotalLoc
	report.BuildMs = int64(m.BuildMs)

	return m, report, nil
}

func newStore(opts Options, root string) cache.Store {
	if opts.NoCache {
		return cache.NewNopStore()
	}
	dir := opts.CacheDir
	if dir == "" {
		dir = scan.CacheDir(root)
	}
	return cache.NewFileStore(dir)
}

func workerCount(jobs int) int {
	if jobs > 0 {
		return jobs
	}
	n := runtime.GOMAXPROCS(0)
	if n > maxWorkers {
		n = maxWorkers
	}
	if n < 1 {
		n = 1
	}
	return n
}

// buildPkgHasBin builds internal/container's PkgHasBin probe from the
// already-parsed package manifests (scan.Package.Bin — draht-tools.cjs:1195-
// 1201's own bin read), so no extra filesystem access is needed at assemble
// time.
func buildPkgHasBin(pkgs []scan.Package) func(pkgPath string) bool {
	set := make(map[string]bool, len(pkgs))
	for _, p := range pkgs {
		if len(p.Bin) > 0 {
			set[p.Path] = true
		}
	}
	return func(pkgPath string) bool { return set[pkgPath] }
}

func toModuleSet(paths []string) map[string]struct{} {
	out := make(map[string]struct{}, len(paths))
	for _, p := range paths {
		out[p] = struct{}{}
	}
	return out
}

// extractAll is the pipeline's only concurrent stage: a bounded worker pool
// over jobs (input indices), reading + hashing + cache-checking + (on a
// miss) extracting each file. results is index-addressed so no result
// channel or re-sort is needed — result order is always input order
// (design §4.2).
func extractAll(ctx context.Context, files []scan.File, p parse.Parser, snap *cache.Snapshot, version string, workers int) ([]*extract.Facts, []string) {
	results := make([]*extract.Facts, len(files))
	warnings := make([]string, len(files))

	jobs := make(chan int, workers*4)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i], warnings[i] = extractOne(ctx, files[i], p, snap, version)
			}
		}()
	}
loop:
	for i := range files {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break loop
		}
	}
	close(jobs)
	wg.Wait()

	out := make([]string, 0, len(warnings))
	for i := range files {
		if warnings[i] != "" {
			out = append(out, warnings[i]) // index order, not completion order (deterministic)
		}
	}
	return results, out
}

func extractOne(ctx context.Context, f scan.File, p parse.Parser, snap *cache.Snapshot, version string) (facts *extract.Facts, warning string) {
	defer func() {
		if r := recover(); r != nil {
			facts = nil
			warning = fmt.Sprintf("%s: panic during extraction: %v", f.Rel, r)
		}
	}()

	// A file that fails the CJS read gate (>= 1 MiB, or "other" language —
	// the latter never reaches here since CodeFiles() already filters to
	// code languages) still becomes a module with zeroed facts, per
	// design's Readable() contract: buildModule handles a nil *Facts.
	if !f.Readable() {
		return nil, ""
	}

	content, err := os.ReadFile(f.Abs)
	if err != nil {
		return nil, fmt.Sprintf("%s: read: %v", f.Rel, err)
	}

	sum := sha256.Sum256(content)
	key := cache.Key{Path: f.Rel, ContentHash: hex.EncodeToString(sum[:]), Version: version}
	if payload, ok := snap.Get(key); ok {
		if fa, err := extract.UnmarshalFacts(payload); err == nil {
			return fa, ""
		}
		// A corrupt cached payload degrades to a cold extraction, never a
		// fatal error.
	}

	fa, err := extract.File(ctx, p, parse.Lang(f.Lang), f.Rel, content)
	if err != nil {
		return nil, fmt.Sprintf("%s: extract: %v", f.Rel, err)
	}
	if payload, mErr := extract.MarshalFacts(fa); mErr == nil {
		snap.Put(key, payload)
	}
	return fa, ""
}

// buildModule assembles one model.Module from a discovered file, its
// (possibly nil, when extraction failed or was skipped) Facts, the
// workspace package list, and the binFiles entry-point map.
func buildModule(f scan.File, fa *extract.Facts, pkgs []scan.Package, binFiles map[string]string) model.Module {
	isTest := f.IsTestFile()

	var pkgName *string
	if pkg, ok := scan.PackageForRel(pkgs, f.Rel); ok && pkg.Name != "" {
		name := pkg.Name
		pkgName = &name
	}

	var loc int
	exports := []model.Export{}
	symbols := []model.Symbol{}
	sinks := []string{}
	sinkSites := []model.SinkSite{}
	routes := []model.Route{}
	if fa != nil {
		loc = fa.Loc
		if fa.Exports != nil {
			exports = convertExports(fa.Exports)
		}
		if fa.Symbols != nil {
			symbols = convertSymbols(fa.Symbols)
		}
		if fa.Sinks != nil {
			sinks = fa.Sinks
		}
		if fa.SinkSites != nil {
			sinkSites = convertSinkSites(fa.SinkSites)
		}
		if fa.Routes != nil {
			routes = convertRoutes(fa.Routes)
		}
	}

	// Per-module caps (draht-tools.cjs:2182-2186): exports 30, sinkSites
	// 10, routes 20. Symbols/sinks are already capped/deduped upstream by
	// extract (buildSymbols hard-stops at 60; DetectSinks dedupes).
	if len(exports) > 30 {
		exports = exports[:30]
	}
	if len(sinkSites) > 10 {
		sinkSites = sinkSites[:10]
	}
	if len(routes) > 20 {
		routes = routes[:20]
	}

	binName := binFiles[f.Rel]
	mainName := mainNameFor(binFiles, f.Rel)
	entryPoint := assignEntryPoint(binName, mainName, routes, isTest)
	isBin := binName != ""
	layer := ClassifyLayer(f.Rel, sinks, len(routes) > 0, isBin, len(exports) > 0)

	return model.Module{
		ID:         f.Rel,
		Path:       f.Rel,
		Language:   string(f.Lang),
		Size:       f.Size,
		Loc:        loc,
		IsTest:     isTest,
		Package:    pkgName,
		Exports:    exports,
		Symbols:    symbols,
		Sinks:      sinks,
		SinkSites:  sinkSites,
		Routes:     routes,
		EntryPoint: entryPoint,
		Layer:      layer,
	}
}

// planningDocs holds the raw contents of the .planning/ narrative files that
// feed MAP.json's `planning` block. Absent or unreadable files are "", which
// is exactly what the CJS's `!!content` truthiness test treats as absent.
type planningDocs struct {
	state   string
	roadmap string
	project string
	domain  string
}

// readPlanningDocs mirrors visReadPlanning (draht-tools.cjs:1746-1755),
// including its DOMAIN.md -> DOMAIN-MODEL.md fallback. Read errors are
// deliberately indistinguishable from "absent": the CJS guards with
// existsSync and would likewise produce null for an unreadable file, and a
// permissions problem on a narrative doc must not fail an indexing run.
func readPlanningDocs(root string) planningDocs {
	dir := filepath.Join(root, scan.PlanningDir)
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return ""
		}
		return string(b)
	}
	d := planningDocs{
		state:   read("STATE.md"),
		roadmap: read("ROADMAP.md"),
		project: read("PROJECT.md"),
		domain:  read("DOMAIN.md"),
	}
	if d.domain == "" {
		d.domain = read("DOMAIN-MODEL.md")
	}
	return d
}
