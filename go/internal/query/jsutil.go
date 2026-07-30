package query

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

// LenUTF16 reproduces JavaScript's String.prototype.length: the number of
// UTF-16 code units, not bytes and not runes. graph-query's `terms ≥3 chars`
// gate and its sort tiebreak on `a.path.length` are both defined in terms of
// this length.
func LenUTF16(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2 // surrogate pair
		} else {
			n++
		}
	}
	return n
}

// SliceUTF16 reproduces JavaScript's `s.slice(0, n)`: truncate to the first
// n UTF-16 code units. Used for doc.slice(0,60) and text.slice(0,40). A
// truncation that lands inside a surrogate pair mirrors JS's own behaviour
// of keeping the lone (unpaired) surrogate half — utf16.Decode replaces an
// unpaired surrogate with U+FFFD, which is an accepted, documented
// divergence for the vanishingly rare case of astral-plane text landing
// exactly on the truncation boundary.
func SliceUTF16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	units := utf16.Encode([]rune(s))
	if n >= len(units) {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// LessJS reports whether s1 < s2 under JavaScript's relational string
// comparison: lexicographic order over UTF-16 code units. This differs from
// Go's `<` (byte-wise over UTF-8) for astral-plane characters and for any
// character above U+FFFF interleaved with surrogate-range comparisons.
func LessJS(s1, s2 string) bool {
	u1 := utf16.Encode([]rune(s1))
	u2 := utf16.Encode([]rune(s2))
	n := len(u1)
	if len(u2) < n {
		n = len(u2)
	}
	for i := 0; i < n; i++ {
		if u1[i] != u2[i] {
			return u1[i] < u2[i]
		}
	}
	return len(u1) < len(u2)
}

// LowerJS reproduces JavaScript's String.prototype.toLowerCase(): a
// locale-independent, simple Unicode case conversion. Go's strings.ToLower
// performs the same class of mapping (unicode.ToLower per rune, no locale)
// and matches JS's default (non-"Locale") toLowerCase for the overwhelming
// majority of inputs; both are "simple" (not full/special) case foldings.
// Known, accepted divergence: a handful of codepoints where Unicode's
// SpecialCasing.txt full-fold differs from the simple 1:1 mapping (e.g.
// certain Cherokee/Georgian ranges); graph-query's search terms are
// overwhelmingly ASCII identifiers, so this is not exercised in practice.
func LowerJS(s string) string {
	return strings.ToLower(s)
}

// ToFixed1 replicates the JavaScript expression `+x.toFixed(1)`: round x to
// the nearest value representable with 1 fractional decimal digit, ties
// broken toward the larger magnitude-preserving integer (ECMA-262
// Number.prototype.toFixed: "if there are two such n, pick the larger n"),
// computed on the exact binary value of x (via math/big.Rat) rather than a
// lossy decimal approximation — this is what lets it agree with V8 even
// when x*10 lands exactly on a .5 boundary in binary. Mirrors
// model.ToFixed2, scaled for 1 decimal place instead of 2.
func ToFixed1(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}

	r := new(big.Rat).SetFloat64(x)
	if r == nil {
		return x
	}

	scaled := new(big.Rat).Mul(r, big.NewRat(10, 1))
	num := scaled.Num()
	den := scaled.Denom()

	q, rem := new(big.Int), new(big.Int)
	q.DivMod(num, den, rem)

	if rem.Sign() != 0 {
		twiceRem := new(big.Int).Lsh(rem, 1)
		if twiceRem.Cmp(den) >= 0 {
			q.Add(q, big.NewInt(1))
		}
	}

	neg := q.Sign() < 0
	abs := new(big.Int).Abs(q)
	ten := big.NewInt(10)
	intPart, fracPart := new(big.Int), new(big.Int)
	intPart.DivMod(abs, ten, fracPart)

	s := fmt.Sprintf("%s.%01d", intPart.String(), fracPart.Int64())
	if neg {
		s = "-" + s
	}

	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return x
	}
	return f
}

// parseIntJS reproduces JavaScript's parseInt(s, 10): skip leading Unicode
// whitespace, consume an optional sign, then consume decimal digits until a
// non-digit; if zero digits were consumed, the result is NaN (ok=false).
// Trailing non-digit characters are ignored, exactly like parseInt (unlike
// strconv.Atoi, which rejects them). Overflow beyond int is not a concern
// for this package's only two callers (--depth / --limit).
func parseIntJS(s string) (int, bool) {
	s = strings.TrimLeftFunc(s, unicode.IsSpace)
	i, n := 0, len(s)
	sign := 1
	if i < n && (s[i] == '+' || s[i] == '-') {
		if s[i] == '-' {
			sign = -1
		}
		i++
	}
	start := i
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	val, err := strconv.Atoi(s[start:i])
	if err != nil {
		return 0, false
	}
	return sign * val, true
}
