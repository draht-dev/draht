package scan

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// File is one discovered file with its classification.
type File struct {
	Abs  string // absolute path
	Rel  string // repo-relative POSIX path (identity)
	Lang Lang
	Size int64
}

// IsCode reports whether f participates in the module graph.
func (f File) IsCode() bool { return IsCodeLang(f.Lang) }

// IsTestFile reports whether f looks like a test file.
func (f File) IsTestFile() bool { return IsTest(f.Rel) }

// Readable reports whether f is small enough to read + parse (strict
// "< 1 MiB", matching the CJS read gate).
func (f File) Readable() bool { return f.Size < MaxFileBytes }

// LangCount is one (language, count) pair in first-encounter order.
type LangCount struct {
	Lang  Lang
	Count int
}

// Result is the full discovery output.
type Result struct {
	// Files is sorted by Abs.
	Files []File
	// LangCounts is in first-encounter order over Files.
	LangCounts  []LangCount
	Truncated   bool
	GitFiltered bool
}

// CodeFiles returns the subset of r.Files with IsCode() true, preserving
// order (WP2 / schema-v5 noise policy: only these become graph modules).
func (r Result) CodeFiles() []File {
	out := make([]File, 0, len(r.Files))
	for _, f := range r.Files {
		if f.IsCode() {
			out = append(out, f)
		}
	}
	return out
}

// Assets returns the subset of r.Files with IsCode() false, preserving
// order (the WP2 "assets" rollup: everything seen but not graphed).
func (r Result) Assets() []File {
	out := make([]File, 0, len(r.Files))
	for _, f := range r.Files {
		if !f.IsCode() {
			out = append(out, f)
		}
	}
	return out
}

// testDirRe / testFileRe are the two RE2 regexes behind IsTest, ported
// verbatim from visIsTest (draht-tools.cjs:1586-1589). Both are
// case-sensitive: "Tests/", ".Test.ts", ".test.TS" and "specs/" all fail to
// match.
var (
	testDirRe  = regexp.MustCompile(`(^|/)(test|tests|__tests__|spec)/`)
	testFileRe = regexp.MustCompile(`\.(test|spec)\.[a-z]+$`)
)

// IsTest reports whether rel looks like a test file path (two RE2 regexes,
// case-sensitive; see design table: "Tests/" no, ".test.TS" no, "specs/" no,
// "foo.test.mjs" yes).
func IsTest(rel string) bool {
	return testDirRe.MatchString(rel) || testFileRe.MatchString(rel)
}

// Discover walks root, filters through git (when available, falling back to
// Walk otherwise — see GitFiles), stats every surviving file, and
// classifies languages. langCounts are incremented before the read gate
// (i.e. for every walked+git-kept file, code or not). Verbatim port of the
// file-discovery phase of visBuildMap (draht-tools.cjs:2065-2133).
func Discover(root string) (*Result, error) {
	walked, err := Walk(WalkOptions{Root: root})
	if err != nil {
		return nil, fmt.Errorf("scan: walk %s: %w", root, err)
	}

	gitFiles, gitOK := GitFiles(context.Background(), root)

	relFiles := walked.Files
	if gitOK {
		set := toSet(gitFiles)
		filtered := make([]string, 0, len(walked.Files))
		for _, rel := range walked.Files {
			if _, ok := set[rel]; ok {
				filtered = append(filtered, rel)
			}
		}
		relFiles = filtered
	}

	files, langCounts := classifyFiles(root, relFiles)

	return &Result{
		Files:       files,
		LangCounts:  langCounts,
		Truncated:   walked.Truncated,
		GitFiltered: gitOK,
	}, nil
}

// classifyFiles stats and classifies each repo-relative path in relFiles,
// in order, incrementing langCounts in first-encounter order (before any
// read gate — every file counts, code or not). A swallowed stat failure
// (race, permission, or — as in the "git knows about a deleted file" case —
// a path present in the git index but absent on disk) still yields the file
// with Size 0, matching the CJS engine's try/catch-and-continue at
// draht-tools.cjs:2137-2161.
func classifyFiles(root string, relFiles []string) ([]File, []LangCount) {
	files := make([]File, 0, len(relFiles))
	var langCounts []LangCount
	idx := make(map[Lang]int)

	for _, rel := range relFiles {
		lang := LangFor(rel)
		if i, ok := idx[lang]; ok {
			langCounts[i].Count++
		} else {
			idx[lang] = len(langCounts)
			langCounts = append(langCounts, LangCount{Lang: lang, Count: 1})
		}

		abs := filepath.Join(root, filepath.FromSlash(rel))
		var size int64
		if info, statErr := os.Stat(abs); statErr == nil {
			size = info.Size()
		}
		files = append(files, File{Abs: abs, Rel: rel, Lang: lang, Size: size})
	}

	return files, langCounts
}
