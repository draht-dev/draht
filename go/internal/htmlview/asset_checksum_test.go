package htmlview

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// TestTemplateChecksum guards the 96 KB embedded HTML/CSS/JS asset: without
// this test, an accidental gofmt pass, editor auto-save, or line-ending
// conversion touching asset/viewer.html.tmpl would be invisible in review
// (nobody diffs a 2,019-line minified-ish blob by eye) and would silently
// break byte parity with the CJS-produced MAP.html.
func TestTemplateChecksum(t *testing.T) {
	sum := sha256.Sum256([]byte(viewerTemplate))
	got := hex.EncodeToString(sum[:])
	if got != TemplateSHA256 {
		t.Fatalf("asset/viewer.html.tmpl checksum changed:\n got  %s\n want %s\n(if this is an intentional re-lift via asset/extract.mjs, update TemplateSHA256)", got, TemplateSHA256)
	}
}

// TestTemplateFacts pins the raw asset's size/shape, independent of the
// checksum, so a checksum-test skip or bypass still can't hide a gross
// truncation or corruption.
func TestTemplateFacts(t *testing.T) {
	const wantBytes = 96856
	if got := len(viewerTemplate); got != wantBytes {
		t.Errorf("template length = %d bytes, want %d", got, wantBytes)
	}
	if viewerTemplate == "" || viewerTemplate[len(viewerTemplate)-1] != '\n' {
		t.Error("template must end with a trailing newline")
	}
}

// TestTemplateTokensUnique re-asserts, at test time, the invariant
// asset/extract.mjs asserted when it produced the file: both injection
// tokens occur in the template exactly once.
func TestTemplateTokensUnique(t *testing.T) {
	for _, tok := range []string{tokenMapJSON, tokenJSONPath} {
		n := 0
		for i := 0; i+len(tok) <= len(viewerTemplate); i++ {
			if viewerTemplate[i:i+len(tok)] == tok {
				n++
			}
		}
		if n != 1 {
			t.Errorf("token %s occurs %d times in template, want exactly 1", tok, n)
		}
	}
}
