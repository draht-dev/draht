package model

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
)

// ToFixed2 lives in internal/model (not internal/rank, where it originated)
// because both internal/rank (hotspot scores) and internal/container (topFile
// scores) need it, and neither package may depend on the other (see the
// README's Phase 2 dependency diagram: every Phase 2 package depends only on
// model + stdlib). It replaces the old model.Round2 (math.Round(x*100)/100),
// which is NOT equivalent to `+x.toFixed(2)` — e.g. Round2(0.015) = 0.02 but
// +0.015.toFixed(2) = "0.01" (0.015's nearest binary64 value is fractionally
// below the decimal 0.015, and toFixed rounds on the exact binary value).
//
// ToFixed2 emulates the JS expression `+x.toFixed(2)`: round x to the
// nearest value representable with 2 fractional decimal digits, with EXACT
// ties broken toward the LARGER magnitude-preserving integer (the ECMA-262
// Number.prototype.toFixed rule: "if there are two such n, pick the larger
// n"), then reparse the 2-decimal string back to a float64.
//
// This deliberately differs from Go's native strconv.FormatFloat, which
// rounds exact ties to even. The rounding decision is made on the EXACT
// binary value of x (via math/big.Rat, which represents float64 without
// precision loss), not on a lossy decimal approximation, so it agrees with
// V8's toFixed on every input — including cases where x*100 is itself an
// exact .5 boundary in binary.
func ToFixed2(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}

	r := new(big.Rat).SetFloat64(x)
	if r == nil {
		// Unreachable given the NaN/Inf guard above, but stay defensive.
		return x
	}

	scaled := new(big.Rat).Mul(r, big.NewRat(100, 1))
	num := scaled.Num()
	den := scaled.Denom() // always > 0: big.Rat normalizes the sign into Num.

	q, rem := new(big.Int), new(big.Int)
	q.DivMod(num, den, rem) // Euclidean division: 0 <= rem < den, so q == floor(scaled).

	if rem.Sign() != 0 {
		twiceRem := new(big.Int).Lsh(rem, 1)
		if twiceRem.Cmp(den) >= 0 {
			// Strictly closer to the ceiling, OR an exact tie: the spec
			// picks the larger n in both cases.
			q.Add(q, big.NewInt(1))
		}
	}

	neg := q.Sign() < 0
	abs := new(big.Int).Abs(q)
	hundred := big.NewInt(100)
	intPart, fracPart := new(big.Int), new(big.Int)
	intPart.DivMod(abs, hundred, fracPart)

	s := fmt.Sprintf("%s.%02d", intPart.String(), fracPart.Int64())
	if neg {
		s = "-" + s
	}

	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		// Unreachable: s is always a well-formed decimal literal.
		return x
	}
	return f
}
