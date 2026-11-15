package graph

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// buildFixtureMap writes files under root (plus a .git marker and a default
// package.json) and runs the full regex-parser pipeline over them.
func buildFixtureMap(t *testing.T, root string, files map[string]string) *model.Map {
	t.Helper()
	files[".git/HEAD"] = "ref: refs/heads/main\n"
	if _, ok := files["package.json"]; !ok {
		files["package.json"] = `{"name":"fx","version":"1.0.0"}`
	}
	for rel, text := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m, _, err := Build(context.Background(), Options{
		Root:     root,
		OutDir:   t.TempDir(),
		CacheDir: t.TempDir(),
		Parser:   parse.NewRegex(),
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return m
}

func findExport(m *model.Map, id, name string) *model.Export {
	for i := range m.Modules {
		if m.Modules[i].ID != id {
			continue
		}
		for j := range m.Modules[i].Exports {
			if m.Modules[i].Exports[j].Name == name {
				return &m.Modules[i].Exports[j]
			}
		}
	}
	return nil
}

func exportNames(m *model.Map, id string) []string {
	for i := range m.Modules {
		if m.Modules[i].ID == id {
			names := make([]string, 0, len(m.Modules[i].Exports))
			for _, e := range m.Modules[i].Exports {
				names = append(names, e.Name)
			}
			return names
		}
	}
	return nil
}

// TestResolveReExports_DiamondDoesNotDependOnFileNames: b stars two different
// bindings of s (l via c, and m), so s is ambiguous at b; per ES ResolveExport
// ambiguity propagates, so a barrel starring b does not export s either, even
// though it also stars the definer l. The answer must not change when the same
// graph is laid out under other file names (the old fixpoint sorted barrel ids
// and kept or dropped s depending on where they fell).
func TestResolveReExports_DiamondDoesNotDependOnFileNames(t *testing.T) {
	dag := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/a.ts": "export * from \"./b\";\nexport * from \"./l\";\n",
		"src/b.ts": "export * from \"./c\";\nexport * from \"./m\";\n",
		"src/c.ts": "export * from \"./l\";\n",
		"src/l.ts": "export const s = 1;\n",
		"src/m.ts": "export const s = 2;\n",
	})
	// dag3: the same shape with the barrels renamed so they sort the other way.
	dag3 := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/a.ts": "export * from \"./l\";\n",
		"src/b.ts": "export * from \"./a\";\nexport * from \"./m\";\n",
		"src/l.ts": "export const s = 1;\n",
		"src/m.ts": "export const s = 2;\n",
		"src/z.ts": "export * from \"./b\";\nexport * from \"./l\";\n",
	})
	for _, tc := range []struct {
		name      string
		m         *model.Map
		exporters []string // barrels that must export s via l.ts
		ambiguous []string // barrels where s is ambiguous (directly or by propagation)
	}{
		{"dag", dag, []string{"src/c.ts"}, []string{"src/a.ts", "src/b.ts"}},
		{"dag3", dag3, []string{"src/a.ts"}, []string{"src/b.ts", "src/z.ts"}},
	} {
		for _, id := range tc.exporters {
			e := findExport(tc.m, id, "s")
			if e == nil || e.Via != "src/l.ts" {
				t.Errorf("%s: %s s = %+v, want an export via src/l.ts", tc.name, id, e)
			}
		}
		for _, id := range tc.ambiguous {
			if e := findExport(tc.m, id, "s"); e != nil {
				t.Errorf("%s: ambiguous s kept by %s: %+v", tc.name, id, e)
			}
		}
	}
}

