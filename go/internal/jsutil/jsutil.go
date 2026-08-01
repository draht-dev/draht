// Package jsutil provides string operations with JavaScript semantics.
//
// The knowledge-graph engine is a port of a JavaScript original
// (packages/draht-tools/bin/draht-tools.cjs), and several of its outputs are
// compared byte-for-byte against that engine. JS strings are sequences of
// UTF-16 code units, so `.slice(0, n)` and `.length` count code units — not
// bytes (Go's `len`) and not runes (Go's `[]rune`). For any input outside the
// BMP the three disagree, and the disagreement is silent.
//
// This package exists so those helpers live in exactly one place. It
// deliberately depends on nothing inside this module, so any package may use
// it without creating an import cycle.
package jsutil

import "unicode/utf16"

// SliceUTF16 returns the first n UTF-16 code units of s, decoded back to a Go
// string — the equivalent of JavaScript's s.slice(0, n).
//
// If the cut would land between the halves of a surrogate pair, the trailing
// lone surrogate is dropped rather than emitted, since a lone surrogate is not
// valid UTF-8 and utf16.Decode would replace it with U+FFFD. JS would keep the
// unpaired surrogate; this is the one deliberate divergence, and it only
// affects a cut falling exactly inside an astral character.
func SliceUTF16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(s))
	if n >= len(units) {
		return s
	}
	cut := units[:n]
	if len(cut) > 0 {
		// utf16.Encode emits surrogate pairs as (high, low). A trailing high
		// surrogate means the pair was split by the cut.
		if last := cut[len(cut)-1]; last >= 0xD800 && last <= 0xDBFF {
			cut = cut[:len(cut)-1]
		}
	}
	return string(utf16.Decode(cut))
}

// LenUTF16 returns the number of UTF-16 code units in s — the equivalent of
// JavaScript's s.length. ASCII-only fast path avoids the allocation.
func LenUTF16(s string) int {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return len(s)
	}
	return len(utf16.Encode([]rune(s)))
}
