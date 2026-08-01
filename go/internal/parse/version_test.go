package parse

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// allQueryText concatenates every ImportQueryFor grammar's query text in a
// fixed order, so a golden hash over the concatenation catches ANY change to
// ANY query — a change that must be accompanied by a queryRev bump (and,
// transitively, a Parser.Version() bump, invalidating the on-disk cache).
func allQueryText() string {
	grammars := []string{
		"typescript", "tsx", "javascript", "python", "go", "rust",
		"java", "kotlin", "swift", "ruby", "php", "c_sharp", "c", "cpp", "bash",
	}
	var all string
	for _, g := range grammars {
		all += g + "\x00" + ImportQueryFor(g) + "\x00"
	}
	return all
}

// TestQueryGolden fails if any import query's text changes without a
// corresponding queryRev bump in queries.go. To intentionally change a query,
// bump queryRev, then update wantHash below to the value this test reports.
func TestQueryGolden(t *testing.T) {
	const wantRev = 2
	if queryRev != wantRev {
		t.Fatalf("queryRev = %d, want %d (update wantRev alongside any deliberate query change)", queryRev, wantRev)
	}

	sum := sha256.Sum256([]byte(allQueryText()))
	got := hex.EncodeToString(sum[:])

	const wantHash = "f99ca7ad21233fb6a06511de89777d5a8c730e318e01b15bc35619ea2728bf55"
	if got != wantHash {
		t.Fatalf("import query text changed without a queryRev bump: got hash %s, want %s\n"+
			"if this change is deliberate: bump queryRev in queries.go, then update wantHash to %s",
			got, wantHash, got)
	}
}

func TestImportQueryFor_UnknownGrammarReturnsEmpty(t *testing.T) {
	if q := ImportQueryFor("cobol"); q != "" {
		t.Errorf("ImportQueryFor(cobol) = %q, want empty", q)
	}
}

// TestTreeSitterVersion_FoldsASTSizeLimits guards the cache-poisoning bug
// found by review: a run with --ast-max-bytes/--ast-max-line set must never
// share a cache key with a run without those limits (or with different
// limits), because Extract's observable output differs (a file over the
// limit is silently skipped and produces zero imports). Before the fix,
// Version() depended only on queryRev and a hardcoded library string, so
// every combination below collided.
func TestTreeSitterVersion_FoldsASTSizeLimits(t *testing.T) {
	base, err := NewTreeSitter([]Lang{"go"})
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer base.Close()

	withMaxBytes, err := NewTreeSitter([]Lang{"go"}, WithMaxBytes(2000))
	if err != nil {
		t.Fatalf("NewTreeSitter(WithMaxBytes): %v", err)
	}
	defer withMaxBytes.Close()

	withMaxLine, err := NewTreeSitter([]Lang{"go"}, WithMaxLineBytes(500))
	if err != nil {
		t.Fatalf("NewTreeSitter(WithMaxLineBytes): %v", err)
	}
	defer withMaxLine.Close()

	withBoth, err := NewTreeSitter([]Lang{"go"}, WithMaxBytes(2000), WithMaxLineBytes(500))
	if err != nil {
		t.Fatalf("NewTreeSitter(both): %v", err)
	}
	defer withBoth.Close()

	versions := map[string]string{
		"no limits":     base.Version(),
		"maxBytes=2000": withMaxBytes.Version(),
		"maxLine=500":   withMaxLine.Version(),
		"both":          withBoth.Version(),
	}
	seen := map[string]string{}
	for label, v := range versions {
		if other, dup := seen[v]; dup {
			t.Fatalf("Version() collision: %q and %q both produced %q (maxBytes/maxLineBytes must be part of the cache key)", label, other, v)
		}
		seen[v] = label
	}
}

// TestGotreesitterVersion_FallsBackGracefully documents and asserts a real
// Go toolchain limitation: `go test`-compiled test binaries do NOT embed a
// module dependency list in their build info (verified empirically: `go
// version -m` on a `go test -c` binary shows zero `dep` lines, vs. a plain
// `go build` binary of the same package which correctly shows
// "dep github.com/odvcencio/gotreesitter v0.47.1"). So inside a `go test`
// process, gotreesitterVersion() cannot resolve the real dependency version
// and must fall back to "unknown" — never panic, never silently return a
// stale hardcoded literal. The end-to-end guarantee that a PRODUCTION
// binary's Version() actually reflects go.mod's pinned gotreesitter version
// (the finding's real concern: a `go get -u` must invalidate the cache) is
// verified by cmd/draht-tools/main_test.go's TestVersion_MatchesGoModGotreesitterVersion,
// which builds the real CLI binary and inspects its `--version` output.
func TestGotreesitterVersion_FallsBackGracefully(t *testing.T) {
	if got := gotreesitterVersion(); got == "" {
		t.Fatal("gotreesitterVersion() returned empty string, want a non-empty fallback (e.g. \"unknown\")")
	}
}

// TestTreeSitterVersion_FoldsGrammarSet pins the invariant that decides
// whether adding a language is safe.
//
// The failure it guards against is silent: when a language is not compiled
// into the parser, Extract returns import-less Facts and the pipeline caches
// them. Enabling that language later changes no query text and no dependency
// version, so if the grammar set were absent from Version() the cache key
// would be byte-identical and every already-cached file of the newly-enabled
// language would keep reporting zero imports — with no error, and no way for a
// user to discover it short of deleting the cache.
func TestTreeSitterVersion_FoldsGrammarSet(t *testing.T) {
	goOnly, err := NewTreeSitter([]Lang{"go"})
	if err != nil {
		t.Fatalf("NewTreeSitter(go): %v", err)
	}
	defer goOnly.Close()

	goAndPython, err := NewTreeSitter([]Lang{"go", "python"})
	if err != nil {
		t.Fatalf("NewTreeSitter(go,python): %v", err)
	}
	defer goAndPython.Close()

	if goOnly.Version() == goAndPython.Version() {
		t.Fatalf("enabling a language did not change the cache key: both %q\n"+
			"a warm cache would serve import-less facts for every python file", goOnly.Version())
	}

	// Order must not matter: the same set has to produce the same key, or an
	// incidental reordering of langset.CLILanguages would needlessly discard
	// every user's cache.
	reordered, err := NewTreeSitter([]Lang{"python", "go"})
	if err != nil {
		t.Fatalf("NewTreeSitter(python,go): %v", err)
	}
	defer reordered.Close()

	if reordered.Version() != goAndPython.Version() {
		t.Errorf("language order changed the cache key:\n  go,python = %q\n  python,go = %q",
			goAndPython.Version(), reordered.Version())
	}
}

// TestTreeSitterVersion_FoldsMatchLimit covers the other output-affecting
// option: exceeding the query-cursor match limit truncates matches and flags
// the Result Degraded, i.e. fewer imports from identical input.
func TestTreeSitterVersion_FoldsMatchLimit(t *testing.T) {
	base, err := NewTreeSitter([]Lang{"go"})
	if err != nil {
		t.Fatalf("NewTreeSitter: %v", err)
	}
	defer base.Close()

	limited, err := NewTreeSitter([]Lang{"go"}, WithMatchLimit(64))
	if err != nil {
		t.Fatalf("NewTreeSitter(WithMatchLimit): %v", err)
	}
	defer limited.Close()

	if base.Version() == limited.Version() {
		t.Errorf("match limit not folded into cache key: both %q", base.Version())
	}
}
