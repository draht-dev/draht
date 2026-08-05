package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func commitFixtureSize(t *testing.T, limit int64, payloadBytes int) (Store, *Snapshot) {
	t.Helper()
	dir := t.TempDir()
	store := &fileStore{dir: dir, maxFileBytes: limit}
	snap := NewSnapshot()
	payload := append([]byte{'"'}, bytes.Repeat([]byte{'x'}, payloadBytes)...)
	payload = append(payload, '"')
	if !json.Valid(payload) {
		t.Fatal("test payload is not valid JSON")
	}
	snap.Put(Key{Path: "a.go", ContentHash: "h", Version: "v"}, payload)
	return store, snap
}

func TestFileStoreCommitUsesPrivatePermissions(t *testing.T) {
	store, snap := commitFixtureSize(t, 1<<20, 32)
	if err := store.Commit(context.Background(), snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	info, err := os.Stat(store.(*fileStore).path())
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("cache mode = %04o, want 0600", got)
	}
}

func TestFileStoreCommitHonorsExactWriterBoundary(t *testing.T) {
	probe, snap := commitFixtureSize(t, 1<<20, 32)
	if err := probe.Commit(context.Background(), snap); err != nil {
		t.Fatalf("probe Commit: %v", err)
	}
	info, err := os.Stat(probe.(*fileStore).path())
	if err != nil {
		t.Fatalf("stat probe cache: %v", err)
	}

	store, boundarySnap := commitFixtureSize(t, info.Size(), 32)
	if err := store.Commit(context.Background(), boundarySnap); err != nil {
		t.Fatalf("Commit at exact boundary: %v", err)
	}
	got, err := os.Stat(store.(*fileStore).path())
	if err != nil {
		t.Fatalf("stat boundary cache: %v", err)
	}
	if got.Size() != info.Size() {
		t.Fatalf("boundary cache size = %d, want %d", got.Size(), info.Size())
	}
}

func TestFileStoreOversizeCommitSkipsCacheAndLeavesColdState(t *testing.T) {
	store, snap := commitFixtureSize(t, 128, 256)
	fs := store.(*fileStore)
	fs.maxFileBytes = 1 << 20
	seed := NewSnapshot()
	seed.Put(Key{Path: "old.go", ContentHash: "old", Version: "v"}, []byte(`{"loc":1}`))
	if err := store.Commit(context.Background(), seed); err != nil {
		t.Fatalf("seed Commit: %v", err)
	}
	fs.maxFileBytes = 128

	err := store.Commit(context.Background(), snap)
	if err == nil {
		t.Fatal("oversize Commit returned nil error")
	}
	if _, statErr := os.Stat(fs.path()); !os.IsNotExist(statErr) {
		t.Fatalf("oversize Commit left facts.ndjson behind; stat error = %v", statErr)
	}
	loaded, loadErr := store.Load(context.Background())
	if loadErr != nil {
		t.Fatalf("cold Load after skipped Commit: %v", loadErr)
	}
	if loaded.Stats().Entries != 0 {
		t.Fatalf("cold Load entries = %d, want 0", loaded.Stats().Entries)
	}
}

func TestFileStoreCommittedOutputIsLoadableByReader(t *testing.T) {
	store := NewFileStore(t.TempDir())
	snap := NewSnapshot()
	key := Key{Path: "loadable.go", ContentHash: "hash", Version: "version"}
	snap.Put(key, []byte(`{"loc":7}`))
	if err := store.Commit(context.Background(), snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	loaded, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load committed output: %v", err)
	}
	if _, ok := loaded.Get(key); !ok {
		t.Fatal("reader rejected or lost committed cache entry")
	}
}

func TestFileStoreCommitRejectsEntriesAboveReaderLineLimitBeforePublication(t *testing.T) {
	dir := t.TempDir()
	store := &fileStore{dir: dir, maxLines: 3, maxLineBytes: 1024, maxFileBytes: 1 << 20}
	snap := NewSnapshot()
	for i := range 3 {
		path := fmt.Sprintf("%d.go", i)
		snap.Put(Key{Path: path, ContentHash: "hash", Version: "version"}, []byte(`{"loc":1}`))
	}
	if err := store.Commit(context.Background(), snap); err == nil {
		t.Fatal("Commit above reader line-count limit returned nil error")
	}
	if _, err := os.Stat(store.path()); !os.IsNotExist(err) {
		t.Fatalf("Commit above reader line-count limit published a cache: stat err=%v", err)
	}
}

