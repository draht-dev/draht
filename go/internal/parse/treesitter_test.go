package parse

import (
	"context"
	"testing"
)

// wantImport is the subset of Import fields a table test cares about; Line
// and Offset are intentionally not asserted here (they're exercised by the
// determinism/ordering behaviour instead).
type wantImport struct {
	kind      Kind
	specifier string
	def       string
	namespace string
	names     []Name
}

func newTS(t *testing.T, langs ...Lang) Parser {
	t.Helper()
	p, err := NewTreeSitter(langs)
	if err != nil {
		t.Fatalf("NewTreeSitter(%v): %v", langs, err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p
}

func extract(t *testing.T, p Parser, lang Lang, path, src string) Result {
	t.Helper()
	res, err := p.Extract(context.Background(), lang, path, []byte(src))
	if err != nil {
		t.Fatalf("Extract(%s, %s): %v", lang, path, err)
	}
	return res
}

func assertImports(t *testing.T, got []Import, want []wantImport) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len(imports) = %d, want %d\ngot:  %+v\nwant: %+v", len(got), len(want), got, want)
	}
	for i, w := range want {
		g := got[i]
		if g.Kind != w.kind {
			t.Errorf("imports[%d].Kind = %q, want %q (specifier %q)", i, g.Kind, w.kind, g.Specifier)
		}
		if g.Specifier != w.specifier {
			t.Errorf("imports[%d].Specifier = %q, want %q", i, g.Specifier, w.specifier)
		}
		if g.Default != w.def {
			t.Errorf("imports[%d].Default = %q, want %q", i, g.Default, w.def)
		}
		if g.Namespace != w.namespace {
			t.Errorf("imports[%d].Namespace = %q, want %q", i, g.Namespace, w.namespace)
		}
		if len(w.names) > 0 {
			if len(g.Names) != len(w.names) {
				t.Errorf("imports[%d].Names = %+v, want %+v", i, g.Names, w.names)
			} else {
				for j, wn := range w.names {
					if g.Names[j] != wn {
						t.Errorf("imports[%d].Names[%d] = %+v, want %+v", i, j, g.Names[j], wn)
					}
				}
			}
		}
	}
}

func TestTreeSitter_Supports(t *testing.T) {
	p := newTS(t, "typescript", "python")
	if !p.Supports("typescript") {
		t.Error("Supports(typescript) = false, want true")
	}
	if !p.Supports("python") {
		t.Error("Supports(python) = false, want true")
	}
	if p.Supports("rust") {
		t.Error("Supports(rust) = true, want false (not requested)")
	}
	if p.Supports("nonsense-lang") {
		t.Error("Supports(nonsense-lang) = true, want false")
	}
}

func TestTreeSitter_TypeScriptAndTSX(t *testing.T) {
	p := newTS(t, "typescript")

	src := `import Foo, { a, b as c } from "./types";
import * as NS from "./ns";
import "./side-effect";
const req = require("./cjs-mod");
const dyn = import("./dynamic-mod");
export { d, e as f } from "./reexport";
export * as ns2 from "./star-ns";
`
	res := extract(t, p, "typescript", "sample.ts", src)
	if res.Degraded {
		t.Errorf("Degraded = true, want false")
	}
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "./types", def: "Foo", names: []Name{{Imported: "a"}, {Imported: "b", Local: "c"}}},
		{kind: KindImport, specifier: "./ns", namespace: "NS"},
		{kind: KindImport, specifier: "./side-effect"},
		{kind: KindRequire, specifier: "./cjs-mod"},
		{kind: KindDynamic, specifier: "./dynamic-mod"},
		{kind: KindReExport, specifier: "./reexport", names: []Name{{Imported: "d"}, {Imported: "e", Local: "f"}}},
		{kind: KindReExport, specifier: "./star-ns", namespace: "ns2"},
	})

	// .tsx path routes to the tsx grammar (grammarFor), and must extract
	// identically for a plain import inside a JSX file.
	tsxSrc := `import React from "react";
export const App = () => <div>{React.version}</div>;
`
	res = extract(t, p, "typescript", "component.tsx", tsxSrc)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "react", def: "React"},
	})
}

