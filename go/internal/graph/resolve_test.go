package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/scan"
)

func TestResolverRelative(t *testing.T) {
	modules := map[string]struct{}{
		"packages/ai/src/index.ts":      {},
		"packages/ai/src/models.ts":     {},
		"packages/ai/src/dir/index.tsx": {},
		"packages/ai/src/exact.js":      {}, // exists literally, ext included
	}
	idx := &ResolverIndex{Modules: modules, WorkspaceEntry: map[string]string{}}
	r := NewResolver(idx)

	cases := []struct {
		name     string
		spec     string
		fromDir  string
		wantPath string
		wantOK   bool
	}{
		{
			name:     "extensionless relative resolves via probe",
			spec:     "./models",
			fromDir:  "packages/ai/src",
			wantPath: "packages/ai/src/models.ts",
			wantOK:   true,
		},
		{
			name:     "NodeNext .js on disk resolves to .ts",
			spec:     "./models.js",
			fromDir:  "packages/ai/src",
			wantPath: "packages/ai/src/models.ts",
			wantOK:   true,
		},
		{
			name:     "exact path hit wins before extension probing",
			spec:     "./exact.js",
			fromDir:  "packages/ai/src",
			wantPath: "packages/ai/src/exact.js",
			wantOK:   true,
		},
		{
			name:     "directory resolves to index file",
			spec:     "./dir",
			fromDir:  "packages/ai/src",
			wantPath: "packages/ai/src/dir/index.tsx",
			wantOK:   true,
		},
		{
			name:    "unresolvable relative import",
			spec:    "./nonexistent",
			fromDir: "packages/ai/src",
			wantOK:  false,
		},
		{
			name:     "parent-relative import",
			spec:     "../src/models",
			fromDir:  "packages/ai/scripts",
			wantPath: "packages/ai/src/models.ts",
			wantOK:   true,
		},
		{
			name:    "root file, fromDir is '.'",
			spec:    "./index",
			fromDir: ".",
			wantOK:  false, // "./index" -> "index" (no top-level index.ts in fixture)
		},
		{
			name:     "/-prefixed spec is joined onto fromDir, not filesystem-absolute",
			spec:     "/models",
			fromDir:  "packages/ai/src",
			wantPath: "packages/ai/src/models.ts",
			wantOK:   true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := r.Resolve(c.spec, c.fromDir)
			if ok != c.wantOK {
				t.Fatalf("Resolve(%q, %q) ok = %v, want %v (got path %q)", c.spec, c.fromDir, ok, c.wantOK, got)
			}
			if ok && got != c.wantPath {
				t.Errorf("Resolve(%q, %q) = %q, want %q", c.spec, c.fromDir, got, c.wantPath)
			}
		})
	}
}

func TestResolverBare(t *testing.T) {
	modules := map[string]struct{}{
		"packages/ai/src/index.ts": {},
	}
	workspaceEntry := map[string]string{
		"@draht/ai":      "packages/ai/src/index.ts",
		"draht-monorepo": "index.ts",
	}
	idx := &ResolverIndex{Modules: modules, WorkspaceEntry: workspaceEntry}
	r := NewResolver(idx)

	cases := []struct {
		name     string
		spec     string
		wantPath string
		wantOK   bool
	}{
		{
			name:     "exact scoped package name",
			spec:     "@draht/ai",
			wantPath: "packages/ai/src/index.ts",
			wantOK:   true,
		},
		{
			name:     "scoped subpath collapses to package entry",
			spec:     "@draht/ai/models",
			wantPath: "packages/ai/src/index.ts",
			wantOK:   true,
		},
		{
			name:     "scoped deep subpath still collapses to package entry",
			spec:     "@draht/ai/models/deep/path",
			wantPath: "packages/ai/src/index.ts",
			wantOK:   true,
		},
		{
			name:     "unscoped exact package name",
			spec:     "draht-monorepo",
			wantPath: "index.ts",
			wantOK:   true,
		},
		{
			name:   "unscoped bare specifier with no matching workspace package is external",
			spec:   "lodash",
			wantOK: false,
		},
		{
			name:   "unscoped subpath with no matching workspace package is external",
			spec:   "lodash/merge",
			wantOK: false,
		},
		{
			name:   "node: protocol specifier never resolves",
			spec:   "node:fs",
			wantOK: false,
		},
		{
			name:   "unknown scoped package is external",
			spec:   "@other/pkg",
			wantOK: false,
		},
		{
			name:   "internal subpath-imports (#foo) are unresolvable",
			spec:   "#internal",
			wantOK: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := r.Resolve(c.spec, ".")
			if ok != c.wantOK {
				t.Fatalf("Resolve(%q) ok = %v, want %v (got path %q)", c.spec, ok, c.wantOK, got)
			}
			if ok && got != c.wantPath {
				t.Errorf("Resolve(%q) = %q, want %q", c.spec, got, c.wantPath)
			}
		})
	}
}

