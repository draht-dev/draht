package scan

import "testing"

func TestJSExtname(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{".gitignore", ""},
		{"a.", "."},
		{"x/.env.local", ".local"},
		{"foo.TS", ".TS"},
		{"a/b.tar.gz", ".gz"},
		{"noext", ""},
		{"x.d.ts", ".ts"},
		{"", ""},
		{".", ""},
		{"..", ""},
		{"a/..", ""},
		{"/a/.b", ""},
	}
	for _, tc := range cases {
		if got := JSExtname(tc.path); got != tc.want {
			t.Errorf("JSExtname(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestLangFor(t *testing.T) {
	cases := []struct {
		path string
		want Lang
	}{
		{"src/index.ts", LangTypeScript},
		{"src/Component.tsx", LangTypeScript},
		{"src/index.mts", LangTypeScript},
		{"src/index.cts", LangTypeScript},
		{"src/index.js", LangJavaScript},
		{"src/index.jsx", LangJavaScript},
		{"src/index.mjs", LangJavaScript},
		{"src/index.cjs", LangJavaScript},
		{"main.py", LangPython},
		{"main.go", LangGo},
		{"main.rs", LangRust},
		{"Main.java", LangJava},
		{"Main.kt", LangKotlin},
		{"Main.swift", LangSwift},
		{"main.rb", LangRuby},
		{"main.php", LangPHP},
		{"Main.cs", LangCSharp},
		{"main.c", LangC},
		{"main.h", LangC}, // .h is always C, never C++
		{"main.cpp", LangCPP},
		{"main.hpp", LangCPP},
		{"main.cc", LangCPP},
		{"README.md", "markdown"},
		{"package.json", "json"},
		{"config.yaml", "yaml"},
		{"config.yml", "yaml"},
		{"tsconfig.toml", "toml"},
		{"index.html", "html"},
		{"style.css", "css"},
		{"style.scss", "scss"},
		{"run.sh", LangShell},
		{"run.bash", LangShell},
		{"run.zsh", LangShell},
		{"schema.sql", "sql"},
		{".gitignore", LangOther},
		{"noext", LangOther},
		{"Makefile", LangOther},
		{"x.d.ts", LangTypeScript},
		{"foo.TS", LangTypeScript}, // case-insensitive
	}
	for _, tc := range cases {
		if got := LangFor(tc.path); got != tc.want {
			t.Errorf("LangFor(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestLangByExtTableSize(t *testing.T) {
	// Verbatim port of VIS_LANG_BY_EXT (draht-tools.cjs:1245-1254).
	//
	// NOTE: the design doc's file-by-file breakdown claims "39 entries", but
	// counting the actual literal in draht-tools.cjs:1245-1254 (verified by
	// direct read, not by the doc's prose) gives exactly 34 key:value pairs.
	// This table is a verbatim transcription of that literal, so 34 is
	// correct; trust the source over the doc's summary count.
	if got, want := len(LangByExt), 34; got != want {
		t.Errorf("len(LangByExt) = %d, want %d", got, want)
	}
}

func TestIsCodeLang(t *testing.T) {
	for _, l := range CodeLangs {
		if !IsCodeLang(l) {
			t.Errorf("IsCodeLang(%q) = false, want true", l)
		}
	}
	if len(CodeLangs) != 14 {
		t.Errorf("len(CodeLangs) = %d, want 14", len(CodeLangs))
	}
	nonCode := []Lang{LangOther, "markdown", "json", "yaml", "toml", "html", "css", "scss", "sql"}
	for _, l := range nonCode {
		if IsCodeLang(l) {
			t.Errorf("IsCodeLang(%q) = true, want false", l)
		}
	}
}

func TestCodeExts(t *testing.T) {
	exts := CodeExts()
	if len(exts) == 0 {
		t.Fatal("CodeExts() returned no extensions")
	}
	seen := make(map[string]bool)
	for _, e := range exts {
		if seen[e] {
			t.Errorf("CodeExts() returned duplicate %q", e)
		}
		seen[e] = true
		lang, ok := LangByExt[e]
		if !ok || !IsCodeLang(lang) {
			t.Errorf("CodeExts() returned %q, but LangByExt[%q]=%q IsCodeLang=%v", e, e, lang, ok && IsCodeLang(lang))
		}
	}
	// Every code-lang extension in LangByExt must appear.
	for ext, lang := range LangByExt {
		if IsCodeLang(lang) && !seen[ext] {
			t.Errorf("CodeExts() missing %q (lang %q)", ext, lang)
		}
	}
	// Non-code extensions must be absent.
	if seen[".md"] || seen[".json"] {
		t.Errorf("CodeExts() leaked a non-code extension: %v", exts)
	}
	// Determinism: sorted ascending.
	for i := 1; i < len(exts); i++ {
		if exts[i-1] >= exts[i] {
			t.Errorf("CodeExts() not sorted ascending: %v", exts)
			break
		}
	}
}