func TestFileStoreCommitRejectsEntryAboveReaderPerLineLimitBeforePublication(t *testing.T) {
	dir := t.TempDir()
	store := &fileStore{dir: dir, maxLines: 3, maxLineBytes: 96, maxFileBytes: 1 << 20}
	snap := NewSnapshot()
	snap.Put(Key{Path: "large.go", ContentHash: "hash", Version: "version"}, []byte(`"`+strings.Repeat("x", 128)+`"`))
	if err := store.Commit(context.Background(), snap); err == nil {
		t.Fatal("Commit above reader per-line limit returned nil error")
	}
	if _, err := os.Stat(store.path()); !os.IsNotExist(err) {
		t.Fatalf("Commit above reader per-line limit published a cache: stat err=%v", err)
	}
}

func TestFileStoreOversizeRejectedBeforeRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, cacheFileName)
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create oversized cache: %v", err)
	}
	if err := f.Truncate(maxCacheFileBytes + 1); err != nil {
		f.Close()
		t.Fatalf("truncate oversized cache: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close oversized cache: %v", err)
	}

	readCalled := false
	store := &fileStore{
		dir: dir,
		readFile: func(string) ([]byte, error) {
			readCalled = true
			return nil, nil
		},
	}
	snap, err := store.Load(context.Background())
	if err == nil {
		t.Fatal("Load oversized cache returned nil error")
	}
	if got := snap.Stats().Entries; got != 0 {
		t.Errorf("oversized cache entries = %d, want 0", got)
	}
	if readCalled {
		t.Error("oversized cache was read before enforcing the size limit")
	}
}

func TestFileStoreAtSizeLimitIsRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, cacheFileName)
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create boundary cache: %v", err)
	}
	if err := f.Truncate(maxCacheFileBytes); err != nil {
		f.Close()
		t.Fatalf("truncate boundary cache: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close boundary cache: %v", err)
	}

	readCalled := false
	store := &fileStore{
		dir: dir,
		readFile: func(string) ([]byte, error) {
			readCalled = true
			return []byte(`{"v":1,"tool":"draht-graph","entries":0}` + "\n"), nil
		},
	}
	if _, err := store.Load(context.Background()); err != nil {
		t.Fatalf("Load cache at exact size limit: %v", err)
	}
	if !readCalled {
		t.Error("cache at exact size limit was rejected before read")
	}
}

func TestFileStoreRejectsNewlineDenseInputAtInjectedLineCountLimit(t *testing.T) {
	dir := t.TempDir()
	content := `{"v":1,"tool":"draht-graph","entries":1}` + "\n" +
		`{"p":"good.go","h":"hash","k":"version","f":{"loc":1}}` + "\n\n\n\n"
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), []byte(content), 0o644); err != nil {
		t.Fatalf("write dense cache: %v", err)
	}

	store := &fileStore{dir: dir, maxLines: 4, maxLineBytes: 1024}
	snap, err := store.Load(context.Background())
	if err == nil {
		t.Fatal("newline-dense cache above line-count limit returned nil error")
	}
	if got := snap.Stats().Entries; got != 0 {
		t.Fatalf("newline-dense cache entries = %d, want cold snapshot", got)
	}
}

