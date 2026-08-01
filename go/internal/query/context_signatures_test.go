package query

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/model"
)

// signatureMap builds a minimal two-module map. mod "a.ts" carries n
// exported symbols; withSigs decides whether they have declaration text (the
// --symbol-signatures build) or not (every map produced without the flag,
// and every map the CJS engine ever wrote).
func signatureMap(n int, withSigs bool) *model.Map {
	m := model.NewMap()
	syms := make([]model.Symbol, 0, n)
	for i := 0; i < n; i++ {
		name := string(rune('a'+i)) + "Fn"
		s := model.Symbol{Name: name, Kind: "function", Line: i + 1, Exported: true}
		if withSigs {
			s.Signature = "export function " + name + "(x: string): number"
		}
		syms = append(syms, s)
	}
	m.Modules = []model.Module{{
		ID:       "a.ts",
		Path:     "a.ts",
		Language: "typescript",
		Layer:    "domain",
		Exports:  []model.Export{},
		Symbols:  syms,
		Sinks:    []string{},
	}}
	return m
}

func runContext(t *testing.T, m *model.Map, argv ...string) string {
	t.Helper()
	var buf bytes.Buffer
	if code := Context(m, argv, &buf); code != 0 {
		t.Fatalf("Context() exit code = %d, want 0", code)
	}
	return buf.String()
}

// TestContext_WithoutSignaturesKeepsInlineForm is the regression guard for
// every pre-existing map: no signature anywhere means the exports facet must
// render exactly as it always did, on one comma-joined line.
func TestContext_WithoutSignaturesKeepsInlineForm(t *testing.T) {
	out := runContext(t, signatureMap(3, false), "a.ts")

	if !strings.Contains(out, "  exports(3): aFn, bFn, cFn\n") {
		t.Errorf("want inline exports line, got:\n%s", out)
	}
}

func TestContext_WithSignaturesRendersBlockForm(t *testing.T) {
	out := runContext(t, signatureMap(2, true), "a.ts")

	for _, want := range []string{
		"  exports(2):\n",
		"    export function aFn(x: string): number\n",
		"    export function bFn(x: string): number\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

// TestContext_SignatureBlockCapsAtEight pins the block form to the same
// 8-entry budget the inline form uses — the whole point is bounded context.
func TestContext_SignatureBlockCapsAtEight(t *testing.T) {
	out := runContext(t, signatureMap(11, true), "a.ts")

	if n := strings.Count(out, "export function "); n != 8 {
		t.Errorf("rendered %d signatures, want 8", n)
	}
	if !strings.Contains(out, "    (+3 more)\n") {
		t.Errorf("missing truncation marker in:\n%s", out)
	}
}

// TestContext_SignatureFallsBackToBareName covers a mixed module: a symbol
// whose declaration could not be rendered still has to appear.
func TestContext_SignatureFallsBackToBareName(t *testing.T) {
	m := signatureMap(2, true)
	m.Modules[0].Symbols[1].Signature = ""

	out := runContext(t, m, "a.ts")

	if !strings.Contains(out, "    export function aFn(x: string): number\n") {
		t.Errorf("missing signature line in:\n%s", out)
	}
	if !strings.Contains(out, "    bFn\n") {
		t.Errorf("missing bare-name fallback in:\n%s", out)
	}
}

// TestContext_JSONOmitsSignaturesWhenAbsent is the byte-compatibility guard
// for --json: a map without signatures must not grow a "signatures" key.
func TestContext_JSONOmitsSignaturesWhenAbsent(t *testing.T) {
	out := runContext(t, signatureMap(2, false), "a.ts", "--json")

	if strings.Contains(out, "signatures") {
		t.Errorf("unexpected signatures key in:\n%s", out)
	}
}

func TestContext_JSONCarriesSignaturesWhenPresent(t *testing.T) {
	out := runContext(t, signatureMap(2, true), "a.ts", "--json")

	var got []ContextJSON
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal --json output: %v\n%s", err, out)
	}
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1", len(got))
	}
	if len(got[0].Signatures) != len(got[0].Exports) {
		t.Fatalf("signatures (%d) and exports (%d) must be parallel",
			len(got[0].Signatures), len(got[0].Exports))
	}
	if got[0].Signatures[0] != "export function aFn(x: string): number" {
		t.Errorf("signatures[0] = %q", got[0].Signatures[0])
	}
}
