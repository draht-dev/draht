package parse

import (
	"context"
	"fmt"
	"testing"
)

// TestDifferential_TreeSitterVsRegex runs both implementations over a small
// shared corpus and reports (via t.Log, not assertions) how their extracted
// specifier sets differ. The tree-sitter side is expected to find MORE
// imports than the regex side (bare side-effect imports, imports inside
// re-exported namespaces, etc.) — this is a categorized report for humans
// reviewing the swap seam, not a gate: only a hard panic or error would fail
// it. See design G6 for the full parity/diff-report gate this feeds into at
// the graph-pipeline level.
func TestDifferential_TreeSitterVsRegex(t *testing.T) {
	corpus := []struct {
		lang Lang
		path string
		src  string
	}{
		{"typescript", "a.ts", `import Foo from "./foo";
import "./side-effect";
export * from "./barrel";
const x = require("./cjs");
`},
		{"javascript", "b.js", `import { a } from "./a";
module.exports = require("./b");
`},
		{"python", "c.py", `import os
from . import sibling
import a.b, c
`},
		{"go", "d.go", `package main

import (
	"fmt"
	_ "embed"
)
`},
		{"rust", "e.rs", `use std::sync::{Arc, Mutex};
use serde::Serialize;
`},
	}

	ts, err := NewTreeSitter([]Lang{"typescript", "javascript", "python", "go", "rust"})
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer ts.Close()
	re := NewRegex()
	defer re.Close()

	for _, c := range corpus {
		tsRes, err := ts.Extract(context.Background(), c.lang, c.path, []byte(c.src))
		if err != nil {
			t.Errorf("treesitter Extract(%s): %v", c.path, err)
			continue
		}
		reRes, err := re.Extract(context.Background(), c.lang, c.path, []byte(c.src))
		if err != nil {
			t.Errorf("regex Extract(%s): %v", c.path, err)
			continue
		}

		tsSet := specifierSet(tsRes.Imports)
		reSet := specifierSet(reRes.Imports)

		var onlyTS, onlyRE []string
		for s := range tsSet {
			if !reSet[s] {
				onlyTS = append(onlyTS, s)
			}
		}
		for s := range reSet {
			if !tsSet[s] {
				onlyRE = append(onlyRE, s)
			}
		}
		t.Logf("%s: treesitter=%d regex=%d only-in-treesitter=%v only-in-regex=%v",
			c.path, len(tsRes.Imports), len(reRes.Imports), onlyTS, onlyRE)
	}
}

func specifierSet(imports []Import) map[string]bool {
	out := make(map[string]bool, len(imports))
	for _, im := range imports {
		out[fmt.Sprintf("%s|%s", im.Kind, im.Specifier)] = true
	}
	return out
}