func TestFileStoreRejectsEntryAboveInjectedPerLineLimit(t *testing.T) {
	dir := t.TempDir()
	content := `{"v":1,"tool":"draht-graph","entries":1}` + "\n" +
		`{"p":"oversized.go","h":"hash","k":"version","f":"` + strings.Repeat("x", 128) + `"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), []byte(content), 0o644); err != nil {
		t.Fatalf("write long-line cache: %v", err)
	}

	store := &fileStore{dir: dir, maxLines: 10, maxLineBytes: 96}
	snap, err := store.Load(context.Background())
	if err == nil {
		t.Fatal("cache entry above per-line limit returned nil error")
	}
	if got := snap.Stats().Entries; got != 0 {
		t.Fatalf("long-line cache entries = %d, want cold snapshot", got)
	}
}

func TestFileStoreLoadMissingFileIsEmptyNoError(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)

	snap, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load on a missing cache file returned an error: %v", err)
	}
	if snap.Stats().Entries != 0 {
		t.Fatalf("Stats().Entries = %d, want 0", snap.Stats().Entries)
	}
}

func TestFileStoreColdMissThenWarmHit(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	k := Key{Path: "pkg/a.go", ContentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Version: "f1|pts/3|xx1"}

	// Cold: nothing on disk yet.
	cold, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("cold Load: %v", err)
	}
	if _, ok := cold.Get(k); ok {
		t.Fatalf("cold Get should miss")
	}

	// Simulate the extractor producing a result for this file and caching it.
	payload := []byte(`{"loc":42,"exp":[{"name":"Foo","kind":"function","line":1,"doc":null}]}`)
	cold.Put(k, payload)

	if err := store.Commit(ctx, cold); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Warm: a fresh Load must reproduce the payload without re-extracting.
	warm, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("warm Load: %v", err)
	}
	got, ok := warm.Get(k)
	if !ok {
		t.Fatalf("warm Get should hit after Commit")
	}
	if string(got) != string(payload) {
		t.Fatalf("warm payload = %q, want %q", got, payload)
	}
}

func TestFileStoreContentChangeInvalidates(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	base := Key{Path: "pkg/a.go", ContentHash: "hash-v1", Version: "f1|pts/3|xx1"}
	snap := NewSnapshot()
	snap.Put(base, []byte(`{"loc":1}`))
	if err := store.Commit(ctx, snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	warm, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	changed := Key{Path: "pkg/a.go", ContentHash: "hash-v2", Version: base.Version}
	if _, ok := warm.Get(changed); ok {
		t.Fatalf("a content-hash change must invalidate the cache entry")
	}
	// The original key, unchanged, must still hit.
	if _, ok := warm.Get(base); !ok {
		t.Fatalf("the original (unchanged) key should still hit")
	}
}

func TestFileStoreVersionBumpInvalidates(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	base := Key{Path: "pkg/a.go", ContentHash: "hash-v1", Version: "f1|pts/3|xx1"}
	snap := NewSnapshot()
	snap.Put(base, []byte(`{"loc":1}`))
	if err := store.Commit(ctx, snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	warm, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	bumped := Key{Path: "pkg/a.go", ContentHash: base.ContentHash, Version: "f1|pts/4|xx1"}
	if _, ok := warm.Get(bumped); ok {
		t.Fatalf("a parser/extractor version bump must invalidate the cache entry")
	}
}

func TestFileStoreCorruptEntryIsMiss(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	good := Key{Path: "pkg/good.go", ContentHash: "hash-good", Version: "f1|pts/3|xx1"}
	snap := NewSnapshot()
	snap.Put(good, []byte(`{"loc":1}`))
	if err := store.Commit(ctx, snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Hand-corrupt the file: append a line that is not valid JSON at all,
	// and a line that is valid JSON but missing required fields.
	raw, err := os.ReadFile(filepath.Join(dir, cacheFileName))
	if err != nil {
		t.Fatalf("read cache file: %v", err)
	}
	corrupted := string(raw) + "{not json at all\n" + `{"p":"","h":"","k":""}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), []byte(corrupted), 0o644); err != nil {
		t.Fatalf("write corrupted cache file: %v", err)
	}

	loaded, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load with a corrupt trailing entry must not error: %v", err)
	}
	if _, ok := loaded.Get(good); !ok {
		t.Fatalf("the well-formed entry must survive a corrupt sibling line")
	}
	if got := loaded.Stats().Entries; got != 1 {
		t.Fatalf("Stats().Entries = %d, want 1 (corrupt lines must not be counted)", got)
	}
}

func TestFileStoreCorruptHeaderIsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	bad := "not a json header at all\n" + `{"p":"a.go","h":"x","k":"y","f":{}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), []byte(bad), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	store := NewFileStore(dir)
	snap, err := store.Load(context.Background())
	if err == nil {
		t.Fatalf("Load with a corrupt header should return an advisory error")
	}
	if snap.Stats().Entries != 0 {
		t.Fatalf("Stats().Entries = %d, want 0 for a corrupt-header file", snap.Stats().Entries)
	}
}

func TestFileStoreWrongFormatVersionIsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := `{"v":99,"tool":"draht-graph","entries":1}` + "\n" + `{"p":"a.go","h":"x","k":"y","f":{}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	store := NewFileStore(dir)
	snap, err := store.Load(context.Background())
	if err == nil {
		t.Fatalf("Load with an unsupported format version should return an advisory error")
	}
	if snap.Stats().Entries != 0 {
		t.Fatalf("Stats().Entries = %d, want 0 for a version-mismatched header", snap.Stats().Entries)
	}
}

