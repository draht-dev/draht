package graph

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/extract"
	"github.com/draht-dev/draht/go/internal/parse"
)

func signatureFacts() []extract.Symbol {
	return []extract.Symbol{
		{Name: "publicOne", Kind: "function", Line: 1, Exported: true, Sig: "export function publicOne(a: string): number"},
		{Name: "helper", Kind: "function", Line: 5, Exported: false, Sig: "function helper(a: string): number"},
	}
}

// TestConvertSymbols_GatingIsTheParityContract is the load-bearing test for
// this feature. extract always records signatures (so a cache entry is valid
// either way), which means the ONLY thing keeping MAP.json byte-identical to
// the CJS engine's by default is convertSymbols dropping them when the flag
// is off — and the omitempty dropping the key once they are empty.
func TestConvertSymbols_GatingIsTheParityContract(t *testing.T) {
	off := convertSymbols(signatureFacts(), false)
	for _, s := range off {
		if s.Signature != "" {
			t.Errorf("symbol %q leaked a signature with the flag off: %q", s.Name, s.Signature)
		}
	}

	b, err := json.Marshal(off)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "signature") {
		t.Errorf("MAP.json would grow a signature key with the flag off: %s", b)
	}
}

func TestConvertSymbols_EmitsSignaturesWhenEnabled(t *testing.T) {
	on := convertSymbols(signatureFacts(), true)
	if len(on) != 2 {
		t.Fatalf("got %d symbols, want 2", len(on))
	}
	if on[0].Signature != "export function publicOne(a: string): number" {
		t.Errorf("exported symbol signature = %q", on[0].Signature)
	}
	if on[1].Signature != "function helper(a: string): number" {
		t.Errorf("internal symbol signature = %q", on[1].Signature)
	}

	b, err := json.Marshal(on)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Signature must serialize last: encoding/json follows declaration
	// order, and every field before it matches the CJS key order.
	if !strings.Contains(string(b), `"exported":true,"signature":`) {
		t.Errorf("signature is not the trailing key: %s", b)
	}
}

// TestConvertSymbols_PreservesNonSignatureFields guards the fields the flag
// must never touch, in both modes.
func TestConvertSymbols_PreservesNonSignatureFields(t *testing.T) {
	for _, withSigs := range []bool{false, true} {
		got := convertSymbols(signatureFacts(), withSigs)
		if got[0].Name != "publicOne" || got[0].Kind != "function" || got[0].Line != 1 || !got[0].Exported {
			t.Errorf("withSigs=%v: exported symbol mangled: %+v", withSigs, got[0])
		}
		if got[1].Name != "helper" || got[1].Line != 5 || got[1].Exported {
			t.Errorf("withSigs=%v: internal symbol mangled: %+v", withSigs, got[1])
		}
	}
}

// TestBuild_SignatureCanaryNeverReachesOutputOrCache reproduces the exact
// independent-review canary: a plain variable is immediately followed by an
// arrow declaration. With --symbol-signatures off (the default), neither
// MAP.json nor facts.ndjson may contain the initializer. Enabling output may
// expose only the declaration signature, never the initializer value.
func TestBuild_SignatureCanaryNeverReachesOutputOrCache(t *testing.T) {
	const (
		secret = "initializer-secret-canary"
		source = `export const CANARY_TOKEN: string = "initializer-secret-canary"
export const later = (value: string): string => value
`
	)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "canary.ts"), []byte(source), 0o644); err != nil {
		t.Fatalf("write canary: %v", err)
	}

	build := func(t *testing.T, signatures bool) ([]byte, []byte) {
		t.Helper()
		outDir := t.TempDir()
		cacheDir := t.TempDir()
		_, _, err := Build(context.Background(), Options{
			Root: root, OutDir: outDir, CacheDir: cacheDir,
			Parser: parse.NewRegex(), SymbolSignatures: signatures,
		})
		if err != nil {
			t.Fatalf("Build(signatures=%v): %v", signatures, err)
		}
		mapJSON, err := os.ReadFile(filepath.Join(outDir, "MAP.json"))
		if err != nil {
			t.Fatalf("read MAP.json: %v", err)
		}
		facts, err := os.ReadFile(filepath.Join(cacheDir, "facts.ndjson"))
		if err != nil {
			t.Fatalf("read facts.ndjson: %v", err)
		}
		return mapJSON, facts
	}

	t.Run("symbol-signatures off", func(t *testing.T) {
		mapJSON, facts := build(t, false)
		for name, data := range map[string][]byte{"MAP.json": mapJSON, "facts.ndjson": facts} {
			if strings.Contains(string(data), secret) {
				t.Errorf("%s retained initializer secret with --symbol-signatures off", name)
			}
		}
		if strings.Contains(string(mapJSON), `"signature"`) {
			t.Error("MAP.json emitted signatures with --symbol-signatures off")
		}
	})

	t.Run("symbol-signatures on", func(t *testing.T) {
		mapJSON, facts := build(t, true)
		for name, data := range map[string][]byte{"MAP.json": mapJSON, "facts.ndjson": facts} {
			if strings.Contains(string(data), secret) {
				t.Errorf("%s retained initializer secret with --symbol-signatures on", name)
			}
		}
		if !strings.Contains(string(mapJSON), `"signature": "export const CANARY_TOKEN: string"`) {
			t.Errorf("MAP.json did not emit the safe canary declaration signature: %s", mapJSON)
		}
	})
}