func TestTreeSitter_JavaScript(t *testing.T) {
	p := newTS(t, "javascript")
	src := `import { readFile } from "node:fs";
export * from "./barrel";
`
	res := extract(t, p, "javascript", "index.js", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "node:fs", names: []Name{{Imported: "readFile"}}},
		{kind: KindReExport, specifier: "./barrel", namespace: "*"},
	})
}

func TestTreeSitter_Python(t *testing.T) {
	p := newTS(t, "python")
	src := `import os.path as osp
import a.b, c
from ..pkg.mod import thing
from . import sibling
from utils import helper as h
from utils import *
`
	res := extract(t, p, "python", "sample.py", src)
	if res.Degraded {
		t.Errorf("Degraded = true, want false")
	}
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "os.path", names: []Name{{Imported: "path", Local: "osp"}}},
		{kind: KindImport, specifier: "a.b"},
		{kind: KindImport, specifier: "c"},
		{kind: KindImport, specifier: "..pkg.mod", names: []Name{{Imported: "thing"}}},
		{kind: KindImport, specifier: ".", names: []Name{{Imported: "sibling"}}},
		{kind: KindImport, specifier: "utils", names: []Name{{Imported: "helper", Local: "h"}}},
		{kind: KindImport, specifier: "utils", namespace: "*"},
	})
}

func TestTreeSitter_Go(t *testing.T) {
	p := newTS(t, "go")
	src := `package main

import (
	"fmt"
	_ "embed"
	. "strings"
	al "path/filepath"
)
`
	res := extract(t, p, "go", "main.go", src)
	if res.Degraded {
		t.Errorf("Degraded = true, want false")
	}
	// Regression test for the Go import-anchoring bug the spike found: a
	// 4-entry `import ( ... )` block must yield 4 records, not 1.
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "fmt"},
		{kind: KindImport, specifier: "embed", def: "_"},
		{kind: KindImport, specifier: "strings", def: "."},
		{kind: KindImport, specifier: "path/filepath", def: "al"},
	})
}

func TestTreeSitter_Rust(t *testing.T) {
	p := newTS(t, "rust")
	src := `use std::sync::{Arc, Mutex};
use serde::Serialize as Ser;
use std::collections::HashMap as Map;
use foo::*;
extern crate serde_json;
mod utils;
`
	res := extract(t, p, "rust", "lib.rs", src)
	if res.Degraded {
		t.Errorf("Degraded = true, want false")
	}
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "std::sync", names: []Name{{Imported: "Arc"}, {Imported: "Mutex"}}},
		{kind: KindImport, specifier: "serde::Serialize", names: []Name{{Imported: "Serialize", Local: "Ser"}}},
		{kind: KindImport, specifier: "std::collections::HashMap", names: []Name{{Imported: "HashMap", Local: "Map"}}},
		{kind: KindImport, specifier: "foo", namespace: "*"},
		{kind: KindImport, specifier: "serde_json"},
		{kind: KindImport, specifier: "utils"},
	})
}

func TestTreeSitter_Java(t *testing.T) {
	p := newTS(t, "java")
	src := `import java.util.List;
import static java.lang.Math.PI;
import com.foo.bar.*;
`
	res := extract(t, p, "java", "Sample.java", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "java.util.List"},
		{kind: KindImport, specifier: "java.lang.Math.PI"},
		{kind: KindImport, specifier: "com.foo.bar", namespace: "*"},
	})
}

func TestTreeSitter_Kotlin(t *testing.T) {
	p := newTS(t, "kotlin")
	src := `import kotlin.collections.List
import com.foo.Bar as Baz
import com.foo.*
`
	res := extract(t, p, "kotlin", "Sample.kt", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "kotlin.collections.List"},
		{kind: KindImport, specifier: "com.foo.Bar", names: []Name{{Imported: "Bar", Local: "Baz"}}},
		{kind: KindImport, specifier: "com.foo", namespace: "*"},
	})
}

func TestTreeSitter_Swift(t *testing.T) {
	p := newTS(t, "swift")
	src := `import Foundation
import class Foo.Bar
@testable import MyModule
`
	res := extract(t, p, "swift", "Sample.swift", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "Foundation"},
		{kind: KindImport, specifier: "Foo.Bar"},
		{kind: KindImport, specifier: "MyModule"},
	})
}

