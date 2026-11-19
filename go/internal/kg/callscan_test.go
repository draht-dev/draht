package kg

import (
	"math/rand"
	"testing"
)

// The scanners must agree with the regexes they stand in for, on every input.
func TestCallScannersMatchRegexes(t *testing.T) {
	pieces := []string{"a", "b1", "Foo", "$", "_x", "#", ".", ".", " ", "(", "(", ")", "9", ",", "\t", "=", " ", "é", "new ", "this", "x.y", "\r"}
	rng := rand.New(rand.NewSource(1))
	for n := 0; n < 200000; n++ {
		var s []rune
		for k := rng.Intn(14); k >= 0; k-- {
			s = append(s, []rune(pieces[rng.Intn(len(pieces))])...)
		}
		var want []callHit
		for m := range reCallCall.Iter(s, 0) {
			want = append(want, callHit{m.Index(), m.S(1)})
		}
		got := scanCalls(s)
		if len(got) != len(want) {
			t.Fatalf("calls %q: got %v want %v", string(s), got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("calls %q: got %v want %v", string(s), got, want)
			}
		}
		var wantNs []nsHit
		for m := range reCallNs.Iter(s, 0) {
			wantNs = append(wantNs, nsHit{m.Index(), m.S(1), m.S(2)})
		}
		gotNs := scanNsCalls(s)
		if len(gotNs) != len(wantNs) {
			t.Fatalf("ns %q: got %v want %v", string(s), gotNs, wantNs)
		}
		for i := range gotNs {
			if gotNs[i] != wantNs[i] {
				t.Fatalf("ns %q: got %v want %v", string(s), gotNs, wantNs)
			}
		}
	}
}
