package parse

import "testing"

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
