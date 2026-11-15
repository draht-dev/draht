package parse

import (
	"strings"
	"testing"
)

func TestStripComments(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string
	}{
		{
			name: "line comment",
			src:  "const x = 1; // trailing\n",
			want: "const x = 1; \n",
		},
		{
			name: "block comment spanning lines",
			src:  "a();\n/* multi\nline */\nb();\n",
			want: "a();\n\nb();\n",
		},
		{
			name: "url scheme is not a line comment",
			src:  `const url = "https://example.com";` + "\n",
			want: `const url = "https://example.com";` + "\n",
		},
		{
			name: "string containing /* is corrupted through to the next */ (verbatim CJS quirk)",
			src:  "const s = \"/*\";\nreal();\n*/\nlost();\n",
			want: "const s = \"\nlost();\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(StripComments([]byte(tc.src), "typescript"))
			if got != tc.want {
				t.Errorf("StripComments(%q) = %q, want %q", tc.src, got, tc.want)
			}
		})
	}
}

func TestMaskNonCode(t *testing.T) {
	// blank lists, in source order, the exact substrings that must come back as
	// spaces (newlines inside them survive); everything else must be untouched.
	cases := []struct {
		name  string
		src   string
		blank []string
	}{
		{
			name:  "string contents are blanked, delimiters kept",
			src:   "const p = \"src/*.ts\";\nexport { a };",
			blank: []string{"src/*.ts"},
		},
		{
			name:  "/* inside a string no longer swallows real code",
			src:   "const g = \"packages/*/src\";\nexport { a, b };\nconst h = \"**/*.ts\";\n",
			blank: []string{"packages/*/src", "**/*.ts"},
		},
		{
			name:  "comments are blanked entirely, newlines kept",
			src:   "// export { c } from \"./x\"\n/* export { d }\n   from \"./x\" */ export { e };",
			blank: []string{"// export { c } from \"./x\"", "/* export { d }\n   from \"./x\" */"},
		},
		{
			name:  "template text is blanked, ${} expression code kept (nested)",
			src:   "x = `\nexport { fake };\n${ a + `in ${b}` + \"s\" } tail`;\nexport { real };",
			blank: []string{"\nexport { fake };\n", "in ", "s", " tail"},
		},
		{
			name:  "regex literal body blanked, a slash in a class does not end it",
			src:   "const r = /[\"'`/*]+/g; export { y };",
			blank: []string{"[\"'`/*]+"},
		},
		{
			name:  "division is not a regex",
			src:   "let q = a / 2 / 3; export { z };",
			blank: nil,
		},
		{
			name:  "unterminated string ends at the line break",
			src:   "x = 'oops\nexport { a };",
			blank: []string{"oops"},
		},
		{
			name:  "escaped quote does not end the string",
			src:   "s = \"a\\\"export { x }\";\nexport { b };",
			blank: []string{"a\\\"export { x }"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := tc.src
			from := 0
			for _, b := range tc.blank {
				at := strings.Index(want[from:], b)
				if at < 0 {
					t.Fatalf("test bug: %q not found in %q", b, want[from:])
				}
				at += from
				blanked := strings.Map(func(r rune) rune {
					if r == '\n' {
						return r
					}
					return ' '
				}, b)
				want = want[:at] + blanked + want[at+len(b):]
				from = at + len(b)
			}
			got := string(MaskNonCode([]byte(tc.src), "typescript"))
			if got != want {
				t.Errorf("MaskNonCode =\n%q\nwant\n%q", got, want)
			}
			if len(got) != len(tc.src) {
				t.Errorf("length changed: %d -> %d", len(tc.src), len(got))
			}
		})
	}
}
