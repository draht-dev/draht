package extract

import (
	"regexp"
	"sync"

	"github.com/draht-dev/draht/go/internal/parse"
)

// jsWhitespaceClass mirrors JS `\s` inside a call-site regex: Go RE2's `\s`
// is only `[\t\n\f\r ]`, missing several JS-recognized whitespace code
// points (draht-tools.cjs:2317/2319's `\s*`).
const jsWhitespaceClass = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*`

// callSiteMaxCount caps ScanCallSites' per-local match count
// (draht-tools.cjs:2316 `if (count > 100) break`, which stops counting
// after the 101st match).
const callSiteMaxCount = 101

// CallSite is one import-local's call-site statistics for a single file.
type CallSite struct {
	Local  string `json:"l"`
	Count  int    `json:"c"`
	Direct bool   `json:"d"`
}

// callRegexEscape ports `/[.*+?^${}()|[\]\\]/g` — the character class of
// regex metacharacters draht-tools.cjs escapes before building a per-local
// call-site regex.
var callRegexEscape = regexp.MustCompile(`[.*+?^${}()|[\]\\]`)

func escapeForCallRegex(name string) string {
	return callRegexEscape.ReplaceAllString(name, `\$0`)
}

// compiledCallRegex is one local name's pair of compiled patterns: `call`
// matches a direct OR single-member call (`name(` / `name.member(`);
// `direct` matches only a direct call (`name(`), used to distinguish
// INFERRED from AMBIGUOUS confidence.
type compiledCallRegex struct {
	call, direct *regexp.Regexp
}

// callRegexCache amortizes regex compilation across files: local names
// (import bindings) recur heavily across a real repo's file set, and
// compiling two regexes per (file x local) is measurably wasteful (spec's
// own risk note: ~25k compiles on this repo without caching). Safe for
// concurrent use by extractAll's worker pool.
var callRegexCache sync.Map // string -> *compiledCallRegex

func compileCallRegex(local string) *compiledCallRegex {
	if v, ok := callRegexCache.Load(local); ok {
		return v.(*compiledCallRegex)
	}
	safe := escapeForCallRegex(local)
	c := &compiledCallRegex{
		call:   regexp.MustCompile(`\b` + safe + jsWhitespaceClass + `(?:\.[A-Za-z_$][\w$]*` + jsWhitespaceClass + `)?\(`),
		direct: regexp.MustCompile(`\b` + safe + jsWhitespaceClass + `\(`),
	}
	actual, _ := callRegexCache.LoadOrStore(local, c)
	return actual.(*compiledCallRegex)
}

// ScanCallSites is the port of cjs:2310-2325's regex loop: for each of
// locals (any order; duplicates are harmless but wasteful — callers should
// dedupe via CallLocals), count call-site occurrences in content (RAW,
// unstripped source — cjs:2311 reads `file.content` directly, comments and
// strings included by design) up to callSiteMaxCount, and report whether at
// least one was a DIRECT call (`name(`) as opposed to only member calls
// (`name.member(`). A local with zero matches is omitted from the result,
// mirroring the CJS `if (count > 0) push`.
func ScanCallSites(content []byte, locals []string) []CallSite {
	if len(locals) == 0 {
		return nil
	}
	text := string(content)
	out := make([]CallSite, 0, len(locals))
	for _, local := range locals {
		if local == "" {
			continue
		}
		re := compileCallRegex(local)
		count := len(re.call.FindAllStringIndex(text, callSiteMaxCount))
		if count == 0 {
			continue
		}
		out = append(out, CallSite{Local: local, Count: count, Direct: re.direct.MatchString(text)})
	}
	return out
}

// CallLocals returns the ordered, deduplicated set of "used local" names a
// file's own parsed imports introduce (draht-tools.cjs:2302-2307's local-name
// half): default/namespace/named-import bindings, skipping re-export
// imports entirely (a barrel introduces no local usage). This runs BEFORE
// cross-file specifier resolution — it deliberately includes locals from
// imports that later turn out to be unresolved/external, a harmless
// superset the assemble stage filters down via the real, resolved
// UsedLocal list (see internal/graph.CollectUsedLocals).
func CallLocals(imports []parse.Import) []string {
	var order []string
	seen := make(map[string]struct{})
	add := func(local string) {
		if local == "" {
			return
		}
		if _, ok := seen[local]; ok {
			return
		}
		seen[local] = struct{}{}
		order = append(order, local)
	}
	for _, imp := range imports {
		if imp.Kind == parse.KindReExport {
			continue
		}
		if imp.Default != "" {
			add(imp.Default)
		}
		if imp.Namespace != "" {
			add(imp.Namespace)
		}
		for _, n := range imp.Names {
			local := n.Local
			if local == "" {
				local = n.Imported
			}
			add(local)
		}
	}
	return order
}
