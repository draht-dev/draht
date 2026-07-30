package query

import "strings"

// FlagVal is one parsed flag's value. A boolean flag (e.g. --json) has
// HasVal=false and Value="". A value-flag (one of the command's valueFlags,
// e.g. --depth) has HasVal=true; Value is "" both when the flag's value is
// the empty string AND when the flag was the last token in argv (the CJS
// `args[++i]` reads past the end of the array, i.e. JS `undefined` — see
// ParseArgs doc). Both cases parse to NaN under parseIntJS, so callers never
// need to distinguish them.
type FlagVal struct {
	Value  string
	HasVal bool
}

// Args is graphParseArgs' return value: positional file arguments plus a
// flag map keyed by the de-dashed flag name.
type Args struct {
	Files []string
	Flags map[string]FlagVal
}

// Bool reports whether key was passed as a (boolean) flag at all — i.e.
// `flags[key]` is JS-truthy. Every graph-* boolean flag (--json,
// --surprising) is checked this way; presence in the map is sufficient
// since ParseArgs only ever records `true` for a non-value flag.
func (a Args) Bool(key string) bool {
	_, ok := a.Flags[key]
	return ok
}

// IntOr reproduces the JS expression `parseInt(flags[key], 10) || def`:
// parseInt's decimal parse of the flag's raw string value, falling back to
// def when the flag is absent, unparseable (NaN), OR parses to exactly 0
// (JS falsy). It deliberately does NOT clamp to a minimum — every CJS call
// site applies its own `Math.max(1, ...)` on top of this, and callers here
// must do the same (see calldir.go's depth, hotspots.go's limit).
func (a Args) IntOr(key string, def int) int {
	fv, ok := a.Flags[key]
	if !ok {
		return def
	}
	n, ok := parseIntJS(fv.Value)
	if !ok || n == 0 {
		return def
	}
	return n
}

// ParseArgs ports graphParseArgs (draht-tools.cjs:5344-5354). Any argv token
// starting with "-" is treated as a flag, never a positional file — this
// includes negative numbers and repeated dashes. A leading "-" or "--" (but
// never more) is stripped from the token to form the flag key: "--json" and
// "-json" both key as "json"; "---json" keys as "-json" (only one
// "-"/"--" prefix is ever stripped, matching the CJS's single
// non-global regex replace). A key listed in valueFlags consumes the very
// next argv token as its value, unconditionally — even if that token itself
// looks like a flag (see args_test.go for the `--depth -3` case, which
// still assigns Value="-3": it does NOT fall through to being parsed as its
// own flag).
func ParseArgs(argv []string, valueFlags ...string) Args {
	files := []string{}
	flags := map[string]FlagVal{}
	isValueFlag := func(k string) bool {
		for _, vf := range valueFlags {
			if vf == k {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if !strings.HasPrefix(a, "-") {
			files = append(files, a)
			continue
		}
		key := stripLeadingDashes(a)
		if isValueFlag(key) {
			if i+1 < len(argv) {
				i++
				flags[key] = FlagVal{Value: argv[i], HasVal: true}
			} else {
				// args[++i] runs off the end of argv (JS: undefined). The
				// outer loop's i++ then also runs past len(argv), ending
				// the loop, exactly as the CJS's shared i does.
				i++
				flags[key] = FlagVal{Value: "", HasVal: true}
			}
		} else {
			flags[key] = FlagVal{Value: "", HasVal: false}
		}
	}
	return Args{Files: files, Flags: flags}
}

// stripLeadingDashes replicates `a.replace(/^--?/, "")`: remove exactly one
// leading "--" if present, else exactly one leading "-".
func stripLeadingDashes(a string) string {
	if strings.HasPrefix(a, "--") {
		return a[2:]
	}
	if strings.HasPrefix(a, "-") {
		return a[1:]
	}
	return a
}
