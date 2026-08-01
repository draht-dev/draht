package graph

import (
	"reflect"
	"testing"

	"github.com/draht-dev/draht/go/internal/parse"
	"github.com/draht-dev/draht/go/internal/scan"
)

// newLangFixture builds a LangResolver over a synthetic repo. files is a list
// of repo-relative paths whose language is inferred from the extension, which
// keeps the table tests readable.
func newLangFixture(t *testing.T, files []string, goMods []GoModule) *LangResolver {
	t.Helper()
	mods := make([]scan.File, 0, len(files))
	paths := make([]string, 0, len(files))
	for _, f := range files {
		mods = append(mods, scan.File{Rel: f, Lang: scan.LangFor(f)})
		paths = append(paths, f)
	}
	return NewLangResolver(NewResolverIndex(paths, nil), mods, goMods)
}

func TestLangResolver_Python(t *testing.T) {
	files := []string{
		"src/pkg/__init__.py",
		"src/pkg/mod_a.py",
		"src/pkg/sub/__init__.py",
		"src/pkg/sub/deep.py",
		"src/toplevel.py",
		"standalone.py",
	}
	lr := newLangFixture(t, files, nil)

	tests := []struct {
		name    string
		spec    string
		fromDir string
		want    []string
	}{
		{"single dot names the package itself", ".", "src/pkg", []string{"src/pkg/__init__.py"}},
		{"sibling module via one dot", ".mod_a", "src/pkg", []string{"src/pkg/mod_a.py"}},
		{"subpackage via one dot", ".sub", "src/pkg", []string{"src/pkg/sub/__init__.py"}},
		{"parent package via two dots", "..mod_a", "src/pkg/sub", []string{"src/pkg/mod_a.py"}},
		{"dotted path under package root", "pkg.mod_a", "src/pkg", []string{"src/pkg/mod_a.py"}},
		{"nested dotted path", "pkg.sub.deep", "src/pkg", []string{"src/pkg/sub/deep.py"}},
		// src/ is a probed root, so a file directly under it resolves from
		// anywhere — the common "src layout" case.
		{"src-rooted absolute import", "toplevel", "src/pkg", []string{"src/toplevel.py"}},
		{"repo-root absolute import", "standalone", ".", []string{"standalone.py"}},
		{"unknown module yields no edge", "requests", "src/pkg", nil},
		{"unresolvable relative yields no edge", ".nope", "src/pkg", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := lr.Resolve(scan.LangPython, tt.spec, tt.fromDir)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Resolve(python, %q, %q) = %v, want %v", tt.spec, tt.fromDir, got, tt.want)
			}
		})
	}
}

// TestLangResolver_PythonSourceRootBeatsRepoRoot pins the sys.path rule: an
// absolute import inside a package resolves against the package root (the
// first ancestor without __init__.py), not against the repo root, so a name
// that exists in both places picks the nearer one.
func TestLangResolver_PythonSourceRootBeatsRepoRoot(t *testing.T) {
	lr := newLangFixture(t, []string{
		"app/__init__.py",
		"app/util.py",
		"util.py", // same module name at the repo root
	}, nil)

	// app/ has __init__.py, so the source root walking out of app/ is ".",
	// meaning "util" resolves to the repo-root util.py.
	if got := lr.Resolve(scan.LangPython, "util", "app"); !reflect.DeepEqual(got, []string{"util.py"}) {
		t.Errorf("got %v, want [util.py]", got)
	}
	// A relative import is unambiguous and must reach the package-local file.
	if got := lr.Resolve(scan.LangPython, ".util", "app"); !reflect.DeepEqual(got, []string{"app/util.py"}) {
		t.Errorf("got %v, want [app/util.py]", got)
	}
}

func TestLangResolver_Go(t *testing.T) {
	files := []string{
		"go/go.mod",
		"go/cmd/tool/main.go",
		"go/internal/scan/walk.go",
		"go/internal/scan/lang.go",
		"go/internal/scan/walk_test.go", // must never be an import target
		"other/go.mod",
		"other/pkg/thing.go",
	}
	mods := []GoModule{
		{Path: "example.com/proj/go", Dir: "go"},
		{Path: "example.com/other", Dir: "other"},
	}
	lr := newLangFixture(t, files, mods)

	tests := []struct {
		name string
		spec string
		want []string
	}{
		{
			name: "package import fans out to non-test files, sorted",
			spec: "example.com/proj/go/internal/scan",
			want: []string{"go/internal/scan/lang.go", "go/internal/scan/walk.go"},
		},
		{"single-file package", "example.com/proj/go/cmd/tool", []string{"go/cmd/tool/main.go"}},
		{"a second module in the same repo resolves too", "example.com/other/pkg", []string{"other/pkg/thing.go"}},
		{"stdlib is external", "fmt", nil},
		{"third-party is external", "github.com/pkg/errors", nil},
		{"in-module but unscanned package yields nothing", "example.com/proj/go/internal/nope", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := lr.Resolve(scan.LangGo, tt.spec, "go/cmd/tool")
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Resolve(go, %q) = %v, want %v", tt.spec, got, tt.want)
			}
		})
	}
}

