package graph

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/parse"
)

// TestExpandStarReExports_NamedReExportSharesOrigin mirrors the CJS test
// "a binding reached directly and through a named re-export is not
// ambiguous": a star barrel reaching one definition both directly and
// through `export { foo } from` keeps the name, with Via = the defining
// module, also when the named re-export's target only gains the name from
// its own (later-sorted) star expansion; the named entry itself then names
// the defining module too. A named re-export of a module with no extracted
// exports (CommonJS) still reaches the barrel, with the CommonJS module as
// origin.
func TestExpandStarReExports_NamedReExportSharesOrigin(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		".git/HEAD":      "ref: refs/heads/main\n",
		"package.json":   `{"name":"named","version":"1.0.0"}`,
		"src/xdef.ts":    "export function sharedFoo() { return 1; }\n",
		"src/xnamed.ts":  "export { sharedFoo } from \"./xdef.js\";\n",
		"src/xbarrel.ts": "export * from \"./xdef.js\";\nexport * from \"./xnamed.js\";\n",
		"src/ystar.ts":   "export * from \"./xdef.js\";\n",
		"src/ynamed.ts":  "export { sharedFoo } from \"./ystar.js\";\n",
		"src/ybarrel.ts": "export * from \"./xdef.js\";\nexport * from \"./ynamed.js\";\n",
		"src/zcjs.js":    "module.exports = { legacy() { return 1; } };\n",
		"src/znamed.ts":  "export { legacy } from \"./zcjs.js\";\n",
		"src/zbarrel.ts": "export * from \"./znamed.js\";\n",
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
	export := func(id, name string) *model.Export {
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
	for _, barrel := range []string{"src/xbarrel.ts", "src/ybarrel.ts"} {
		e := export(barrel, "sharedFoo")
		if e == nil {
			t.Fatalf("%s dropped sharedFoo as ambiguous", barrel)
		}
		if e.Via != "src/xdef.ts" {
			t.Errorf("%s sharedFoo via = %q, want src/xdef.ts", barrel, e.Via)
		}
	}
	if e := export("src/ynamed.ts", "sharedFoo"); e == nil || e.Via != "src/xdef.ts" {
		t.Errorf("ynamed sharedFoo = %+v, want Via src/xdef.ts", e)
	}
	legacy := export("src/zbarrel.ts", "legacy")
	if legacy == nil {
		t.Fatal("named re-export of an unextracted module lost from the star barrel")
	}
	if legacy.Via != "src/zcjs.js" {
		t.Errorf("legacy via = %q, want src/zcjs.js", legacy.Via)
	}
	if e := export("src/znamed.ts", "legacy"); e == nil || e.Via != "src/zcjs.js" {
		t.Errorf("znamed legacy = %+v, want Via src/zcjs.js", e)
	}
}
