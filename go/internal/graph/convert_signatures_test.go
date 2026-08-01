package graph

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/draht-dev/draht/go/internal/extract"
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
