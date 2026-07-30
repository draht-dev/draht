package query

import (
	"bytes"
	"reflect"
	"testing"
)

func TestParseArgs_BasicSplit(t *testing.T) {
	a := ParseArgs([]string{"foo.ts", "--json", "bar.ts"})
	if !reflect.DeepEqual(a.Files, []string{"foo.ts", "bar.ts"}) {
		t.Errorf("Files = %v", a.Files)
	}
	if !a.Bool("json") {
		t.Error("Bool(json) = false, want true")
	}
}

func TestParseArgs_SingleVsDoubleDash(t *testing.T) {
	a := ParseArgs([]string{"-json"})
	if !a.Bool("json") {
		t.Error("-json should key as \"json\"")
	}
	b := ParseArgs([]string{"---json"})
	if !b.Bool("-json") {
		t.Errorf("---json should key as \"-json\" (one \"--\" stripped), flags=%v", b.Flags)
	}
}

func TestParseArgs_NegativeNumberIsAFlagNotAFile(t *testing.T) {
	a := ParseArgs([]string{"foo.ts", "-3"})
	if !reflect.DeepEqual(a.Files, []string{"foo.ts"}) {
		t.Errorf("Files = %v, want just [foo.ts] (-3 must be treated as a flag)", a.Files)
	}
	if !a.Bool("3") {
		t.Errorf("flag \"3\" should be recorded as boolean-true, flags=%v", a.Flags)
	}
}

// TestParseArgs_ValueFlagConsumesNextTokenUnconditionally locks in the
// verified (via `node -e`) CJS behaviour: `--depth -3` assigns
// flags.depth="-3" — the "-3" is NOT re-parsed as its own flag, because the
// value-flag consumption is unconditional (`flags[key] = args[++i]`). This
// contradicts a naive reading of "-3 looks like a flag" but matches the
// actual interpreter loop: i is advanced past the consumed token before the
// outer loop's next iteration.
func TestParseArgs_ValueFlagConsumesNextTokenUnconditionally(t *testing.T) {
	a := ParseArgs([]string{"foo.ts", "--depth", "-3"}, "depth")
	fv, ok := a.Flags["depth"]
	if !ok || !fv.HasVal || fv.Value != "-3" {
		t.Errorf("flags[depth] = %+v, ok=%v, want Value=-3 HasVal=true", fv, ok)
	}
	if !reflect.DeepEqual(a.Files, []string{"foo.ts"}) {
		t.Errorf("Files = %v, want [foo.ts] (\"-3\" must be consumed, not left as a separate flag/file)", a.Files)
	}
}

func TestParseArgs_ValueFlagAtEndOfArgv(t *testing.T) {
	a := ParseArgs([]string{"foo.ts", "--depth"}, "depth")
	if got := a.IntOr("depth", 1); got != 1 {
		t.Errorf("IntOr(depth, 1) = %d, want 1 (undefined value -> NaN -> default)", got)
	}
}

func TestArgs_IntOr(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want int
	}{
		{"missing", []string{"foo.ts"}, 1},
		{"zero_is_falsy", []string{"foo.ts", "--depth", "0"}, 1},
		{"valid", []string{"foo.ts", "--depth", "2"}, 2},
		{"nan", []string{"foo.ts", "--depth", "abc"}, 1},
		{"negative_then_clamped_by_caller", []string{"foo.ts", "--depth", "-3"}, -3}, // IntOr itself does NOT clamp; max(1, ...) is the caller's job
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := ParseArgs(c.argv, "depth")
			if got := a.IntOr("depth", 1); got != c.want {
				t.Errorf("IntOr(depth, 1) = %d, want %d", got, c.want)
			}
		})
	}
}

// TestCallDir_DepthNegativeThreeEndsUpAsOne exercises the full callDir path
// (IntOr + the caller's max(1, ...) clamp) to confirm --depth -3 behaves
// identically to --depth being entirely absent, per the spec's risk note
// (the mechanism differs slightly from the note's literal claim — "-3" IS
// parsed as depth's value, not silently dropped — but the clamp yields the
// same observable result: depth=1).
func TestCallDir_DepthNegativeThreeEndsUpAsOne(t *testing.T) {
	m := loadGoldenMap(t)
	var withNeg, without bytes.Buffer
	Callers(m, []string{"packages/agent/src/harness/env/nodejs.ts", "--depth", "-3"}, &withNeg)
	Callers(m, []string{"packages/agent/src/harness/env/nodejs.ts"}, &without)
	if withNeg.String() != without.String() {
		t.Errorf("--depth -3 output differs from omitted --depth:\n--depth -3: %q\nomitted:    %q", withNeg.String(), without.String())
	}
}
