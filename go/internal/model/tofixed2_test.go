package model

import "testing"

func TestToFixed2(t *testing.T) {
	tests := []struct {
		name string
		in   float64
		want float64
	}{
		{"integral value prints without rounding drift", 144, 144},
		{"zero", 0, 0},
		{"exact two decimals already", 293.61, 293.61},
		// packages/ai/src/index.ts: in=144 out=0 loc=48 -> 288 + log2(49) =
		// 293.61470984... (hand-computed reference value from the spec).
		{"godNodes reference sample", 293.6147098443626, 293.61},
		{"rounds down below the half boundary", 1.004, 1.0},
		{"rounds up above the half boundary", 1.005000001, 1.01},
		// 0.615 is NOT exactly representable in binary64: its nearest
		// double is slightly below 0.615, so JS toFixed(2) on it produces
		// 0.61 (round DOWN), not 0.62 — proving this must operate on the
		// exact binary value, not a naive decimal-tie assumption.
		{"binary64 0.615 rounds down (not an exact tie)", 0.615, 0.61},
		// 2.5/100 = 0.025 is also inexact in binary64; its nearest double
		// is slightly above 0.025, so it rounds UP.
		{"binary64 0.025 rounds up (not an exact tie)", 0.025, 0.03},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ToFixed2(tt.in)
			if got != tt.want {
				t.Errorf("ToFixed2(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestToFixed2ExactHalfTieRoundsToLarger(t *testing.T) {
	// 0.125 is exactly representable in binary64 (1/8), so x*100 = 12.5
	// is an EXACT tie between 12 and 13. The spec picks the larger n.
	got := ToFixed2(0.125)
	want := 0.13
	if got != want {
		t.Errorf("ToFixed2(0.125) = %v, want %v (exact-tie round to larger n)", got, want)
	}
}
