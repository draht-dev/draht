package scan

import (
	"os"
	"testing"
)

// TestDiscover_RealWorktreePlausibleModuleCount scans the actual repository
// this module lives in and sanity-checks the code-module count against the
// measured CJS baseline (1,340 modules; see the Phase 1 design doc's Spike
// findings). It is a coarse regression net for the whole scan pipeline, not
// a byte-parity test — see the investigation note below for the expected,
// explained gap.
func TestDiscover_RealWorktreePlausibleModuleCount(t *testing.T) {
	if os.Getenv("CI") == "" {
		// Still runs locally by default; this guard exists only so a
		// deliberately git-less/unusual CI sandbox can skip it explicitly
		// via SCAN_SKIP_REALREPO, not because it's normally flaky.
	}
	if os.Getenv("SCAN_SKIP_REALREPO") != "" {
		t.Skip("SCAN_SKIP_REALREPO set")
	}
	requireGit(t)

	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	root, err := FindRepoRoot(cwd)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}

	res, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover(%q): %v", root, err)
	}
	if !res.GitFiltered {
		t.Fatal("GitFiltered = false; expected git to be available for this repo")
	}
	if res.Truncated {
		t.Fatal("Truncated = true; repo unexpectedly exceeds the 5000-file walk cap")
	}

	code := res.CodeFiles()
	t.Logf("scanned root=%s files=%d codeModules=%d truncated=%v", root, len(res.Files), len(code), res.Truncated)
	for _, lc := range res.LangCounts {
		t.Logf("  lang %-12s count=%d", lc.Lang, lc.Count)
	}

	// The CJS engine (packages/draht-tools/bin/draht-tools.cjs map-graph)
	// measured 1,340 code modules on this repo before the go/ tree existed.
	// Adding go/ (WP-A..D scaffold + this package's own .go files, all
	// git-tracked-or-untracked-and-not-ignored) legitimately adds new
	// TypeScript-adjacent... no: new *Go* code modules that the CJS engine
	// never saw (it doesn't classify .go as a module for its own repo count
	// either, but it also never walked this go/ directory before it existed).
	// So a same-ballpark-but-higher count is expected and correct, not a
	// regression. We assert a generous band and log the exact number so a
	// human can eyeball the delta against `git ls-files -- go | grep -c
	// '\.go$'`.
	const (
		lowerBound = 1200 // sanity floor: catches a broken walk/git-filter/classifier
		upperBound = 2000 // sanity ceiling: catches ignore-rule or dedup regressions
	)
	if len(code) < lowerBound || len(code) > upperBound {
		t.Errorf("CodeFiles() = %d modules, want within [%d, %d] (CJS baseline 1340 + go/ growth)",
			len(code), lowerBound, upperBound)
	}
}
