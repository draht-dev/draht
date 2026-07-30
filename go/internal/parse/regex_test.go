package parse

import (
	"context"
	"testing"
)

func regexExtract(t *testing.T, lang Lang, src string) Result {
	t.Helper()
	p := NewRegex()
	res, err := p.Extract(context.Background(), lang, "x", []byte(src))
	if err != nil {
		t.Fatalf("Extract(%s): %v", lang, err)
	}
	return res
}

func TestRegex_Supports(t *testing.T) {
	p := NewRegex()
	for _, l := range []Lang{"typescript", "javascript", "python", "go", "rust"} {
		if !p.Supports(l) {
			t.Errorf("Supports(%s) = false, want true", l)
		}
	}
	for _, l := range []Lang{"java", "kotlin", "swift", "ruby", "php", "csharp", "c", "cpp", "shell"} {
		if p.Supports(l) {
			t.Errorf("Supports(%s) = true, want false (regex parser has no rules for it)", l)
		}
	}
}

func TestRegex_TypeScript(t *testing.T) {
	src := `import Foo, { a, b as c } from "./types";
import * as NS from "./ns";
const req = require("./cjs-mod");
const dyn = import("./dynamic-mod");
export { d, e as f } from "./reexport";
export * as ns2 from "./star-ns";
export * from "./star";
`
	res := regexExtract(t, "typescript", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "./types", def: "Foo", names: []Name{{Imported: "a"}, {Imported: "b", Local: "c"}}},
		{kind: KindImport, specifier: "./ns", namespace: "NS"},
		{kind: KindRequire, specifier: "./cjs-mod"},
		{kind: KindDynamic, specifier: "./dynamic-mod"},
		{kind: KindReExport, specifier: "./reexport", names: []Name{{Imported: "d"}, {Imported: "e", Local: "f"}}},
		{kind: KindReExport, specifier: "./star-ns", namespace: "ns2"},
		{kind: KindReExport, specifier: "./star", namespace: "*"},
	})
}

// TestRegex_KnownCJSGaps documents behaviour that is a known, DELIBERATE
// divergence from the tree-sitter parser (design D1: the regex parser is a
// byte-parity oracle for the CJS engine, not a "fixed" implementation).
func TestRegex_KnownCJSGaps(t *testing.T) {
	// visParseImports has no pattern for a bare side-effect import — unlike
	// tree-sitter (see TestTreeSitter_TypeScriptAndTSX), this is silently
	// dropped by the regex port, exactly as CJS drops it.
	res := regexExtract(t, "typescript", `import "./side-effect";
import Real from "./real";
`)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "./real", def: "Real"},
	})

	// The block-comment strip is string-unaware: a "/*" inside a string
	// literal eats through to the next "*/", silently corrupting whatever
	// followed — verbatim CJS behaviour (draht-tools.cjs:2141-2144).
	res = regexExtract(t, "typescript", "const s = \"/*\";\nimport Real from \"./real\";\n*/\nimport Lost from \"./lost\";\n")
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "./lost", def: "Lost"},
	})
}

func TestRegex_JavaScriptRequireAndDynamicOrderInterleaved(t *testing.T) {
	// The combined require|import(...) regex is a SINGLE pass over the file
	// in CJS, so interleaved require()/import() calls must come out in their
	// original file order, not grouped by keyword.
	src := `const a = require("./a");
const b = import("./b");
const c = require("./c");
`
	res := regexExtract(t, "javascript", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindRequire, specifier: "./a"},
		{kind: KindDynamic, specifier: "./b"},
		{kind: KindRequire, specifier: "./c"},
	})
}

func TestRegex_Python(t *testing.T) {
	src := `import os.path as osp
from ..pkg.mod import thing
import a.b, c
`
	res := regexExtract(t, "python", src)
	// visExtractRawImports is specifier-only (no Default/Namespace/Names) and
	// its `\S+` capture stops at the first space, so `import a.b, c` yields
	// ONE record for "a.b," — NOT two records for "a.b" and "c" the way the
	// tree-sitter parser splits them. A documented, verbatim AST-vs-regex
	// divergence, not a bug to "fix" in the regex port.
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "os.path"},
		{kind: KindImport, specifier: "..pkg.mod"},
		{kind: KindImport, specifier: "a.b,"},
	})
}

func TestRegex_Go(t *testing.T) {
	src := `package main

import "fmt"

import (
	"os"
	"path/filepath"
)
`
	res := regexExtract(t, "go", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "fmt"},
		{kind: KindImport, specifier: "os"},
		{kind: KindImport, specifier: "path/filepath"},
	})
}

func TestRegex_Rust(t *testing.T) {
	src := "use std::sync::Arc;\nuse serde::Serialize;\n"
	res := regexExtract(t, "rust", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "std::sync::Arc"},
		{kind: KindImport, specifier: "serde::Serialize"},
	})
}

func TestRegex_UnsupportedLangIsEmpty(t *testing.T) {
	res := regexExtract(t, "java", "import java.util.List;")
	if len(res.Imports) != 0 {
		t.Errorf("expected zero imports for an unsupported lang, got %+v", res.Imports)
	}
}

func TestRegex_VersionAndClose(t *testing.T) {
	p := NewRegex()
	if p.Version() != "re/1" {
		t.Errorf("Version() = %q, want %q", p.Version(), "re/1")
	}
	if err := p.Close(); err != nil {
		t.Errorf("Close() = %v, want nil", err)
	}
}

func TestRegex_DoesNotPanicOnGarbage(t *testing.T) {
	p := NewRegex()
	for _, lang := range []Lang{"typescript", "javascript", "python", "go", "rust"} {
		_, err := p.Extract(context.Background(), lang, "x", []byte("\x00\x01{{{{ import from \"\n\n((((")) //nolint
		_ = err
	}
}
