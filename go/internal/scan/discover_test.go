package scan

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestFile_Readable_StrictLessThanBoundary(t *testing.T) {
	cases := []struct {
		size int64
		want bool
	}{
		{0, true},
		{MaxFileBytes - 1, true},
		{MaxFileBytes, false}, // strict "<"; exactly 1 MiB is NOT readable
		{MaxFileBytes + 1, false},
	}
	for _, tc := range cases {
		f := File{Size: tc.size}
		if got := f.Readable(); got != tc.want {
			t.Errorf("File{Size:%d}.Readable() = %v, want %v", tc.size, got, tc.want)
		}
	}
}

func TestIsTest(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{"packages/foo/test/bar.ts", true},
		{"packages/foo/tests/bar.ts", true},
		{"packages/foo/__tests__/bar.ts", true},
		{"packages/foo/spec/bar.ts", true},
		{"test/bar.ts", true},
		{"packages/foo/specs/bar.ts", false}, // "specs" != "spec": the trailing "/" anchors it
		{"packages/foo/Tests/bar.ts", false}, // case-sensitive
		{"foo.test.ts", true},
		{"foo.spec.mjs", true},
		{"foo.Test.ts", false},     // case-sensitive
		{"foo.test.TS", false},     // extension class is [a-z]+ only
		{"foo.test.ts.bak", false}, // must anchor at end
		{"bar.ts", false},
		{"packages/foo/src/bar.ts", false},
	}
	for _, tc := range cases {
		if got := IsTest(tc.rel); got != tc.want {
			t.Errorf("IsTest(%q) = %v, want %v", tc.rel, got, tc.want)
		}
	}
}

func TestClassifyFiles_StatFailureKeepsFileWithZeroSize(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "real.ts"), "export const x = 1;\n")
	// "ghost.ts" is listed (as if git reported it) but does not exist on disk —
	// this reproduces the CJS engine's swallowed statSync/readFileSync
	// try/catch (draht-tools.cjs:2137-2161): the module is still counted and
	// still classified, just with Size 0.
	relFiles := []string{"ghost.ts", "real.ts"}

	files, langCounts := classifyFiles(root, relFiles)
	if len(files) != 2 {
		t.Fatalf("len(files) = %d, want 2", len(files))
	}
	if files[0].Rel != "ghost.ts" || files[0].Size != 0 {
		t.Errorf("files[0] = %+v, want Rel=ghost.ts Size=0", files[0])
	}
	if files[0].Lang != LangTypeScript {
		t.Errorf("files[0].Lang = %q, want typescript", files[0].Lang)
	}
	if files[1].Rel != "real.ts" || files[1].Size == 0 {
		t.Errorf("files[1] = %+v, want Rel=real.ts Size>0", files[1])
	}

	want := []LangCount{{Lang: LangTypeScript, Count: 2}}
	if !reflect.DeepEqual(langCounts, want) {
		t.Errorf("langCounts = %v, want %v", langCounts, want)
	}
}

func TestClassifyFiles_LangCountsFirstEncounterOrder(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"a.md", "b.ts", "c.ts", "d.md", "e.py"} {
		mustWriteFile(t, filepath.Join(root, rel), "x")
	}
	_, langCounts := classifyFiles(root, []string{"a.md", "b.ts", "c.ts", "d.md", "e.py"})
	want := []LangCount{
		{Lang: "markdown", Count: 2},
		{Lang: LangTypeScript, Count: 2},
		{Lang: LangPython, Count: 1},
	}
	if !reflect.DeepEqual(langCounts, want) {
		t.Errorf("langCounts = %v, want %v (first-encounter order)", langCounts, want)
	}
}

func TestResult_CodeFilesAndAssets(t *testing.T) {
	r := Result{Files: []File{
		{Rel: "a.ts", Lang: LangTypeScript},
		{Rel: "README.md", Lang: "markdown"},
		{Rel: "b.go", Lang: LangGo},
		{Rel: "data.json", Lang: "json"},
	}}
	code := r.CodeFiles()
	if len(code) != 2 || code[0].Rel != "a.ts" || code[1].Rel != "b.go" {
		t.Errorf("CodeFiles() = %v, want [a.ts b.go]", code)
	}
	assets := r.Assets()
	if len(assets) != 2 || assets[0].Rel != "README.md" || assets[1].Rel != "data.json" {
		t.Errorf("Assets() = %v, want [README.md data.json]", assets)
	}
}

func TestDiscover_WalkGitIntersectionAndTruncatedFlag(t *testing.T) {
	requireGit(t)
	root := t.TempDir()
	runGit(t, root, "init", "-q")
	mustWriteFile(t, filepath.Join(root, "kept.ts"), "export const x = 1;\n")
	mustWriteFile(t, filepath.Join(root, "ignored.ts"), "export const y = 2;\n")
	mustWriteFile(t, filepath.Join(root, ".gitignore"), "ignored.ts\n")
	runGit(t, root, "add", "kept.ts", ".gitignore")
	runGit(t, root, "commit", "-q", "-m", "init")

	res, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if res.Truncated {
		t.Error("Truncated = true, want false")
	}
	if !res.GitFiltered {
		t.Error("GitFiltered = false, want true (git is available)")
	}
	var rels []string
	for _, f := range res.Files {
		rels = append(rels, f.Rel)
	}
	found := map[string]bool{}
	for _, r := range rels {
		found[r] = true
	}
	if !found["kept.ts"] {
		t.Errorf("kept.ts missing from Discover result: %v", rels)
	}
	if found["ignored.ts"] {
		t.Errorf("ignored.ts should be excluded by .gitignore: %v", rels)
	}
}
