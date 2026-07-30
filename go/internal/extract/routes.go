package extract

import (
	"regexp"
	"strings"
)

// routePattern is one route detector entry.
type routePattern struct {
	Re        *regexp.Regexp
	MethodIdx int
	PathIdx   int
}

// RoutePatterns is the 2-entry route detector table, verbatim from
// ROUTE_PATTERNS (draht-tools.cjs:1556-1559). Backtick is included in the
// quote-character class alongside `"`/`'` (template-literal route paths);
// it cannot appear inside a Go raw string literal, so these two patterns are
// built via string concatenation instead.
var RoutePatterns = []routePattern{
	{
		regexp.MustCompile(`(?i)\b(?:app|router|server|fastify|hono|api)\s*\.\s*(get|post|put|delete|patch|all|use|options|head)\s*\(\s*["'` + "`" + `]([^"'` + "`" + `]+)["'` + "`" + `]`),
		1, 2,
	},
	{
		regexp.MustCompile(`@(Get|Post|Put|Delete|Patch|All)\s*\(\s*["'` + "`" + `]([^"'` + "`" + `]+)["'` + "`" + `]\s*\)`),
		1, 2,
	},
}

// DetectRoutes scans STRIPPED content for HTTP route declarations
// (uppercase method, 40-entry break). Verbatim port of visDetectRoutes
// (draht-tools.cjs:1560-1570).
func DetectRoutes(stripped []byte) []Route {
	var out []Route
	for _, rp := range RoutePatterns {
		for _, m := range rp.Re.FindAllStringSubmatch(string(stripped), -1) {
			out = append(out, Route{Method: strings.ToUpper(m[rp.MethodIdx]), Path: m[rp.PathIdx]})
			if len(out) > 40 {
				break
			}
		}
	}
	return out
}
