package scan

import (
	"context"
	"os"
	"testing"
)

// TestDiscover_RealWorktreePlausibleModuleCount scans the actual repository
// this module lives in and sanity-checks the code-module count against the
// git-visible code set. It is a coarse regression net for the whole scan
// pipeline, not a byte-parity test — see the note below.
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

	// The repository grows (upstream syncs, new workspaces), so a fixed
	// ceiling is a snapshot of its size, not a regression net. The ceiling
	// existed to catch ignore-rule and dedup regressions; assert those
	// directly against an independent oracle instead: the git-visible code
	// set (git ls-files --cached --others --exclude-standard, classified by
	// the same LangFor). Discover is the walk intersected with that set, so
	// it can only fall short of it by what the walk skips by design (hidden
	// directories, symlinks); a much larger shortfall means the walk is
	// over-pruning, and any duplicate means dedup broke.
	const lowerBound = 1200 // sanity floor: catches a broken walk/git-filter/classifier
	if len(code) < lowerBound {
		t.Errorf("CodeFiles() = %d modules, want >= %d", len(code), lowerBound)
	}

	seen := make(map[string]struct{}, len(code))
	for _, f := range code {
		if _, dup := seen[f.Rel]; dup {
			t.Errorf("CodeFiles() lists %q twice (dedup regression)", f.Rel)
		}
		seen[f.Rel] = struct{}{}
	}

	gitFiles, ok := GitFiles(context.Background(), root)
	if !ok {
		t.Fatal("GitFiles failed although Discover reported GitFiltered")
	}
	gitCode := 0
	for _, rel := range gitFiles {
		if IsCodeLang(LangFor(rel)) {
			gitCode++
		}
	}
	t.Logf("git-visible code files=%d", gitCode)
	if len(code) > gitCode {
		t.Errorf("CodeFiles() = %d modules, more than the %d git-visible code files (ignore-rule or dedup regression)", len(code), gitCode)
	}
	if minCode := gitCode * 9 / 10; len(code) < minCode {
		t.Errorf("CodeFiles() = %d modules, under 90%% of the %d git-visible code files (walk over-pruning)", len(code), gitCode)
	}
}
