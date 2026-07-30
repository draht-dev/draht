package parse

import "testing"

func TestGrammarFor(t *testing.T) {
	cases := []struct {
		lang Lang
		path string
		want string
	}{
		{"typescript", "src/index.ts", "typescript"},
		{"typescript", "src/component.tsx", "tsx"},
		{"typescript", "src/component.TSX", "tsx"},
		{"typescript", "", "typescript"},
		{"javascript", "src/index.js", "javascript"},
		{"python", "x.py", "python"},
		{"go", "x.go", "go"},
		{"rust", "x.rs", "rust"},
		{"java", "X.java", "java"},
		{"kotlin", "X.kt", "kotlin"},
		{"swift", "X.swift", "swift"},
		{"ruby", "x.rb", "ruby"},
		{"php", "x.php", "php"},
		{"csharp", "X.cs", "c_sharp"},
		{"c", "x.c", "c"},
		{"cpp", "x.cpp", "cpp"},
		{"shell", "x.sh", "bash"},
		{"markdown", "README.md", ""},
		{"other", "x.bin", ""},
	}
	for _, tc := range cases {
		if got := grammarFor(tc.lang, tc.path); got != tc.want {
			t.Errorf("grammarFor(%q, %q) = %q, want %q", tc.lang, tc.path, got, tc.want)
		}
	}
}
