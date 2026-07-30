package cluster

import "testing"

func TestSeed(t *testing.T) {
	cases := []struct {
		id    string
		depth int
		want  string
	}{
		{"a/b/c/d/mod.ts", 4, "a/b/c/d"},
		{"a/b/mod.ts", 4, "a/b"},
		{"mod.ts", 4, ""}, // root-level file, no "/"
		{"a/b/c/d/e/f/mod.ts", 2, "a/b"},
		{"a//b/mod.ts", 4, "a/b"}, // empty segment filtered
	}
	for _, tc := range cases {
		if got := Seed(tc.id, tc.depth); got != tc.want {
			t.Errorf("Seed(%q, %d) = %q, want %q", tc.id, tc.depth, got, tc.want)
		}
	}
}

func TestLongestCommonDirPrefix(t *testing.T) {
	cases := []struct {
		name    string
		members []string
		want    string
	}{
		{
			"shared prefix",
			[]string{"a/b/c/x.ts", "a/b/c/y.ts", "a/b/c/d/z.ts"},
			"a/b/c",
		},
		{
			"partial divergence",
			[]string{"a/b/x.ts", "a/c/y.ts"},
			"a",
		},
		{
			"no common prefix",
			[]string{"a/x.ts", "b/y.ts"},
			"",
		},
		{
			"single member",
			[]string{"a/b/c/x.ts"},
			"a/b/c",
		},
		{
			"root-level member forces empty prefix",
			[]string{"a/b/x.ts", "root.ts"},
			"",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := LongestCommonDirPrefix(tc.members); got != tc.want {
				t.Errorf("LongestCommonDirPrefix(%v) = %q, want %q", tc.members, got, tc.want)
			}
		})
	}
}
