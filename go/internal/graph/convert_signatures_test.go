package graph

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
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

// TestBuild_SignatureCanariesAreOptInAndInitializerFree is the exact
// facts.ndjson + MAP.json canary gate. A flag-off build must never extract a
// signature at all. Reusing that cache with the flag on must miss (mode is
// part of cache identity), persist only sanitized signatures, and emit those
// same sanitized declarations in MAP.json.
func TestBuild_SignatureCanariesAreOptInAndInitializerFree(t *testing.T) {
	const source = `export const API_TOKEN: string = "same-line-secret"; export const callback = () => 1;
export const ARRAY_CONFIG = ["array-secret", () => 1];
export const OBJECT_CONFIG = { token: "object-secret", callback: () => 1 };
export const first: string = "comma-secret", second = () => 1;
export function connect(token: string = "default-secret", retries = 3): void {}
export const run = (callback = () => "callback-secret", config: object = {token: "nested-secret"}): void => {}
`
	canaries := []string{
		"same-line-secret", "array-secret", "object-secret", "comma-secret",
		"default-secret", "callback-secret", "nested-secret",
	}
	wantSignatures := []string{
		"export const API_TOKEN: string",
		"export const ARRAY_CONFIG",
		"export const OBJECT_CONFIG",
		"export const first: string",
		"export function connect(token: string, retries): void",
		"export const run = (callback, config: object): void",
	}

	root := t.TempDir()
	cacheDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "canary.ts"), []byte(source), 0o644); err != nil {
		t.Fatalf("write canary: %v", err)
	}

	build := func(t *testing.T, signatures bool) ([]byte, []byte, Report) {
		t.Helper()
		outDir := t.TempDir()
		_, report, err := Build(context.Background(), Options{
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
		return mapJSON, facts, report
	}

	mapOff, factsOff, offReport := build(t, false)
	if offReport.CacheMisses != 1 {
		t.Fatalf("flag-off cache misses = %d, want 1", offReport.CacheMisses)
	}
	for name, data := range map[string][]byte{"MAP.json": mapOff, "facts.ndjson": factsOff} {
		for _, canary := range canaries {
			if strings.Contains(string(data), canary) {
				t.Errorf("%s retained initializer canary %q with --symbol-signatures off", name, canary)
			}
		}
	}
	if strings.Contains(string(mapOff), `"signature"`) || strings.Contains(string(factsOff), `"sig"`) {
		t.Fatalf("flag-off artifacts persisted signature data\nMAP: %s\nfacts: %s", mapOff, factsOff)
	}

	mapOn, factsOn, onReport := build(t, true)
	if onReport.CacheMisses != 1 || onReport.CacheHits != 0 {
		t.Fatalf("signature mode reused flag-off cache: hits=%d misses=%d", onReport.CacheHits, onReport.CacheMisses)
	}
	for name, data := range map[string][]byte{"MAP.json": mapOn, "facts.ndjson": factsOn} {
		for _, canary := range canaries {
			if strings.Contains(string(data), canary) {
				t.Errorf("%s retained initializer canary %q with --symbol-signatures on", name, canary)
			}
		}
	}
	for _, signature := range wantSignatures {
		mapNeedle := `"signature": ` + strconv.Quote(signature)
		factsNeedle := `"sig":` + strconv.Quote(signature)
		if !strings.Contains(string(mapOn), mapNeedle) {
			t.Errorf("MAP.json missing exact sanitized signature %q: %s", signature, mapOn)
		}
		if !strings.Contains(string(factsOn), factsNeedle) {
			t.Errorf("facts.ndjson missing exact sanitized signature %q: %s", signature, factsOn)
		}
	}
}