// TestLangResolver_GoLongestModulePrefixWins guards the nested-module case: a
// repo containing both example.com/proj and example.com/proj/go must route an
// import into the deeper module, not the shallower one that also prefixes it.
func TestLangResolver_GoLongestModulePrefixWins(t *testing.T) {
	lr := newLangFixture(t, []string{
		"go.mod",
		"outer/thing.go",
		"go/go.mod",
		"go/inner/thing.go",
	}, []GoModule{
		{Path: "example.com/proj", Dir: "."},
		{Path: "example.com/proj/go", Dir: "go"},
	})

	got := lr.Resolve(scan.LangGo, "example.com/proj/go/inner", "outer")
	if !reflect.DeepEqual(got, []string{"go/inner/thing.go"}) {
		t.Errorf("nested module lost to its parent prefix: got %v, want [go/inner/thing.go]", got)
	}
}

func TestLangResolver_Rust(t *testing.T) {
	files := []string{
		"src/lib.rs",
		"src/config.rs",
		"src/net/mod.rs",
		"src/net/client.rs",
	}
	lr := newLangFixture(t, files, nil)

	tests := []struct {
		name    string
		spec    string
		fromDir string
		want    []string
	}{
		{"mod names a sibling file", "config", "src", []string{"src/config.rs"}},
		{"mod names a directory module", "net", "src", []string{"src/net/mod.rs"}},
		{"crate path from a submodule", "crate::config", "src/net", []string{"src/config.rs"}},
		{"crate path to a dir module", "crate::net", "src/net", []string{"src/net/mod.rs"}},
		{"self path", "self::client", "src/net", []string{"src/net/client.rs"}},
		{"super path", "super::config", "src/net", []string{"src/config.rs"}},
		// The trailing segment is a type, not a module: the longest module
		// prefix (crate::config) is what resolves.
		{"item inside a module resolves to the module", "crate::config::Settings", "src/net", []string{"src/config.rs"}},
		{"std is external", "std::sync", "src", nil},
		{"core is external", "core::mem", "src", nil},
		{"unknown crate is external", "serde::Serialize", "src", nil},
		{"item in current module is not a file edge", "crate::Missing", "src", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := lr.Resolve(scan.LangRust, tt.spec, tt.fromDir)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Resolve(rust, %q, %q) = %v, want %v", tt.spec, tt.fromDir, got, tt.want)
			}
		})
	}
}

func TestParseGoModulePath(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want string
	}{
		{"plain", "module example.com/x\n\ngo 1.26\n", "example.com/x"},
		{"leading whitespace", "  module   example.com/y\n", "example.com/y"},
		{"trailing comment", "module example.com/z // vanity\n", "example.com/z"},
		{"no module directive", "go 1.26\n", ""},
		{"empty", "", ""},
		// `module` inside a require block must not be mistaken for the
		// directive; the regex anchors to the line start.
		{"first directive wins", "module a.com/one\nmodule b.com/two\n", "a.com/one"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ParseGoModulePath([]byte(tt.src)); got != tt.want {
				t.Errorf("ParseGoModulePath(%q) = %q, want %q", tt.src, got, tt.want)
			}
		})
	}
}

// TestBuildLangEdges_Deterministic pins that the same input yields identical
// edges across runs — the Go package fan-out reads a map, which would
// otherwise leak iteration order into the output.
func TestBuildLangEdges_Deterministic(t *testing.T) {
	files := []string{"go/go.mod", "go/a/one.go", "go/a/two.go", "go/a/three.go", "go/b/main.go"}
	mods := []GoModule{{Path: "example.com/m", Dir: "go"}}

	mi := []LangModuleImports{{
		Path: "go/b/main.go",
		Lang: scan.LangGo,
		Imports: []parse.Import{
			{Kind: parse.KindImport, Specifier: "example.com/m/a"},
			{Kind: parse.KindImport, Specifier: "fmt"},
		},
	}}

	var first []string
	for run := 0; run < 20; run++ {
		lr := newLangFixture(t, files, mods)
		edges := BuildLangEdges(mi, lr)
		got := make([]string, len(edges))
		for i, e := range edges {
			got[i] = e.From + " -> " + e.To + " [" + string(e.Kind) + "]"
		}
		if run == 0 {
			first = got
			continue
		}
		if !reflect.DeepEqual(got, first) {
			t.Fatalf("run %d differs:\n got %v\nwant %v", run, got, first)
		}
	}

	// The fan-out must be sorted, and the unresolved stdlib import must still
	// surface as an external edge.
	want := []string{
		"go/b/main.go -> go/a/one.go [import]",
		"go/b/main.go -> go/a/three.go [import]",
		"go/b/main.go -> go/a/two.go [import]",
		"go/b/main.go -> fmt [external]",
	}
	if !reflect.DeepEqual(first, want) {
		t.Errorf("edges = %v, want %v", first, want)
	}
}

// TestBuildLangEdges_SkipsSelfEdge covers a file importing its own package
// (legal in Go for a file in the same directory as the target of a
// same-package import path): it must not produce a self-loop.
func TestBuildLangEdges_SkipsSelfEdge(t *testing.T) {
	lr := newLangFixture(t, []string{"go/go.mod", "go/a/one.go", "go/a/two.go"},
		[]GoModule{{Path: "example.com/m", Dir: "go"}})

	edges := BuildLangEdges([]LangModuleImports{{
		Path:    "go/a/one.go",
		Lang:    scan.LangGo,
		Imports: []parse.Import{{Kind: parse.KindImport, Specifier: "example.com/m/a"}},
	}}, lr)

	for _, e := range edges {
		if e.From == e.To {
			t.Fatalf("self-edge emitted: %s -> %s", e.From, e.To)
		}
	}
	if len(edges) != 1 || edges[0].To != "go/a/two.go" {
		t.Errorf("edges = %+v, want a single edge to go/a/two.go", edges)
	}
}
