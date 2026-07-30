package container

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

func TestContainerOf(t *testing.T) {
	t.Run("package set", func(t *testing.T) {
		m := &model.Module{Path: "packages/ai/src/index.ts", Package: model.Str("@draht/ai")}
		if got := ContainerOf(m); got != "pkg:@draht/ai" {
			t.Fatalf("ContainerOf = %q, want pkg:@draht/ai", got)
		}
	})
	t.Run("no package falls back to first path segment", func(t *testing.T) {
		m := &model.Module{Path: "scripts/build.go"}
		if got := ContainerOf(m); got != "dir:scripts" {
			t.Fatalf("ContainerOf = %q, want dir:scripts", got)
		}
	})
	t.Run("no package, root-level file", func(t *testing.T) {
		m := &model.Module{Path: "main.go"}
		if got := ContainerOf(m); got != "dir:main.go" {
			t.Fatalf("ContainerOf = %q, want dir:main.go", got)
		}
	})
	t.Run("empty package pointer treated as absent", func(t *testing.T) {
		m := &model.Module{Path: "scripts/build.go", Package: model.Str("")}
		if got := ContainerOf(m); got != "dir:scripts" {
			t.Fatalf("ContainerOf = %q, want dir:scripts", got)
		}
	})
}

func TestBuildContainers_MultiPackage(t *testing.T) {
	pkgs := []model.Package{
		{Name: "draht-monorepo", Path: "."},
		{Name: "@draht/ai", Path: "packages/ai", Description: model.Str("AI package")},
		{Name: "@draht/tools", Path: "packages/tools"},
	}
	modules := []model.Module{
		{ID: "packages/ai/src/index.ts", Path: "packages/ai/src/index.ts", Package: model.Str("@draht/ai")},
		{ID: "packages/ai/src/other.ts", Path: "packages/ai/src/other.ts", Package: model.Str("@draht/ai")},
		{ID: "packages/tools/src/x.ts", Path: "packages/tools/src/x.ts", Package: model.Str("@draht/tools")},
	}

	containers := BuildContainers(modules, pkgs)
	if len(containers) != 2 {
		t.Fatalf("len(containers) = %d, want 2 (root skipped)", len(containers))
	}
	// Order MUST equal pkgs order (root skipped), not alphabetical or by
	// module count.
	if containers[0].ID != "pkg:@draht/ai" || containers[1].ID != "pkg:@draht/tools" {
		t.Fatalf("containers order = %v, want [pkg:@draht/ai, pkg:@draht/tools]", ids(containers))
	}
	if containers[0].Kind != "package" {
		t.Fatalf("Kind = %q, want package", containers[0].Kind)
	}
	if containers[0].ModuleCount != 2 {
		t.Fatalf("ModuleCount = %d, want 2", containers[0].ModuleCount)
	}
	if containers[0].Description == nil || *containers[0].Description != "AI package" {
		t.Fatalf("Description = %v, want AI package", containers[0].Description)
	}
	if containers[1].ModuleCount != 1 {
		t.Fatalf("ModuleCount = %d, want 1", containers[1].ModuleCount)
	}
	for _, c := range containers {
		if c.TopFiles == nil {
			t.Fatalf("TopFiles must be a non-nil empty slice before ComputeTopFiles runs")
		}
	}
}

func TestBuildContainers_SinglePackageFallback(t *testing.T) {
	// 0 or 1 packages => directory fallback, in module-encounter order,
	// skipping root-level dotted filenames (e.g. "README.md").
	pkgs := []model.Package{{Name: "draht-monorepo", Path: "."}}
	modules := []model.Module{
		{Path: "README.md"}, // first segment "README.md" contains "." -> skipped
		{Path: "scripts/build.go"},
		{Path: "cmd/tool/main.go"},
		{Path: "scripts/other.go"}, // repeat dir, no duplicate container
	}
	containers := BuildContainers(modules, pkgs)
	if len(containers) != 2 {
		t.Fatalf("len(containers) = %d, want 2, got %v", len(containers), ids(containers))
	}
	if containers[0].ID != "dir:scripts" || containers[1].ID != "dir:cmd" {
		t.Fatalf("containers order = %v, want [dir:scripts, dir:cmd] (module-encounter order)", ids(containers))
	}
	if containers[0].Kind != "directory" || containers[0].Description != nil {
		t.Fatalf("directory container shape wrong: %+v", containers[0])
	}
}