func TestResolverEmptySpecifier(t *testing.T) {
	r := NewResolver(&ResolverIndex{Modules: map[string]struct{}{}, WorkspaceEntry: map[string]string{}})
	if _, ok := r.Resolve("", "."); ok {
		t.Error("expected an empty specifier to never resolve")
	}
}

func TestEntryCandidatesOrder(t *testing.T) {
	pkg := scan.Package{
		Name:         "@draht/ai",
		Main:         "dist/index.js",
		Module:       "dist/index.mjs",
		ExportLeaves: []string{"./dist/index.js", "./dist/index.d.ts"},
	}
	got := EntryCandidates(pkg)
	want := []string{
		"dist/index.js", "dist/index.mjs",
		"./dist/index.js", "./dist/index.d.ts",
		"src/index.ts", "src/index.js", "index.ts", "index.js",
	}
	if len(got) != len(want) {
		t.Fatalf("EntryCandidates() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("EntryCandidates()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestResolveWorkspaceEntryDistToSrcFallback(t *testing.T) {
	// "dist/index.js" does NOT contain "src" at all -- extension substitution
	// alone cannot rewrite "dist" to "src". This mirrors the real CJS
	// behavior: workspaceEntryByName's dist->src recovery relies on the
	// package actually shipping a source-tree candidate (e.g. via the
	// hardcoded "src/index.ts" fallback candidate), not on path rewriting
	// inside a single candidate. Confirms candidate-order fallthrough.
	modules := map[string]struct{}{
		"packages/ai/src/index.ts": {},
	}
	candidates := []string{"dist/index.js", "src/index.ts"}
	got, ok := ResolveWorkspaceEntry("packages/ai", candidates, modules)
	if !ok {
		t.Fatal("expected the second candidate (src/index.ts) to resolve")
	}
	if got != "packages/ai/src/index.ts" {
		t.Errorf("got %q, want packages/ai/src/index.ts", got)
	}
}

func TestResolveWorkspaceEntryExtensionSubstitution(t *testing.T) {
	// A candidate whose own extension, once substituted, matches a real
	// module: "index.js" -> replace ".js" with ".ts" -> "index.ts".
	modules := map[string]struct{}{
		"packages/ai/index.ts": {},
	}
	got, ok := ResolveWorkspaceEntry("packages/ai", []string{"index.js"}, modules)
	if !ok || got != "packages/ai/index.ts" {
		t.Errorf("got (%q, %v), want (packages/ai/index.ts, true)", got, ok)
	}
}

func TestBuildWorkspaceEntries(t *testing.T) {
	modules := map[string]struct{}{
		"packages/ai/src/index.ts":           {},
		"packages/coding-agent/src/index.ts": {},
	}
	pkgs := []scan.Package{
		{Name: "@draht/ai", Path: "packages/ai", Main: "dist/index.js"},
		{Name: "@draht/coding-agent", Path: "packages/coding-agent", Main: "dist/index.js"},
		{Name: "@draht/nothing", Path: "packages/nothing", Main: "dist/index.js"},
	}
	got := BuildWorkspaceEntries(pkgs, modules)
	if got["@draht/ai"] != "packages/ai/src/index.ts" {
		t.Errorf("@draht/ai = %q", got["@draht/ai"])
	}
	if got["@draht/coding-agent"] != "packages/coding-agent/src/index.ts" {
		t.Errorf("@draht/coding-agent = %q", got["@draht/coding-agent"])
	}
	if _, ok := got["@draht/nothing"]; ok {
		t.Errorf("expected @draht/nothing to be absent (no candidate resolves)")
	}
}

func TestBuildWorkspaceEntriesRootPackage(t *testing.T) {
	modules := map[string]struct{}{
		"index.ts": {},
	}
	pkgs := []scan.Package{
		{Name: "draht-monorepo", Path: ".", Main: "index.ts"},
	}
	got := BuildWorkspaceEntries(pkgs, modules)
	if got["draht-monorepo"] != "index.ts" {
		t.Errorf("draht-monorepo = %q, want index.ts", got["draht-monorepo"])
	}
}
