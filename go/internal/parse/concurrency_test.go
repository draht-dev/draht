package parse

import (
	"context"
	"reflect"
	"sync"
	"testing"
)

// TestTreeSitter_ConcurrentExtractIsDeterministic is a determinism proxy for
// `go test -race`, which this sandbox cannot run (go build -race requires
// CGO_ENABLED=1, and no C compiler is present here — see go/README.md /
// design R6). It mirrors the gotreesitter spike's own verification approach:
// run many goroutines sharing one Parser concurrently and compare every
// result against a sequential reference, byte-for-byte (via reflect.DeepEqual
// over the decoded structs). This does not prove the ABSENCE of a data race,
// but a caught mismatch here would prove ONE exists; CI (which has a C
// toolchain) is expected to additionally run `go test -race ./...`.
func TestTreeSitter_ConcurrentExtractIsDeterministic(t *testing.T) {
	p, err := NewTreeSitter([]Lang{"typescript", "python", "go", "rust"})
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer p.Close()

	files := []struct {
		lang Lang
		path string
		src  string
	}{
		{"typescript", "a.ts", `import Foo, { a, b as c } from "./types";
import * as NS from "./ns";
export { d } from "./reexport";
`},
		{"python", "b.py", `import os.path as osp
from ..pkg.mod import thing
from utils import *
`},
		{"go", "c.go", `package main

import (
	"fmt"
	_ "embed"
	al "path/filepath"
)
`},
		{"rust", "d.rs", `use std::sync::{Arc, Mutex};
use serde::Serialize as Ser;
`},
	}

	want := make([]Result, len(files))
	for i, f := range files {
		res, err := p.Extract(context.Background(), f.lang, f.path, []byte(f.src))
		if err != nil {
			t.Fatalf("sequential Extract(%s): %v", f.path, err)
		}
		want[i] = res
	}

	const workers = 8
	const rounds = 20
	for round := 0; round < rounds; round++ {
		var wg sync.WaitGroup
		errs := make(chan string, workers*len(files))
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i, f := range files {
					got, err := p.Extract(context.Background(), f.lang, f.path, []byte(f.src))
					if err != nil {
						errs <- err.Error()
						continue
					}
					if !reflect.DeepEqual(got, want[i]) {
						errs <- "mismatch for " + f.path
					}
				}
			}()
		}
		wg.Wait()
		close(errs)
		for e := range errs {
			t.Errorf("round %d: %s", round, e)
		}
	}
}