func TestTreeSitter_Ruby(t *testing.T) {
	p := newTS(t, "ruby")
	src := "require \"json\"\nrequire_relative \"./lib/foo\"\nrequire 'net/http'\n"
	res := extract(t, p, "ruby", "sample.rb", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindRequire, specifier: "json"},
		{kind: KindRequire, specifier: "./lib/foo"},
		{kind: KindRequire, specifier: "net/http"},
	})
}

func TestTreeSitter_PHP(t *testing.T) {
	p := newTS(t, "php")
	src := "<?php\n" +
		"require 'foo.php';\n" +
		"require_once \"bar.php\";\n" +
		"include('baz.php');\n" +
		`use App\Models\User;` + "\n" +
		`use App\Models\Post as P;` + "\n"
	res := extract(t, p, "php", "sample.php", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindRequire, specifier: "foo.php"},
		{kind: KindRequire, specifier: "bar.php"},
		{kind: KindRequire, specifier: "baz.php"},
		{kind: KindImport, specifier: `App\Models\User`},
		{kind: KindImport, specifier: `App\Models\Post`, names: []Name{{Imported: "Post", Local: "P"}}},
	})
}

func TestTreeSitter_CSharp(t *testing.T) {
	p := newTS(t, "csharp")
	src := `using System;
using System.Collections.Generic;
using Foo = System.Bar;
`
	res := extract(t, p, "csharp", "Sample.cs", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "System"},
		{kind: KindImport, specifier: "System.Collections.Generic"},
		{kind: KindImport, specifier: "System.Bar", names: []Name{{Imported: "Bar", Local: "Foo"}}},
	})
}

func TestTreeSitter_C(t *testing.T) {
	p := newTS(t, "c")
	src := "#include <stdio.h>\n#include \"myheader.h\"\n"
	res := extract(t, p, "c", "sample.c", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "stdio.h"},
		{kind: KindImport, specifier: "myheader.h"},
	})
}

func TestTreeSitter_Cpp(t *testing.T) {
	p := newTS(t, "cpp")
	src := "#include <vector>\n#include \"myheader.hpp\"\nimport foo.mod;\n"
	res := extract(t, p, "cpp", "sample.cpp", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindImport, specifier: "vector"},
		{kind: KindImport, specifier: "myheader.hpp"},
		{kind: KindImport, specifier: "foo.mod"},
	})
}

func TestTreeSitter_Shell(t *testing.T) {
	p := newTS(t, "shell")
	src := "#!/bin/bash\nsource ./lib.sh\n. ./other.sh\ncurl https://example.com\n"
	res := extract(t, p, "shell", "sample.sh", src)
	assertImports(t, res.Imports, []wantImport{
		{kind: KindRequire, specifier: "./lib.sh"},
		{kind: KindRequire, specifier: "./other.sh"},
	})
}

func TestTreeSitter_UnsupportedLangReturnsError(t *testing.T) {
	p := newTS(t, "typescript")
	_, err := p.Extract(context.Background(), "cobol", "x.cbl", []byte("nope"))
	if err == nil {
		t.Fatal("Extract(cobol) err = nil, want non-nil")
	}
}

func TestTreeSitter_MaxBytesSkipsParse(t *testing.T) {
	p, err := NewTreeSitter([]Lang{"typescript"}, WithMaxBytes(10))
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer p.Close()
	res := extract(t, p, "typescript", "big.ts", `import x from "y";`)
	if len(res.Imports) != 0 {
		t.Errorf("expected zero imports when file exceeds WithMaxBytes, got %+v", res.Imports)
	}
}

func TestTreeSitter_DoesNotPanicOnGarbage(t *testing.T) {
	p := newTS(t, "typescript", "python", "go", "rust", "java", "c", "cpp")
	garbage := [][2]string{
		{"typescript", "\x00\x01\xff{{{{ import from"},
		{"python", "def f(:\n  import\n"},
		{"go", "package (((("},
		{"c", "#include <<<>>"},
	}
	for _, g := range garbage {
		res, err := p.Extract(context.Background(), Lang(g[0]), "x", []byte(g[1]))
		// A parse error, or a degraded-but-successful result, are both fine —
		// the only forbidden outcome is a panic escaping this call.
		_ = res
		_ = err
	}
}