// TestResolveReExports_CycleKeepsNoStaleNames: a and b star each other, so they
// only see what enters the cycle from outside. z (starred by b) has x
// ambiguous between c and d, so neither a nor b may export x.
func TestResolveReExports_CycleKeepsNoStaleNames(t *testing.T) {
	m := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/a.ts": "export * from \"./b\";\n",
		"src/b.ts": "export * from \"./a\";\nexport * from \"./z\";\n",
		"src/c.ts": "export const x = 1;\n",
		"src/d.ts": "export const x = 2;\n",
		"src/e.ts": "export * from \"./f\";\n",
		"src/f.ts": "export * from \"./d\";\n",
		"src/z.ts": "export * from \"./c\";\nexport * from \"./e\";\n",
	})
	for _, id := range []string{"src/a.ts", "src/b.ts", "src/z.ts"} {
		if e := findExport(m, id, "x"); e != nil {
			t.Errorf("%s keeps ambiguous x: %+v", id, e)
		}
	}
	for _, id := range []string{"src/e.ts", "src/f.ts"} {
		if e := findExport(m, id, "x"); e == nil || e.Via != "src/d.ts" {
			t.Errorf("%s x = %+v, want an export via src/d.ts", id, e)
		}
	}
	// A cycle with an unambiguous way in: both members export the entering name.
	m2 := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/a.ts": "export * from \"./b\";\n",
		"src/b.ts": "export * from \"./a\";\nexport * from \"./c\";\n",
		"src/c.ts": "export const x = 1;\n",
	})
	for _, id := range []string{"src/a.ts", "src/b.ts"} {
		if e := findExport(m2, id, "x"); e == nil || e.Via != "src/c.ts" {
			t.Errorf("%s x = %+v, want an export via src/c.ts", id, e)
		}
	}
}

// TestResolveReExports_TypeOnlyReExportKeepsOrigin: `export type { Foo } from`
// is a named re-export, so its origin is the definer (not the barrel a.ts) and
// the index starring both a and the definer does not see a clash.
func TestResolveReExports_TypeOnlyReExportKeepsOrigin(t *testing.T) {
	m := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/a.ts":     "export type { Foo } from \"./types\";\nexport { type Bar } from \"./types\";\nexport const aa = 1;\n",
		"src/index.ts": "export * from \"./a\";\nexport * from \"./types\";\n",
		"src/types.ts": "export interface Foo { a: number }\nexport interface Bar { b: number }\n",
	})
	for _, name := range []string{"Foo", "Bar"} {
		if e := findExport(m, "src/a.ts", name); e == nil || e.Via != "src/types.ts" {
			t.Errorf("a.ts %s = %+v, want a re-export via src/types.ts", name, e)
		}
		if e := findExport(m, "src/index.ts", name); e == nil || e.Via != "src/types.ts" {
			t.Errorf("index.ts %s = %+v, want an export via src/types.ts (dropped as a clash?)", name, e)
		}
	}
}

// TestResolveReExports_CapIsAppliedAfterResolution: names dropped as ambiguous
// do not use up slots of the 60-per-module cap.
func TestResolveReExports_CapIsAppliedAfterResolution(t *testing.T) {
	var x, y strings.Builder
	x.WriteString("export const amb = 1;\n")
	y.WriteString("export const amb = 2;\n")
	for i := 1; i <= 59; i++ {
		fmt.Fprintf(&x, "export const a%d = %d;\n", i, i)
	}
	m := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/x.ts":      x.String(),
		"src/y.ts":      y.String(),
		"src/barrel.ts": "export * from \"./x\";\nexport * from \"./y\";\n",
	})
	names := exportNames(m, "src/barrel.ts")
	if len(names) != 59 {
		t.Fatalf("barrel exports %d names, want 59 (a1..a59, amb dropped): %v", len(names), names)
	}
	if findExport(m, "src/barrel.ts", "amb") != nil {
		t.Errorf("ambiguous amb kept")
	}
}

// TestBuild_SymbolIndexSkipsReExports: the 5000-entry symbolIndex must spend
// its slots on definitions; barrel/star copies of a name are indexed once, at
// the defining module.
func TestBuild_SymbolIndexSkipsReExports(t *testing.T) {
	m := buildFixtureMap(t, t.TempDir(), map[string]string{
		"src/def.ts":    "export const realThing = 1;\n",
		"src/barrel.ts": "export * from \"./def\";\nexport { realThing as alias } from \"./def\";\n",
	})
	var files []string
	for _, e := range m.SymbolIndex {
		if e.Name == "realThing" || e.Name == "alias" {
			files = append(files, e.Name+"@"+e.File)
		}
	}
	if len(files) != 1 || files[0] != "realThing@src/def.ts" {
		t.Errorf("symbolIndex entries for realThing/alias = %v, want only realThing@src/def.ts", files)
	}
}
