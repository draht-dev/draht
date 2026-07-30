// Package serve ports `draht-tools map-serve` (draht-tools.cjs:5161-5304):
// a loopback-only HTTP server for MAP.html/MAP.json with SSE-driven live
// reload on source changes.
package serve

import (
	"regexp"
	"strconv"
	"time"
)

// Options is map-serve's parsed flag set (defaults per cjs:5161-5169).
type Options struct {
	Port        int
	OpenBrowser bool
	MaxRetries  int
	MaxClients  int
	Debounce    time.Duration
	PingEvery   time.Duration
}

// allDigitsRe matches a bare positional port argument (cjs: /^\d+$/).
var allDigitsRe = regexp.MustCompile(`^\d+$`)

// ParseOptions ports map-serve's arg loop verbatim:
//
//	if (a === "--port" || a === "-p") port = parseInt(args[++i], 10) || port;
//	else if (a === "--open") openBrowser = true;
//	else if (a === "--no-open") openBrowser = false;
//	else if (/^\d+$/.test(a)) port = parseInt(a, 10);
//
// "--port"/"-p" unconditionally consumes the next token (even past the end
// of argv, where there is nothing to consume); a value that fails to parse
// as an integer, or is <= 0 (JS `parseInt(...) || port` treats 0 as falsy
// too), leaves the port unchanged. Later flags win over earlier ones.
func ParseOptions(argv []string) Options {
	o := Options{
		Port:        4878,
		OpenBrowser: false,
		MaxRetries:  10,
		MaxClients:  64,
		Debounce:    400 * time.Millisecond,
		PingEvery:   25 * time.Second,
	}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch {
		case a == "--port" || a == "-p":
			i++
			if i < len(argv) {
				if n, err := strconv.Atoi(argv[i]); err == nil && n != 0 {
					o.Port = n
				}
			}
		case a == "--open":
			o.OpenBrowser = true
		case a == "--no-open":
			o.OpenBrowser = false
		case allDigitsRe.MatchString(a):
			if n, err := strconv.Atoi(a); err == nil {
				o.Port = n
			}
		}
	}
	return o
}
