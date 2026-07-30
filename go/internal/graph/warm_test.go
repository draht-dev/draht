package graph

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/draht-dev/draht/go/internal/parse"
)

// warmBuild runs Build against root/cacheDir/outDir, failing the test on
// error, and returns both the normalized output and the Report (for
// hit/miss assertions).
func warmBuild(t *testing.T, root, cacheDir string) ([]byte, Report) {
	t.Helper()
	p, err := parse.NewTreeSitter(fixtureRepoLangs)
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer p.Close()

	m, report, err := Build(context.Background(), Options{
		Root:     root,
		OutDir:   t.TempDir(),
		CacheDir: cacheDir,
		Jobs:     4,
		Parser:   p,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return normalize(t, m), report
}

// TestWarmCache_ColdThenWarmAreByteIdentical is the G4 gate the review
// flagged as missing: a cold Build (empty cache dir) followed by a warm
// Build (same root, same cache dir, nothing changed on disk) must produce
// byte-identical MAP.json content, and the warm run must report a full
// cache hit with zero misses.
func TestWarmCache_ColdThenWarmAreByteIdentical(t *testing.T) {
	root := newFixtureRepo(t)
	cacheDir := t.TempDir()

	cold, coldReport := warmBuild(t, root, cacheDir)
	if coldReport.CacheHits != 0 {
		t.Errorf("cold run: CacheHits = %d, want 0", coldReport.CacheHits)
	}
	if coldReport.CacheMisses == 0 {
		t.Error("cold run: CacheMisses = 0, want > 0 (every code file should miss on a fresh cache)")
	}

	warm, warmReport := warmBuild(t, root, cacheDir)
	if !bytes.Equal(cold, warm) {
		t.Fatalf("cold and warm Build outputs diverge")
	}
	if warmReport.CacheMisses != 0 {
		t.Errorf("warm run: CacheMisses = %d, want 0 (nothing changed on disk)", warmReport.CacheMisses)
	}
	if warmReport.CacheHits != coldReport.CacheMisses {
		t.Errorf("warm run: CacheHits = %d, want %d (== cold run's miss count, every file now cached)", warmReport.CacheHits, coldReport.CacheMisses)
	}
}

// TestWarmCache_MtimeOnlyTouchStaysAHit asserts the cache key is
// content-hash-based, not mtime-based: touching a file's mtime WITHOUT
// changing its bytes must still be a cache hit.
func TestWarmCache_MtimeOnlyTouchStaysAHit(t *testing.T) {
	root := newFixtureRepo(t)
	cacheDir := t.TempDir()

	_, coldReport := warmBuild(t, root, cacheDir)

	target := filepath.Join(root, "packages", "app", "src", "main.ts")
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read %s: %v", target, err)
	}
	// Rewrite the exact same bytes (content unchanged) but force a new
	// mtime, matching what `touch` would do.
	future := time.Now().Add(1 * time.Hour)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		t.Fatalf("rewrite %s: %v", target, err)
	}
	if err := os.Chtimes(target, future, future); err != nil {
		t.Fatalf("chtimes %s: %v", target, err)
	}

	warm, warmReport := warmBuild(t, root, cacheDir)
	_ = warm
	if warmReport.CacheMisses != 0 {
		t.Errorf("CacheMisses = %d after an mtime-only touch, want 0 (cache key is content-hash based, not mtime-based)", warmReport.CacheMisses)
	}
	if warmReport.CacheHits != coldReport.CacheMisses {
		t.Errorf("CacheHits = %d, want %d (every file still cached)", warmReport.CacheHits, coldReport.CacheMisses)
	}
}

// TestWarmCache_OneByteChangeIsExactlyOneMiss asserts the cache invalidates
// PRECISELY the changed file — not the whole cache, not zero files — when
// exactly one byte of exactly one file changes.
func TestWarmCache_OneByteChangeIsExactlyOneMiss(t *testing.T) {
	root := newFixtureRepo(t)
	cacheDir := t.TempDir()

	_, coldReport := warmBuild(t, root, cacheDir)

	target := filepath.Join(root, "packages", "app", "src", "lazy.ts")
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read %s: %v", target, err)
	}
	modified := append(append([]byte(nil), data...), '\n') // append one byte
	if err := os.WriteFile(target, modified, 0o644); err != nil {
		t.Fatalf("rewrite %s: %v", target, err)
	}

	_, warmReport := warmBuild(t, root, cacheDir)
	if warmReport.CacheMisses != 1 {
		t.Errorf("CacheMisses = %d after changing exactly one file's content, want exactly 1", warmReport.CacheMisses)
	}
	wantHits := coldReport.CacheMisses - 1
	if warmReport.CacheHits != wantHits {
		t.Errorf("CacheHits = %d, want %d (every OTHER file still cached)", warmReport.CacheHits, wantHits)
	}
}
