package cache

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkLoad measures the warm-path cost of reading and parsing a
// synthesized ~1,400-entry NDJSON cache file, approximating the ~5 MB
// reference-repo cache. This pins the budget the design calls out (a
// parallel NDJSON decode on the order of tens of milliseconds), separate
// from the cost of building the Snapshot's map or re-extracting anything.
func BenchmarkLoad(b *testing.B) {
	dir := b.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	seed := NewSnapshot()
	// A representative extract.Facts-shaped payload (cache is byte-oriented
	// and does not import extract, so this is just a plausible JSON blob of
	// roughly the right size).
	payload := []byte(`{"loc":812,"imp":[{"k":"import","s":"./models","ln":1,"o":0},{"k":"import","s":"./auth/types","ln":2,"o":40}],"exp":[{"name":"Foo","kind":"function","line":1,"doc":null},{"name":"Bar","kind":"const","line":10,"doc":"a doc comment describing Bar in some detail for benchmark realism"}],"sym":[{"name":"Foo","kind":"function","line":1,"exported":true},{"name":"helper","kind":"function","line":30,"exported":false}],"snk":["fs:read"],"rt":[{"method":"GET","path":"/foo"}]}`)

	const numEntries = 1400
	for i := 0; i < numEntries; i++ {
		path := fmt.Sprintf("packages/pkg%d/src/file%d.ts", i%40, i)
		hash := fmt.Sprintf("%064x", i)
		seed.Put(Key{Path: path, ContentHash: hash, Version: "f1|pts/3+gotreesitter@v0.47.1|xx1"}, payload)
	}
	if err := store.Commit(ctx, seed); err != nil {
		b.Fatalf("seed Commit: %v", err)
	}

	if info, err := os.Stat(filepath.Join(dir, cacheFileName)); err == nil {
		b.Logf("synthesized cache file: %d entries, %d bytes", numEntries, info.Size())
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		snap, err := store.Load(ctx)
		if err != nil {
			b.Fatalf("Load: %v", err)
		}
		if got := snap.Stats().Entries; got != numEntries {
			b.Fatalf("Load produced %d entries, want %d", got, numEntries)
		}
	}
}
