package extract

import (
	"bytes"
	"regexp"
	"strings"
)

// sinkPattern is one order-significant sink detector entry.
type sinkPattern struct {
	Kind string
	Re   *regexp.Regexp
}

// SinkPatterns is the order-significant sink detector table (11 entries;
// "ai:call" uses case-insensitive matching), verbatim from SINK_PATTERNS
// (draht-tools.cjs:1533-1545).
var SinkPatterns = []sinkPattern{
	{"fs:write", regexp.MustCompile(`\bfs(?:Promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync|symlink|symlinkSync|chmod|chmodSync)\b`)},
	{"fs:read", regexp.MustCompile(`\bfs(?:Promises)?\.(?:readFile|readFileSync|readdir|readdirSync|stat|statSync|access|accessSync|createReadStream)\b`)},
	{"net:fetch", regexp.MustCompile(`\b(?:fetch|axios\.(?:get|post|put|delete|patch|request)|undici|got\.(?:get|post))\s*\(`)},
	{"net:http", regexp.MustCompile(`\b(?:https?\.request|https?\.get)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b`)},
	{"db:sql", regexp.MustCompile(`\b(?:pool\.query|client\.query|db\.query|knex\(|sequelize\.|pg\.Pool|new\s+Pool|drizzle\()`)},
	{"db:orm", regexp.MustCompile(`\b(?:prisma|mongoose|typeorm|drizzle)\.[\w$]+\.(?:create|update|delete|upsert|findMany|findFirst|findUnique|insertMany|deleteMany|updateMany|aggregate)\b`)},
	{"cli:io", regexp.MustCompile(`\bprocess\.(?:stdout|stderr)\.(?:write|on)\b|\bconsole\.(?:log|error|warn|info)\b`)},
	{"process:exec", regexp.MustCompile(`\b(?:execSync|execFileSync|spawnSync|spawn|execFile|fork)\s*\(`)},
	{"process:exit", regexp.MustCompile(`\bprocess\.exit\s*\(`)},
	{"ai:call", regexp.MustCompile(`(?i)\bnew\s+(?:Anthropic|OpenAI)\s*\(|\b(?:anthropic|openai|claude)\.(?:messages|chat|completions|complete|stream|create|invoke|generate)\b|@anthropic-ai/sdk|@google/generative-ai`)},
	{"env:read", regexp.MustCompile(`\bprocess\.env\.[A-Z_]+`)},
}

var sinkKeywords = map[string]bool{
	"if": true, "else": true, "while": true, "for": true, "switch": true,
	"catch": true, "try": true, "do": true, "return": true, "throw": true,
	"new": true, "await": true, "async": true, "typeof": true, "instanceof": true,
	"void": true, "delete": true, "yield": true, "case": true, "default": true,
	"function": true, "class": true, "const": true, "let": true, "var": true,
}

var (
	sinkFuncDeclRe  = regexp.MustCompile(`^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)`)
	sinkConstFuncRe = regexp.MustCompile(`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)`)
	sinkCallLikeRe  = regexp.MustCompile(`^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]`)
	sinkPyDefRe     = regexp.MustCompile(`^\s*def\s+([A-Za-z_$][\w$]*)`)
	sinkGoFuncRe    = regexp.MustCompile(`^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_$][\w$]*)`)
)

// DetectSinks scans STRIPPED content and returns the deduplicated sink
// kinds in SinkPatterns order (never a map range — see design's
// determinism inventory). Verbatim port of visDetectSinks
// (draht-tools.cjs:1547-1553).
func DetectSinks(stripped []byte) []string {
	var out []string
	for _, sp := range SinkPatterns {
		if sp.Re.Match(stripped) {
			out = append(out, sp.Kind)
		}
	}
	return out
}

// FindSinkSites scans RAW content for up to 2 call sites per sink kind (over
// ALL of SinkPatterns, independent of what DetectSinks found on the
// stripped copy — verbatim CJS behaviour, draht-tools.cjs:1490-1530), with a
// 200-line back-scan for the enclosing function name.
func FindSinkSites(raw []byte) []SinkSite {
	lines := bytes.Split(raw, []byte("\n"))

	lineOf := func(charIdx int) int {
		pos := 0
		for i, l := range lines {
			if pos+len(l)+1 > charIdx {
				return i
			}
			pos += len(l) + 1
		}
		return len(lines) - 1
	}

	findEnclosingFunction := func(lineIdx int) string {
		start := lineIdx - 1
		floor := lineIdx - 200
		if floor < 0 {
			floor = 0
		}
		for i := start; i >= floor; i-- {
			line := string(lines[i])
			if m := sinkFuncDeclRe.FindStringSubmatch(line); m != nil {
				return m[1]
			}
			if m := sinkConstFuncRe.FindStringSubmatch(line); m != nil {
				return m[1]
			}
			if m := sinkCallLikeRe.FindStringSubmatch(line); m != nil {
				if !sinkKeywords[m[1]] {
					return m[1]
				}
			}
			if m := sinkPyDefRe.FindStringSubmatch(line); m != nil {
				return m[1]
			}
			if m := sinkGoFuncRe.FindStringSubmatch(line); m != nil {
				return m[1]
			}
		}
		return ""
	}

	var sites []SinkSite
	for _, sp := range SinkPatterns {
		count := 0
		matches := sp.Re.FindAllIndex(raw, -1)
		for _, m := range matches {
			if count >= 2 {
				break
			}
			lineIdx := lineOf(m[0])
			snippet := ""
			if lineIdx >= 0 && lineIdx < len(lines) {
				snippet = sliceRunes(strings.TrimSpace(string(lines[lineIdx])), 140)
			}
			sites = append(sites, SinkSite{
				Kind:       sp.Kind,
				Line:       lineIdx + 1,
				Snippet:    snippet,
				InFunction: findEnclosingFunction(lineIdx),
			})
			count++
		}
	}
	return sites
}
