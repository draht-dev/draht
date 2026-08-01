package main

import "testing"

func TestParseMapGraphArgs_SymbolSignaturesDefaultsOff(t *testing.T) {
	opts, err := parseMapGraphArgs(nil)
	if err != nil {
		t.Fatalf("parseMapGraphArgs(nil): %v", err)
	}
	// Off by default is the parity contract, not a preference: with it on,
	// MAP.json grows a field the CJS engine never writes.
	if opts.symbolSignatures {
		t.Error("symbolSignatures must default to false")
	}
}

func TestParseMapGraphArgs_SymbolSignaturesFlag(t *testing.T) {
	opts, err := parseMapGraphArgs([]string{"--symbol-signatures"})
	if err != nil {
		t.Fatalf("parseMapGraphArgs: %v", err)
	}
	if !opts.symbolSignatures {
		t.Error("--symbol-signatures did not set symbolSignatures")
	}
}

// TestParseMapGraphArgs_SymbolSignaturesComposes guards against the flag
// being parsed in a branch that swallows its neighbours.
func TestParseMapGraphArgs_SymbolSignaturesComposes(t *testing.T) {
	opts, err := parseMapGraphArgs([]string{
		"--symbol-signatures", "--experimental-lang-edges", "--parser=regex", "--quiet",
	})
	if err != nil {
		t.Fatalf("parseMapGraphArgs: %v", err)
	}
	if !opts.symbolSignatures || !opts.experimentalLangEdges || !opts.quiet {
		t.Errorf("flags did not compose: %+v", opts)
	}
	if opts.parserName != "regex" {
		t.Errorf("parserName = %q, want regex", opts.parserName)
	}
}
