package extract

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/parse"
)

func TestExtractExportsTypeScript(t *testing.T) {
	src := []byte(`// A helper that greets.
export function greet(name) {
	return "hi " + name;
}

export const answer = 42;

export { greet as sayHi, answer };

export default class Widget {}
`)
	exports := extractExports("typescript", src)
	names := map[string]Export{}
	for _, e := range exports {
		names[e.Name] = e
	}
	if _, ok := names["greet"]; !ok {
		t.Fatalf("expected export 'greet', got %+v", exports)
	}
	if names["greet"].Doc != "A helper that greets." {
		t.Errorf("expected leading doc comment on greet, got %q", names["greet"].Doc)
	}
	if _, ok := names["answer"]; !ok {
		t.Fatalf("expected export 'answer', got %+v", exports)
	}
	if _, ok := names["sayHi"]; !ok {
		t.Fatalf("expected named re-export alias 'sayHi', got %+v", exports)
	}
	// `export default class Widget {}` matches exportRe's own (class|...)
	// alternative BEFORE defaultRe is even tried (verbatim CJS if/else-if
	// chain, draht-tools.cjs:1432 precedes 1441) — so this yields a "class"
	// export named "Widget", never a distinct "default" entry.
	if _, ok := names["Widget"]; !ok {
		t.Fatalf("expected 'Widget' export (class kind, from 'export default class'), got %+v", exports)
	}
	if names["Widget"].Kind != "class" {
		t.Errorf("expected kind 'class' for Widget, got %q", names["Widget"].Kind)
	}
}

func TestExtractExportsNamedFromIsReExport(t *testing.T) {
	// export { a, b } from "./x" IS part of the barrel's public API: the CJS
	// engine captures it with kind "re-export" (the old (?!\s+from) lookahead
	// deliberately excluded it, which left every barrel with exports(0) —
	// removed in the graphify-parity work). Multi-line blocks and
	// `export * as NS from` are captured too.
	src := []byte(`export { a, b } from "./other";
export {
	c,
	d as e,
} from "./more";
export * as ns from "./star";
`)
	exports := extractExports("typescript", src)
	got := map[string]Export{}
	for _, ex := range exports {
		got[ex.Name] = ex
	}
	for _, name := range []string{"a", "b", "c", "e", "ns"} {
		ex, ok := got[name]
		if !ok {
			t.Fatalf("expected re-export %q captured, got %+v", name, exports)
		}
		if ex.Kind != "re-export" {
			t.Errorf("expected kind 're-export' for %q, got %q", name, ex.Kind)
		}
	}
	if got["c"].Line != 2 {
		t.Errorf("multi-line block should anchor at the block's first line: got %d", got["c"].Line)
	}
	if _, ok := got["d"]; ok {
		t.Errorf("aliased re-export should surface the alias (e), not the source name (d)")
	}
}

func TestExtractExportsDedup(t *testing.T) {
	src := []byte(`export const dup = 1;
export const dup = 2;
`)
	exports := extractExports("typescript", src)
	count := 0
	for _, e := range exports {
		if e.Name == "dup" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one 'dup' export after dedup, got %d", count)
	}
}

func TestExtractExportsGo(t *testing.T) {
	src := []byte(`package foo

// Frobnicate does the thing.
func Frobnicate() {}

type Widget struct{}
`)
	exports := extractExports("go", src)
	found := map[string]bool{}
	for _, e := range exports {
		found[e.Name] = true
	}
	if !found["Frobnicate"] || !found["Widget"] {
		t.Fatalf("expected Frobnicate+Widget exported, got %+v", exports)
	}
}

func TestBuildSymbolsIncludesExportedAndNonExported(t *testing.T) {
	src := []byte(`export function pub() {}

function priv() {}
`)
	exports := extractExports("typescript", src)
	syms := buildSymbols("typescript", src, exports, false)

	var sawPub, sawPriv bool
	for _, s := range syms {
		if s.Name == "pub" && s.Exported {
			sawPub = true
		}
		if s.Name == "priv" && !s.Exported {
			sawPriv = true
		}
	}
	if !sawPub {
		t.Errorf("expected exported symbol 'pub', got %+v", syms)
	}
	if !sawPriv {
		t.Errorf("expected non-exported symbol 'priv', got %+v", syms)
	}
}

