package extract

import (
	"strings"
	"testing"
)

func TestSignatureAt(t *testing.T) {
	tests := []struct {
		name string
		lang string
		src  string
		idx  int
		want string
	}{
		{
			name: "ts arrow function keeps params and return type, drops the arrow",
			lang: "typescript",
			src:  "export const capOutlineText = (text: string, limit: number): string =>\n  text.length > limit ? `x` : text",
			want: "export const capOutlineText = (text: string, limit: number): string",
		},
		{
			name: "ts function declaration stops at the body brace",
			lang: "typescript",
			src:  "export function renderLine(item: OutlineItem, depth: number): string {\n  return \"\"\n}",
			want: "export function renderLine(item: OutlineItem, depth: number): string",
		},
		{
			name: "ts const binding keeps its value",
			lang: "typescript",
			src:  "export const OUTLINE_SIGNATURE_CAP = 160",
			want: "export const OUTLINE_SIGNATURE_CAP = 160",
		},
		{
			name: "ts type alias drops the dangling equals",
			lang: "typescript",
			src:  "export type OutlineItemKind =\n  | \"function\"\n  | \"class\"",
			want: "export type OutlineItemKind",
		},
		{
			name: "wrapped parameter list folds back onto one line",
			lang: "typescript",
			src:  "export function outlineItemsFor(\n  source: string,\n  filePath: string,\n): Promise<OutlineItem[]> {",
			want: "export function outlineItemsFor(source: string, filePath: string): Promise<OutlineItem[]>",
		},
		{
			name: "go func with receiver and multiple results",
			lang: "go",
			src:  "func (s *Store) Load(key string) ([]byte, bool, error) {\n\treturn nil, false, nil\n}",
			want: "func (s *Store) Load(key string) ([]byte, bool, error)",
		},
		{
			name: "go type declaration",
			lang: "go",
			src:  "type SymbolIndexEntry struct {\n\tName string\n}",
			want: "type SymbolIndexEntry struct",
		},
		{
			name: "python def keeps annotations and drops the colon",
			lang: "python",
			src:  "def resolve(path: str, strict: bool = False) -> Optional[Module]:\n    pass",
			want: "def resolve(path: str, strict: bool = False) -> Optional[Module]",
		},
		{
			name: "python hash comment is stripped",
			lang: "python",
			src:  "CAP = 160  # tuned for context budgets",
			want: "CAP = 160",
		},
		{
			name: "ts hash is not a comment (private class field)",
			lang: "typescript",
			src:  "class A { #count = 0 }",
			want: "class A",
		},
		{
			name: "line comment after a declaration is stripped",
			lang: "go",
			src:  "func Build(ctx context.Context) error { // entry point",
			want: "func Build(ctx context.Context) error",
		},
		{
			name: "braces and slashes inside a string literal are not structural",
			lang: "typescript",
			src:  "export const tpl = \"{ // not a comment\"",
			want: "export const tpl = \"{ // not a comment\"",
		},
		{
			name: "escaped quote does not end the string",
			lang: "typescript",
			src:  "export const q = \"a\\\"{b\"",
			want: "export const q = \"a\\\"{b\"",
		},
		{
			name: "inline object type inside params is kept",
			lang: "typescript",
			src:  "export function f(o: { a: number }): void {",
			want: "export function f(o: { a: number }): void",
		},
		{
			name: "statement terminator ends the signature",
			lang: "typescript",
			src:  "export function overload(a: string): void;",
			want: "export function overload(a: string): void",
		},
		{
			// The regression that motivated regex-literal lexing: this
			// literal contains brackets, both quote styles, a backtick and
			// a semicolon. Lexed as ordinary text it corrupts the scanner's
			// quote state and the fold swallows the following declarations.
			name: "regex literal full of structural characters is kept intact",
			lang: "typescript",
			src: strings.Join([]string{
				"export const PUNCTUATION_REGEX = /[(){}[\\]<>.,;:'\"!?+\\-=*/\\\\|&%^$#@~`]/;",
				"",
				"/**",
				" * Check if a character is whitespace.",
				" */",
				"export function isWhitespaceChar(char: string): boolean {",
			}, "\n"),
			want: "export const PUNCTUATION_REGEX = /[(){}[\\]<>.,;:'\"!?+\\-=*/\\\\|&%^$#@~`]/",
		},
		{
			name: "division is not mistaken for a regex literal",
			lang: "typescript",
			src:  "export const half = total / 2",
			want: "export const half = total / 2",
		},
		{
			name: "block comment ends the declaration text",
			lang: "typescript",
			src:  "export function f(a: string): void /* trailing */ {",
			want: "export function f(a: string): void",
		},
		{
			// The apostrophe sits inside a line comment, which is stripped
			// before it can open a quote — so the wrap still folds cleanly.
			name: "apostrophe inside a trailing comment does not break the fold",
			lang: "typescript",
			src: strings.Join([]string{
				"export function withApostrophe(a: string, // don't stop here",
				"  b: string) {",
			}, "\n"),
			want: "export function withApostrophe(a: string, b: string)",
		},
		{
			// The safety net: once a quote is left open the scanner has
			// lost the source, so folding must stop rather than splice in
			// whatever follows.
			name: "unclosed string stops the fold instead of splicing",
			lang: "typescript",
			src: strings.Join([]string{
				"export function f(sep = \"unterminated,",
				"  b: string) {",
				"SHOULD_NOT_APPEAR",
			}, "\n"),
			want: "export function f(sep = \"unterminated",
		},
		{
			name: "rust attribute hash is not a comment",
			lang: "rust",
			src:  "pub fn parse(input: &str) -> Result<Ast, Error> {",
			want: "pub fn parse(input: &str) -> Result<Ast, Error>",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lines := strings.Split(tt.src, "\n")
			got := signatureAt(tt.lang, lines, tt.idx)
			if got != tt.want {
				t.Errorf("signatureAt()\n got: %q\nwant: %q", got, tt.want)
			}
		})
	}
}

