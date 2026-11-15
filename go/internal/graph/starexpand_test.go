package graph

import (
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// TestResolveReExports_NamedReExportSharesOrigin mirrors the CJS test
// "a binding reached directly and through a named re-export is not
// ambiguous": a star barrel reaching one definition both directly and
// through `export { foo } from` keeps the name, with Via = the defining
// module, also when the named re-export's target only gains the name from
// its own (later-sorted) star expansion; the named entry itself then names
// the defining module too. A named re-export of a module with no extracted
// exports (CommonJS) still reaches the barrel, with the CommonJS module as
// origin.
func TestResolveReExports_NamedReExportSharesOrigin(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
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
	m := buildFixtureMap(t, root, files)
	export := func(id, name string) *model.Export { return findExport(m, id, name) }
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