func TestFileStoreTruncatedLastLineOtherEntriesSurvive(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	k1 := Key{Path: "a.go", ContentHash: "h1", Version: "v1"}
	k2 := Key{Path: "b.go", ContentHash: "h2", Version: "v1"}
	snap := NewSnapshot()
	snap.Put(k1, []byte(`{"loc":1}`))
	snap.Put(k2, []byte(`{"loc":2}`))
	if err := store.Commit(ctx, snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, cacheFileName))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// Simulate a process being killed mid-write: chop off the tail of the
	// last byte range so the final entry line is no longer valid JSON.
	truncated := raw[:len(raw)-5]
	if err := os.WriteFile(filepath.Join(dir, cacheFileName), truncated, 0o644); err != nil {
		t.Fatalf("write truncated file: %v", err)
	}

	loaded, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load on a truncated file must not error: %v", err)
	}
	// At least one of the two entries (whichever sorts first and thus is
	// written first) must have survived intact.
	_, ok1 := loaded.Get(k1)
	_, ok2 := loaded.Get(k2)
	if !ok1 && !ok2 {
		t.Fatalf("truncation destroyed every entry; expected at least the first to survive")
	}
}

func TestFileStoreCommitDropsUnreferencedEntries(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	kUsed := Key{Path: "used.go", ContentHash: "h1", Version: "v1"}
	kUnused := Key{Path: "unused.go", ContentHash: "h2", Version: "v1"}

	seed := NewSnapshot()
	seed.Put(kUsed, []byte(`{"loc":1}`))
	seed.Put(kUnused, []byte(`{"loc":2}`))
	if err := store.Commit(ctx, seed); err != nil {
		t.Fatalf("seed Commit: %v", err)
	}

	// Next run: load, touch only kUsed, commit again.
	next, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, ok := next.Get(kUsed); !ok {
		t.Fatalf("expected kUsed to be present before the second Commit")
	}
	// kUnused is deliberately never Get/Put this run.

	if err := store.Commit(ctx, next); err != nil {
		t.Fatalf("second Commit: %v", err)
	}

	final, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("final Load: %v", err)
	}
	if _, ok := final.Get(kUsed); !ok {
		t.Fatalf("kUsed should survive across two Commits")
	}
	if got := final.Stats().Entries; got != 1 {
		t.Fatalf("Stats().Entries = %d, want 1 (kUnused should have been dropped)", got)
	}
}

func TestFileStoreCommitCreatesGitignore(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	snap := NewSnapshot()
	snap.Put(Key{Path: "a.go", ContentHash: "h", Version: "v1"}, []byte(`{}`))

	if err := store.Commit(context.Background(), snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		t.Fatalf("read .gitignore: %v", err)
	}
	if string(got) != "*\n" {
		t.Fatalf(".gitignore content = %q, want %q", got, "*\n")
	}
}

func TestFileStoreCommitIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(dir)
	ctx := context.Background()

	build := func() *Snapshot {
		s := NewSnapshot()
		s.Put(Key{Path: "z.go", ContentHash: "hz", Version: "v1"}, []byte(`{"loc":3}`))
		s.Put(Key{Path: "a.go", ContentHash: "ha", Version: "v1"}, []byte(`{"loc":1}`))
		s.Put(Key{Path: "m.go", ContentHash: "hm", Version: "v1"}, []byte(`{"loc":2}`))
		return s
	}

	if err := store.Commit(ctx, build()); err != nil {
		t.Fatalf("first Commit: %v", err)
	}
	first, err := os.ReadFile(filepath.Join(dir, cacheFileName))
	if err != nil {
		t.Fatalf("read first: %v", err)
	}

	if err := store.Commit(ctx, build()); err != nil {
		t.Fatalf("second Commit: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(dir, cacheFileName))
	if err != nil {
		t.Fatalf("read second: %v", err)
	}

	if string(first) != string(second) {
		t.Fatalf("two Commits of identical content produced different bytes:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
}

func TestPurgeRemovesDirectory(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "graph-v1")
	store := NewFileStore(sub)
	snap := NewSnapshot()
	snap.Put(Key{Path: "a.go", ContentHash: "h", Version: "v1"}, []byte(`{}`))
	if err := store.Commit(context.Background(), snap); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := Purge(sub); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if _, err := os.Stat(sub); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be gone after Purge, stat err = %v", sub, err)
	}
}

func TestPurgeOnMissingDirIsNotError(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does", "not", "exist")
	if err := Purge(dir); err != nil {
		t.Fatalf("Purge on a non-existent dir should not error: %v", err)
	}
}
