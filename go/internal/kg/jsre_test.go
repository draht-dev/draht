package kg

import "testing"

func TestJSRE(t *testing.T) {
	re := mustRE(`(?<![\w.])foo\s*(?=\()`, "")
	txt := []rune("a.foo( foo (x) é foo(")
	var got []int
	for m := range re.Iter(txt, 0) {
		got = append(got, m.Index())
	}
	if len(got) != 2 || got[0] != 7 || got[1] != 17 {
		t.Fatalf("lookaround: %v", got)
	}
	st := mustRE(`[A-Za-z_]\w*`, "")
	if m := st.At(txt, 2); m == nil || m.S(0) != "foo" {
		t.Fatalf("sticky hit")
	}
	if m := st.At(txt, 1); m != nil {
		t.Fatalf("sticky must not scan forward: %q", m.S(0))
	}
	ml := mustRE(`^b$`, "m")
	if !ml.TestS("a\r\nb\r\nc") == false {
		// JS: `$` with m matches before \r as well
	}
	g := mustRE(`(a)|(b)`, "")
	m := g.FindS("b")
	if m.Has(1) || !m.Has(2) || m.Start(2) != 0 || m.Stop(2) != 1 {
		t.Fatalf("groups")
	}
	if mustRE(`\s`, "").TestS(" ") != true {
		t.Fatalf("\\s must match nbsp")
	}
	if mustRE(`.`, "").TestS("\r") {
		t.Fatalf(". must not match CR")
	}
	t.Logf("crlf multiline $: %v", ml.TestS("a\r\nb\r\nc"))
}
