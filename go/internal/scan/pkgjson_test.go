package scan

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestOrderedObjectKeys(t *testing.T) {
	got, err := OrderedObjectKeys([]byte(`{"zeta":1,"alpha":{"nested":true},"middle":[1,2,3]}`))
	if err != nil {
		t.Fatalf("OrderedObjectKeys: %v", err)
	}
	want := []string{"zeta", "alpha", "middle"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("OrderedObjectKeys = %v, want %v", got, want)
	}
}

func TestOrderedObjectKeys_NotAnObject(t *testing.T) {
	if _, err := OrderedObjectKeys([]byte(`[1,2,3]`)); err == nil {
		t.Error("OrderedObjectKeys([1,2,3]) = nil error, want an error")
	}
}

func TestExportLeavesFromRaw_DocumentOrder(t *testing.T) {
	raw := []byte(`{
		".": {"types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs"},
		"./package.json": "./package.json"
	}`)
	got, err := exportLeavesFromRaw(raw)
	if err != nil {
		t.Fatalf("exportLeavesFromRaw: %v", err)
	}
	want := []string{"./dist/index.d.ts", "./dist/index.js", "./dist/index.cjs", "./package.json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("exportLeavesFromRaw = %v, want %v", got, want)
	}
}

func TestDiscoverWorkspacePatterns_PnpmYaml(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "pnpm-workspace.yaml"), ""+
		"packages:\n"+
		"  - 'packages/*'\n"+
		"  - \"apps/*\" # comment\n"+
		"  - tools/single\n"+
		"other: true\n")

	got, err := DiscoverWorkspacePatterns(root)
	if err != nil {
		t.Fatalf("DiscoverWorkspacePatterns: %v", err)
	}
	want := []string{"packages/*", "apps/*", "tools/single"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiscoverWorkspacePatterns = %v, want %v", got, want)
	}
}

func TestDiscoverWorkspacePatterns_DefaultFallback(t *testing.T) {
	root := t.TempDir()
	got, err := DiscoverWorkspacePatterns(root)
	if err != nil {
		t.Fatalf("DiscoverWorkspacePatterns: %v", err)
	}
	want := []string{"packages/*"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiscoverWorkspacePatterns = %v, want %v", got, want)
	}
}

func TestDiscoverWorkspacePatterns_RootPackageJSONArray(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "package.json"), `{"name":"root","workspaces":["packages/*","apps/*"]}`)
	got, err := DiscoverWorkspacePatterns(root)
	if err != nil {
		t.Fatalf("DiscoverWorkspacePatterns: %v", err)
	}
	want := []string{"packages/*", "apps/*"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiscoverWorkspacePatterns = %v, want %v", got, want)
	}
}

func TestDiscoverWorkspacePatterns_LernaJSON(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "lerna.json"), `{"packages":["modules/*"]}`)
	got, err := DiscoverWorkspacePatterns(root)
	if err != nil {
		t.Fatalf("DiscoverWorkspacePatterns: %v", err)
	}
	want := []string{"modules/*"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DiscoverWorkspacePatterns = %v, want %v", got, want)
	}
}

func TestExpandWorkspacePattern_DoubleStar(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "openauthjs", "packages", "core", "package.json"), `{"name":"core"}`)
	mustWriteFile(t, filepath.Join(root, "openauthjs", "packages", "sub", "deep", "package.json"), `{"name":"deep"}`)
	mustWriteFile(t, filepath.Join(root, "openauthjs", "package.json"), `{"name":"openauthjs-root"}`)

	got, err := ExpandWorkspacePattern(root, "openauthjs/packages/**")
	if err != nil {
		t.Fatalf("ExpandWorkspacePattern: %v", err)
	}
	want := []string{
		filepath.Join(root, "openauthjs", "packages", "core", "package.json"),
		filepath.Join(root, "openauthjs", "packages", "sub", "deep", "package.json"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExpandWorkspacePattern(**) = %v, want %v", got, want)
	}
}

func TestExpandWorkspacePattern_PartialWildcard(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "packages", "foo-a", "package.json"), `{"name":"foo-a"}`)
	mustWriteFile(t, filepath.Join(root, "packages", "foo-b", "package.json"), `{"name":"foo-b"}`)
	mustWriteFile(t, filepath.Join(root, "packages", "bar", "package.json"), `{"name":"bar"}`)

	got, err := ExpandWorkspacePattern(root, "packages/foo-*")
	if err != nil {
		t.Fatalf("ExpandWorkspacePattern: %v", err)
	}
	want := []string{
		filepath.Join(root, "packages", "foo-a", "package.json"),
		filepath.Join(root, "packages", "foo-b", "package.json"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExpandWorkspacePattern(foo-*) = %v, want %v", got, want)
	}
}

