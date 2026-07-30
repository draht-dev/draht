package query

import "testing"

func TestLenUTF16(t *testing.T) {
	cases := []struct {
		s    string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"café", 4},
		// U+1F600 (grinning face) is outside the BMP: 2 UTF-16 code units,
		// but a single Go rune / 4 UTF-8 bytes.
		{"😀", 2},
		{"a😀b", 4},
	}
	for _, c := range cases {
		if got := LenUTF16(c.s); got != c.want {
			t.Errorf("LenUTF16(%q) = %d, want %d", c.s, got, c.want)
		}
	}
}

func TestSliceUTF16(t *testing.T) {
	cases := []struct {
		s    string
		n    int
		want string
	}{
		{"hello world", 5, "hello"},
		{"hello", 100, "hello"},
		{"hello", 0, ""},
		{"café", 3, "caf"},
	}
	for _, c := range cases {
		if got := SliceUTF16(c.s, c.n); got != c.want {
			t.Errorf("SliceUTF16(%q, %d) = %q, want %q", c.s, c.n, got, c.want)
		}
	}
}

func TestLessJS(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"a", "b", true},
		{"b", "a", false},
		{"a", "a", false},
		{"abc", "abd", true},
		{"ab", "abc", true}, // shorter prefix sorts first
	}
	for _, c := range cases {
		if got := LessJS(c.a, c.b); got != c.want {
			t.Errorf("LessJS(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestLowerJS(t *testing.T) {
	if got := LowerJS("TYPES"); got != "types" {
		t.Errorf("LowerJS(TYPES) = %q, want types", got)
	}
}

// TestToFixed1 pins values captured directly from V8 (node -e), including
// the classic 0.15 tie that rounds DOWN because 0.15's actual binary64
// value is fractionally below the decimal 0.15 — a naive x*10 rounded to
// nearest would get this wrong.
func TestToFixed1(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{400 * 1.5, 600},
		{0.15, 0.1},
		{-0.15, -0.1},
		{2.25, 2.3},
		{1.05, 1.1},
		{58.5, 58.5},
		{136.5, 136.5},
		{253.5, 253.5},
		{0, 0},
		{400, 400},
	}
	for _, c := range cases {
		if got := ToFixed1(c.in); got != c.want {
			t.Errorf("ToFixed1(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestStem(t *testing.T) {
	// Captured verbatim from `s.replace(/(ing|tion|ed|s)$/, "")` in node.
	cases := map[string]string{
		"compaction": "compac",
		"testing":    "test",
		"tested":     "test",
		"types":      "type",
		"session":    "session",
		"token":      "token",
		"reduction":  "reduc",
		"boxes":      "boxe",
		"ping":       "p",
		"ed":         "",
		"s":          "",
		"tion":       "",
		"ings":       "ing",
		"abcstion":   "abcs",
		"xtion":      "x",
		"xxing":      "xx",
		"ab":         "ab",
		"xyz":        "xyz",
	}
	for in, want := range cases {
		if got := stem(in); got != want {
			t.Errorf("stem(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseIntJS(t *testing.T) {
	cases := []struct {
		s      string
		want   int
		wantOK bool
	}{
		{"2", 2, true},
		{"0", 0, true},
		{"-3", -3, true},
		{"+3", 3, true},
		{"abc", 0, false},
		{"", 0, false},
		{"  42", 42, true},
		{"42abc", 42, true},
		{"--json", 0, false}, // leading "-", then a non-digit '-': no digits consumed
	}
	for _, c := range cases {
		got, ok := parseIntJS(c.s)
		if got != c.want || ok != c.wantOK {
			t.Errorf("parseIntJS(%q) = (%d, %v), want (%d, %v)", c.s, got, ok, c.want, c.wantOK)
		}
	}
}