func TestSignatureAt_OutOfRangeIndexIsEmpty(t *testing.T) {
	lines := []string{"func A() {}"}
	for _, idx := range []int{-1, 1, 99} {
		if got := signatureAt("go", lines, idx); got != "" {
			t.Errorf("signatureAt(idx=%d) = %q, want empty", idx, got)
		}
	}
}

func TestSignatureAt_CapsAtSignatureCap(t *testing.T) {
	long := "export function wide(" + strings.Repeat("someLongParameterName: string, ", 40) + "): void {"
	got := signatureAt("typescript", []string{long}, 0)
	if len([]rune(got)) != SignatureCap {
		t.Errorf("len = %d, want exactly SignatureCap (%d)", len([]rune(got)), SignatureCap)
	}
}

// TestSignatureAt_StopsScanningAtMaxSignatureLines pins the continuation
// bound: an unbalanced declaration must not swallow the rest of the file.
func TestSignatureAt_StopsScanningAtMaxSignatureLines(t *testing.T) {
	lines := []string{"export function never("}
	for i := 0; i < 50; i++ {
		lines = append(lines, "  a: string,")
	}
	lines = append(lines, "): void {", "  SHOULD_NOT_APPEAR")

	got := signatureAt("typescript", lines, 0)
	if strings.Contains(got, "SHOULD_NOT_APPEAR") {
		t.Errorf("scan ran past maxSignatureLines: %q", got)
	}
}

// TestBuildSymbols_PopulatesSignatures wires the extractor to the symbol
// builder: both exported symbols (seeded from exports) and the non-exported
// declaration scan must carry declaration text.
func TestBuildSymbols_PopulatesSignatures(t *testing.T) {
	src := []byte(strings.Join([]string{
		"export function publicOne(a: string): number {",
		"  return helper(a)",
		"}",
		"",
		"function helper(a: string): number {",
		"  return a.length",
		"}",
	}, "\n"))
	exports := []Export{{Name: "publicOne", Kind: "function", Line: 1}}

	syms := buildSymbols("typescript", src, exports)

	want := map[string]string{
		"publicOne": "export function publicOne(a: string): number",
		"helper":    "function helper(a: string): number",
	}
	if len(syms) != len(want) {
		t.Fatalf("got %d symbols, want %d: %+v", len(syms), len(want), syms)
	}
	for _, s := range syms {
		w, ok := want[s.Name]
		if !ok {
			t.Errorf("unexpected symbol %q", s.Name)
			continue
		}
		if s.Sig != w {
			t.Errorf("symbol %q sig\n got: %q\nwant: %q", s.Name, s.Sig, w)
		}
	}
}