func TestExpandWorkspacePattern_SkipsIgnoredAndDotDirs(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "packages", "node_modules", "package.json"), `{"name":"nm"}`)
	mustWriteFile(t, filepath.Join(root, "packages", ".hidden", "package.json"), `{"name":"hidden"}`)
	mustWriteFile(t, filepath.Join(root, "packages", "real", "package.json"), `{"name":"real"}`)

	got, err := ExpandWorkspacePattern(root, "packages/*")
	if err != nil {
		t.Fatalf("ExpandWorkspacePattern: %v", err)
	}
	want := []string{filepath.Join(root, "packages", "real", "package.json")}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ExpandWorkspacePattern(*) = %v, want %v", got, want)
	}
}

// TestScanPackages_NestedWorkspaceAttribution reproduces the reference
// MAP.json behaviour (design §6, WP-A pkgjson_test.go): a nested example
// package discovered by a LATER pattern loses its own files to the earlier
// (parent) package, because PackageForRel is first-match-wins over pkgs
// order, not longest-prefix.
func TestScanPackages_NestedWorkspaceAttribution(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "package.json"),
		`{"name":"draht-monorepo","workspaces":["packages/*","packages/*/example"]}`)
	mustWriteFile(t, filepath.Join(root, "packages", "web-ui", "package.json"), `{
		"name": "@draht/web-ui",
		"version": "1.0.0",
		"dependencies": {"zeta-dep": "^1.0.0", "alpha-dep": "^2.0.0", "middle-dep": "workspace:*"},
		"exports": {
			".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"},
			"./package.json": "./package.json"
		}
	}`)
	mustWriteFile(t, filepath.Join(root, "packages", "web-ui", "example", "package.json"),
		`{"name":"draht-web-ui-example","version":"0.0.1"}`)
	mustWriteFile(t, filepath.Join(root, "packages", "web-ui", "example", "src", "main.ts"), "export {};\n")

	pkgs, err := ScanPackages(root)
	if err != nil {
		t.Fatalf("ScanPackages: %v", err)
	}

	names := make([]string, len(pkgs))
	for i, p := range pkgs {
		names[i] = p.Name
	}
	wantOrder := []string{"draht-monorepo", "@draht/web-ui", "draht-web-ui-example"}
	if !reflect.DeepEqual(names, wantOrder) {
		t.Fatalf("pkgs order = %v, want %v", names, wantOrder)
	}

	// Root manifest carries workspace patterns; the others must not.
	if !reflect.DeepEqual(pkgs[0].WorkspacePatterns, []string{"packages/*", "packages/*/example"}) {
		t.Errorf("root WorkspacePatterns = %v", pkgs[0].WorkspacePatterns)
	}
	if pkgs[1].WorkspacePatterns != nil {
		t.Errorf("@draht/web-ui WorkspacePatterns = %v, want nil", pkgs[1].WorkspacePatterns)
	}

	// Dependency key order preserved (manifest order, not alphabetical).
	wantDeps := []string{"zeta-dep", "alpha-dep", "middle-dep"}
	if !reflect.DeepEqual(pkgs[1].Dependencies, wantDeps) {
		t.Errorf("@draht/web-ui Dependencies = %v, want %v", pkgs[1].Dependencies, wantDeps)
	}
	wantWorkspaceDeps := []string{"middle-dep"}
	if !reflect.DeepEqual(pkgs[1].WorkspaceDeps, wantWorkspaceDeps) {
		t.Errorf("@draht/web-ui WorkspaceDeps = %v, want %v", pkgs[1].WorkspaceDeps, wantWorkspaceDeps)
	}

	// ExportLeaves in Object.values() document order, including "./package.json".
	wantLeaves := []string{"./dist/index.d.ts", "./dist/index.js", "./package.json"}
	if !reflect.DeepEqual(pkgs[1].ExportLeaves, wantLeaves) {
		t.Errorf("@draht/web-ui ExportLeaves = %v, want %v", pkgs[1].ExportLeaves, wantLeaves)
	}

	// The load-bearing assertion: the nested example's own source file
	// attributes to the PARENT package, not to itself.
	pkg, ok := PackageForRel(pkgs, "packages/web-ui/example/src/main.ts")
	if !ok {
		t.Fatal("PackageForRel: not found")
	}
	if pkg.Name != "@draht/web-ui" {
		t.Errorf("PackageForRel(nested example file) = %q, want %q", pkg.Name, "@draht/web-ui")
	}

	// A root-level file (no package prefix match) attributes to the root
	// package, since pkgs[0].Path == ".".
	rootPkg, ok := PackageForRel(pkgs, "scripts/build.ts")
	if !ok || rootPkg.Name != "draht-monorepo" {
		t.Errorf("PackageForRel(root-level file) = (%+v, %v), want draht-monorepo/true", rootPkg, ok)
	}
}

func TestPackageForRel_NoRootNoMatch(t *testing.T) {
	pkgs := []Package{{Name: "only-pkg", Path: "libs/only"}}
	_, ok := PackageForRel(pkgs, "unrelated/file.ts")
	if ok {
		t.Error("PackageForRel matched with no root package and no prefix hit, want false")
	}
}
