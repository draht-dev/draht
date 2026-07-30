package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
)

func TestBuildBinFilesStringBin(t *testing.T) {
	pkgs := []scan.Package{
		{Name: "draht-tools", Path: "packages/draht-tools", Bin: []scan.BinEntry{{Name: "draht-tools", File: "bin/draht-tools.cjs"}}},
	}
	got := BuildBinFiles(pkgs)
	if got["packages/draht-tools/bin/draht-tools.cjs"] != "draht-tools" {
		t.Errorf("got %v", got)
	}
}

func TestBuildBinFilesRootPackage(t *testing.T) {
	pkgs := []scan.Package{
		{Name: "root-cli", Path: ".", Bin: []scan.BinEntry{{Name: "root-cli", File: "cli.js"}}},
	}
	got := BuildBinFiles(pkgs)
	if got["cli.js"] != "root-cli" {
		t.Errorf("got %v, want cli.js -> root-cli", got)
	}
}

func TestBuildBinFilesCompiledSegmentFallback(t *testing.T) {
	pkgs := []scan.Package{
		{Name: "draht-tools", Path: "packages/draht-tools", Bin: []scan.BinEntry{{Name: "draht-tools", File: "dist/cli.js"}}},
	}
	got := BuildBinFiles(pkgs)
	if got["packages/draht-tools/dist/cli.js"] != "draht-tools" {
		t.Errorf("literal path missing: %v", got)
	}
	for _, ext := range []string{".ts", ".tsx", ".js", ".mjs", ".cjs"} {
		key := "packages/draht-tools/src/cli" + ext
		if got[key] != "draht-tools" {
			t.Errorf("expected src fallback %q -> draht-tools, got %v", key, got[key])
		}
	}
}

func TestBuildBinFilesCompiledSegmentFallbackDoesNotOverwriteExisting(t *testing.T) {
	// A LATER-registered literal path should never be clobbered by an
	// EARLIER package's fallback registration (design: fallback keys are
	// only added "if not already present").
	pkgs := []scan.Package{
		{Name: "pkg-a", Path: "packages/a", Bin: []scan.BinEntry{{Name: "pkg-a", File: "dist/cli.js"}}},
		{Name: "pkg-b", Path: "packages/a", Bin: []scan.BinEntry{{Name: "pkg-b", File: "src/cli.ts"}}},
	}
	got := BuildBinFiles(pkgs)
	if got["packages/a/src/cli.ts"] != "pkg-b" {
		t.Errorf("expected the literal pkg-b registration to win, got %v", got["packages/a/src/cli.ts"])
	}
}

func TestBuildBinFilesMainField(t *testing.T) {
	pkgs := []scan.Package{
		{Name: "@draht/ai", Path: "packages/ai", Main: "dist/index.js"},
	}
	got := BuildBinFiles(pkgs)
	if got[mainKeyPrefix+"packages/ai/dist/index.js"] != "main:@draht/ai" {
		t.Errorf("got %v", got)
	}
	if got[mainKeyPrefix+"packages/ai/src/index.ts"] != "main:@draht/ai" {
		t.Errorf("expected the __main__: src fallback to be registered too, got %v", got)
	}
	// The unprefixed key must NOT be set by a main field (only bin entries
	// register the unprefixed key).
	if _, ok := got["packages/ai/dist/index.js"]; ok {
		t.Errorf("main field must not register the unprefixed bin key")
	}
}

func TestSrcFallbackNoCompiledSegment(t *testing.T) {
	if _, ok := srcFallback("packages/ai/src/index.ts"); ok {
		t.Error("expected no fallback for a path with no compiled segment")
	}
}

func TestAssignEntryPointPrecedence(t *testing.T) {
	httpRoutes := []model.Route{{Method: "GET", Path: "/a"}, {Method: "POST", Path: "/b"}}

	cases := []struct {
		name     string
		binName  string
		mainName string
		routes   []model.Route
		isTest   bool
		want     *model.ModuleEntryPoint
	}{
		{
			name:    "cli wins over everything",
			binName: "draht-tools",
			routes:  httpRoutes,
			want:    &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "draht-tools"},
		},
		{
			name:   "http when routes present and not a test",
			routes: httpRoutes,
			want:   &model.ModuleEntryPoint{Kind: model.EntryKindHTTP, Routes: httpRoutes},
		},
		{
			name:   "http suppressed for test files",
			routes: httpRoutes,
			isTest: true,
			want:   nil,
		},
		{
			name:     "library entry when file is a package main and nothing else set",
			mainName: "@draht/ai",
			want:     &model.ModuleEntryPoint{Kind: model.EntryKindLibrary, Name: "@draht/ai"},
		},
		{
			name:     "cli still wins over a main-field library entry",
			binName:  "draht-tools",
			mainName: "@draht/ai",
			want:     &model.ModuleEntryPoint{Kind: model.EntryKindCLI, Name: "draht-tools"},
		},
		{
			name:     "http still wins over a main-field library entry",
			mainName: "@draht/ai",
			routes:   httpRoutes,
			want:     &model.ModuleEntryPoint{Kind: model.EntryKindHTTP, Routes: httpRoutes},
		},
		{
			name: "no entry point when nothing matches",
			want: nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := assignEntryPoint(c.binName, c.mainName, c.routes, c.isTest)
			assertEntryPointEqual(t, got, c.want)
		})
	}
}

func TestAssignEntryPointCapsHTTPRoutesAtEight(t *testing.T) {
	routes := make([]model.Route, 12)
	for i := range routes {
		routes[i] = model.Route{Method: "GET", Path: "/x"}
	}
	got := assignEntryPoint("", "", routes, false)
	if got == nil || len(got.Routes) != 8 {
		t.Fatalf("expected exactly 8 routes, got %v", got)
	}
}

func assertEntryPointEqual(t *testing.T, got, want *model.ModuleEntryPoint) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatalf("got %+v, want nil", got)
		}
		return
	}
	if got == nil {
		t.Fatalf("got nil, want %+v", want)
	}
	if got.Kind != want.Kind || got.Name != want.Name || len(got.Routes) != len(want.Routes) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMainNameFor(t *testing.T) {
	binFiles := map[string]string{mainKeyPrefix + "packages/ai/src/index.ts": "main:@draht/ai"}
	if got := mainNameFor(binFiles, "packages/ai/src/index.ts"); got != "@draht/ai" {
		t.Errorf("got %q, want @draht/ai", got)
	}
	if got := mainNameFor(binFiles, "nonexistent.ts"); got != "" {
		t.Errorf("got %q, want empty string", got)
	}
}