func TestBuildContainers_NeverNil(t *testing.T) {
	containers := BuildContainers(nil, nil)
	if containers == nil {
		t.Fatal("BuildContainers must never return a nil slice")
	}
	if len(containers) != 0 {
		t.Fatalf("len = %d, want 0", len(containers))
	}
}

func ids(containers []model.Container) []string {
	out := make([]string, len(containers))
	for i, c := range containers {
		out[i] = c.ID
	}
	return out
}

func TestComputeTopFiles(t *testing.T) {
	modules := []model.Module{
		{
			ID: "packages/ai/src/index.ts", Path: "packages/ai/src/index.ts",
			Package: model.Str("@draht/ai"), Loc: 100,
		},
		{
			ID: "packages/ai/src/cli.ts", Path: "packages/ai/src/cli.ts",
			Package: model.Str("@draht/ai"), Loc: 50,
			EntryPoint: &model.ModuleEntryPoint{Kind: model.EntryKindCLI},
		},
		{
			ID: "packages/ai/src/big.ts", Path: "packages/ai/src/big.ts",
			Package: model.Str("@draht/ai"), Loc: 500,
		},
		{
			ID: "packages/ai/src/big.test.ts", Path: "packages/ai/src/big.test.ts",
			Package: model.Str("@draht/ai"), Loc: 9999, IsTest: true,
		},
	}
	inDeg := map[string]int{"packages/ai/src/index.ts": 5}
	outDeg := map[string]int{"packages/ai/src/big.ts": 10}

	c := model.Container{ID: "pkg:@draht/ai"}
	top := ComputeTopFiles(c, modules, inDeg, outDeg)

	if len(top) != 3 {
		t.Fatalf("len(top) = %d, want 3 (test file excluded, cap 3 since eligible < 6)", len(top))
	}
	for _, tf := range top {
		if tf.Path == "packages/ai/src/big.test.ts" {
			t.Fatal("test module must never appear in topFiles")
		}
	}
	// cli.ts: entryPoint bonus (+6) + package index (+4, "/index." doesn't
	// match "cli.ts" so no bonus there) should give it a high score despite
	// low loc; its reason must be "CLI entry".
	var cli *model.TopFile
	for i := range top {
		if top[i].Path == "packages/ai/src/cli.ts" {
			cli = &top[i]
		}
	}
	if cli == nil {
		t.Fatalf("cli.ts missing from top files: %+v", top)
	}
	if cli.Reason != "CLI entry" {
		t.Fatalf("cli.ts reason = %q, want CLI entry", cli.Reason)
	}

	// index.ts should be tagged "package index" (barrel regex) even without
	// an entryPoint.
	var idx *model.TopFile
	for i := range top {
		if top[i].Path == "packages/ai/src/index.ts" {
			idx = &top[i]
		}
	}
	if idx == nil {
		t.Fatalf("index.ts missing from top files: %+v", top)
	}
	if idx.Reason != "package index" {
		t.Fatalf("index.ts reason = %q, want package index", idx.Reason)
	}

	// Sort: score DESC, tie-break path ASC.
	for i := 1; i < len(top); i++ {
		if top[i-1].Score < top[i].Score {
			t.Fatalf("topFiles not sorted score DESC: %+v", top)
		}
	}
}

func TestComputeTopFiles_EmptyContainer(t *testing.T) {
	c := model.Container{ID: "pkg:@draht/nothing"}
	top := ComputeTopFiles(c, nil, nil, nil)
	if top == nil || len(top) != 0 {
		t.Fatalf("ComputeTopFiles on empty container = %v, want non-nil empty slice", top)
	}
}

func TestComputeTopFiles_CapSixOrMore(t *testing.T) {
	var modules []model.Module
	for i := 0; i < 8; i++ {
		modules = append(modules, model.Module{
			ID:      "packages/big/src/f" + string(rune('a'+i)) + ".ts",
			Path:    "packages/big/src/f" + string(rune('a'+i)) + ".ts",
			Package: model.Str("@draht/big"),
			Loc:     10 * (i + 1),
		})
	}
	c := model.Container{ID: "pkg:@draht/big"}
	top := ComputeTopFiles(c, modules, nil, nil)
	if len(top) != 5 {
		t.Fatalf("len(top) = %d, want 5 (cap for >=6 eligible modules)", len(top))
	}
}