func TestFile_SignaturesAreExtractedOnlyWhenEnabled(t *testing.T) {
	const secret = "file-signature-secret"
	src := []byte(`export function connect(token: string = "file-signature-secret"): void {}`)

	off, err := File(context.Background(), nil, "typescript", "x.ts", src)
	if err != nil {
		t.Fatalf("File signatures off: %v", err)
	}
	if len(off.Symbols) != 1 || off.Symbols[0].Sig != "" {
		t.Fatalf("signatures off extracted declaration text: %+v", off.Symbols)
	}
	offJSON, err := MarshalFacts(off)
	if err != nil {
		t.Fatalf("MarshalFacts(off): %v", err)
	}
	if strings.Contains(string(offJSON), secret) || strings.Contains(string(offJSON), `"sig"`) {
		t.Fatalf("signatures-off facts persisted opt-in data: %s", offJSON)
	}

	on, err := File(context.Background(), nil, "typescript", "x.ts", src, true)
	if err != nil {
		t.Fatalf("File signatures on: %v", err)
	}
	if got, want := on.Symbols[0].Sig, "export function connect(token: string): void"; got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestDetectSinksFsWrite(t *testing.T) {
	src := []byte(`import fs from "node:fs";
fs.writeFileSync("/tmp/x", "y");
`)
	sinks := DetectSinks(src)
	if len(sinks) != 1 || sinks[0] != "fs:write" {
		t.Fatalf("expected [fs:write], got %v", sinks)
	}
}

func TestFindSinkSitesEnclosingFunction(t *testing.T) {
	src := []byte(`function saveIt() {
	fs.writeFileSync("/tmp/x", "y");
}
`)
	sites := FindSinkSites(src)
	if len(sites) == 0 {
		t.Fatal("expected at least one sink site")
	}
	if sites[0].Kind != "fs:write" {
		t.Errorf("expected kind fs:write, got %q", sites[0].Kind)
	}
	if sites[0].InFunction != "saveIt" {
		t.Errorf("expected enclosing function 'saveIt', got %q", sites[0].InFunction)
	}
}

func TestDetectRoutesExpress(t *testing.T) {
	src := []byte(`app.get("/health", (req, res) => res.send("ok"));
`)
	routes := DetectRoutes(src)
	if len(routes) != 1 {
		t.Fatalf("expected 1 route, got %+v", routes)
	}
	if routes[0].Method != "GET" || routes[0].Path != "/health" {
		t.Errorf("expected GET /health, got %+v", routes[0])
	}
}

func TestMarshalUnmarshalFactsRoundTrip(t *testing.T) {
	f := &Facts{
		Loc:     10,
		Exports: []Export{{Name: "x", Kind: "const", Line: 1}},
		Sinks:   []string{"fs:write"},
	}
	b, err := MarshalFacts(f)
	if err != nil {
		t.Fatalf("MarshalFacts: %v", err)
	}
	if len(b) == 0 || b[len(b)-1] == '\n' {
		t.Fatalf("expected non-empty, no-trailing-newline payload, got %q", b)
	}
	got, err := UnmarshalFacts(b)
	if err != nil {
		t.Fatalf("UnmarshalFacts: %v", err)
	}
	if got.Loc != f.Loc || len(got.Exports) != 1 || got.Exports[0].Name != "x" {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestFileIntegrationWithRegexParser(t *testing.T) {
	src := []byte(`import { foo } from "./foo";

export function bar() {
	fs.writeFileSync("/tmp/x", "y");
}
`)
	p := parse.NewRegex()
	defer p.Close()

	facts, err := File(context.Background(), p, "typescript", "bar.ts", src)
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if facts.Loc == 0 {
		t.Errorf("expected non-zero loc, got %d", facts.Loc)
	}
	if len(facts.Imports) != 1 || facts.Imports[0].Specifier != "./foo" {
		t.Fatalf("expected 1 import of ./foo, got %+v", facts.Imports)
	}
	foundBar := false
	for _, e := range facts.Exports {
		if e.Name == "bar" {
			foundBar = true
		}
	}
	if !foundBar {
		t.Errorf("expected export 'bar', got %+v", facts.Exports)
	}
	if len(facts.Sinks) != 1 || facts.Sinks[0] != "fs:write" {
		t.Fatalf("expected sink fs:write, got %v", facts.Sinks)
	}
}

// erroringParser is a parse.Parser whose Extract always fails, used to
// verify File propagates the parser's error instead of silently discarding
// it (the bug found by review: a swallowed error made pipeline.go's
// "extract:" warning branch dead code and let a failed parse get cached as
// "no imports" under a valid content hash).
type erroringParser struct{}

func (erroringParser) Supports(parse.Lang) bool { return true }
func (erroringParser) Extract(context.Context, parse.Lang, string, []byte) (parse.Result, error) {
	return parse.Result{}, errFakeParse
}
func (erroringParser) Version() string { return "erroring/1" }
func (erroringParser) Close() error    { return nil }

var errFakeParse = fmt.Errorf("fake parse failure")

func TestFilePropagatesParserError(t *testing.T) {
	src := []byte(`export const x = 1;
`)
	facts, err := File(context.Background(), erroringParser{}, "typescript", "x.ts", src)
	if err == nil {
		t.Fatal("expected File to return the parser's error, got nil")
	}
	if !errors.Is(err, errFakeParse) {
		t.Errorf("expected wrapped errFakeParse, got %v", err)
	}
	// Non-import facts must still be populated even when imports fail.
	if facts == nil || len(facts.Exports) == 0 {
		t.Errorf("expected exports still populated despite parser error, got %+v", facts)
	}
	if len(facts.Imports) != 0 {
		t.Errorf("expected zero imports on parser error, got %+v", facts.Imports)
	}
}

func TestFileNilParserYieldsNoImports(t *testing.T) {
	src := []byte(`export const x = 1;
`)
	facts, err := File(context.Background(), nil, "typescript", "x.ts", src)
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	if len(facts.Imports) != 0 {
		t.Errorf("expected no imports with a nil parser, got %+v", facts.Imports)
	}
}
