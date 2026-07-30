package htmlview

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

//go:embed asset/viewer.html.tmpl
var viewerTemplate string

// Injection tokens present exactly once each in viewerTemplate. Asserted by
// asset/extract.mjs at extraction time and re-asserted by Render at render
// time, so a hand-edit of the asset that damages a token fails loudly
// instead of silently shipping a broken viewer.
const (
	tokenMapJSON  = "@@DRAHT_EMBEDDED_MAP_JSON@@"
	tokenJSONPath = "@@DRAHT_JSON_PATH@@"
)

// TemplateSHA256 is the checksum of viewerTemplate, guarded by
// TestTemplateChecksum so an accidental edit of the 96 KB asset (e.g. an
// editor auto-reformat) cannot pass CI unnoticed.
const TemplateSHA256 = "3c5802addf67f957df4c7c8b01dabd518b1ca6849e84b3dbd852f13a3f132ad7"

// Template exposes the raw embedded asset, for the checksum test and for
// debugging tools that want to inspect the static viewer without a Map.
func Template() string { return viewerTemplate }

// EmbedJSON serializes m the way draht-tools.cjs's visRenderHtml does:
//
//	const embedded = Object.assign({}, map, { generatedAt: "", buildMs: 0 });
//	const embeddedJson = JSON.stringify(embedded).replace(/</g, "\\u003c");
//
// That is: a shallow copy of m with GeneratedAt reset to "" and BuildMs reset
// to 0 (m itself is never mutated), marshaled as compact JSON with HTML
// auto-escaping OFF, then every '<' (0x3C) byte replaced with the literal
// six-byte ASCII sequence `\u003c` so a "</script>" inside any string value
// cannot prematurely close the embedded <script> tag. '>' and '&' are
// deliberately left untouched — encoding/json's SetEscapeHTML(true) is NOT a
// substitute for this pass: it also escapes '>' and '&', which diverges
// byte-for-byte from the CJS output. Replacing the raw byte 0x3C is safe
// here because 0x3C never occurs as a UTF-8 continuation byte.
func EmbedJSON(m *model.Map) ([]byte, error) {
	if m == nil {
		return nil, errors.New("htmlview: EmbedJSON: nil map")
	}
	clone := *m
	clone.GeneratedAt = ""
	clone.BuildMs = 0

	compact, err := marshalCompact(&clone)
	if err != nil {
		return nil, fmt.Errorf("htmlview: EmbedJSON: %w", err)
	}
	escaped := bytes.ReplaceAll(compact, []byte("<"), []byte(`\u003c`))
	return escaped, nil
}

// Render returns the complete MAP.html bytes for m. jsonPath supplies
// JSON_PATH as "./" + filepath.Base(jsonPath) (always "./MAP.json" in
// practice, since the CJS engine hard-codes that basename — kept
// parameterised here to match the CJS signature). Returns an error if either
// injection token is missing or non-unique in the embedded asset, or if m
// fails to marshal.
//
// Token quoting note: asset/extract.mjs substituted the CJS's
// ${JSON.stringify("./" + jsonName)} interpolation with
// JSON.stringify(tokenJSONPath) — i.e. the QUOTED token string — before
// evaluating the template literal. That means the surrounding quote
// characters around tokenJSONPath are already static text baked into
// viewerTemplate (`var JSON_PATH = "@@DRAHT_JSON_PATH@@";`); Render must
// substitute the token with the UNQUOTED, JSON-escaped path content, not a
// re-quoted string, or the output would carry doubled quotes.
func Render(jsonPath string, m *model.Map) ([]byte, error) {
	if strings.Count(viewerTemplate, tokenMapJSON) != 1 {
		return nil, fmt.Errorf("htmlview: Render: token %s occurs %d times in template, want 1",
			tokenMapJSON, strings.Count(viewerTemplate, tokenMapJSON))
	}
	if strings.Count(viewerTemplate, tokenJSONPath) != 1 {
		return nil, fmt.Errorf("htmlview: Render: token %s occurs %d times in template, want 1",
			tokenJSONPath, strings.Count(viewerTemplate, tokenJSONPath))
	}

	blob, err := EmbedJSON(m)
	if err != nil {
		return nil, err
	}
	pathContent, err := jsonStringContent("./" + filepath.Base(jsonPath))
	if err != nil {
		return nil, fmt.Errorf("htmlview: Render: marshal json path: %w", err)
	}

	// Substitute the short JSON_PATH token first and the (potentially huge)
	// embedded-map token last. This guarantees the map JSON blob is never
	// itself scanned for a token match: if user source data happened to
	// contain the literal token string, only literal template occurrences —
	// never blob content — are ever searched.
	out := strings.Replace(viewerTemplate, tokenJSONPath, pathContent, 1)
	out = strings.Replace(out, tokenMapJSON, string(blob), 1)
	return []byte(out), nil
}

// Write renders MAP.html for m and writes it to path with mode 0644,
// creating parent directories as needed. Unlike MAP.json/GRAPH_REPORT.md,
// the CJS engine rewrites MAP.html unconditionally on every non-quiet build
// (draht-tools.cjs:5118-5122) — it is not gated by the MAP.json
// unchanged-check. Callers should mirror that: call Write whenever the
// build is not --quiet, regardless of whether MAP.json changed.
func Write(path, jsonPath string, m *model.Map) error {
	blob, err := Render(jsonPath, m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("htmlview: Write: mkdir %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, blob, 0o644); err != nil {
		return fmt.Errorf("htmlview: Write: %s: %w", path, err)
	}
	// os.WriteFile's mode argument is subject to umask; an explicit Chmod
	// guarantees 0644 regardless of umask, matching fs.writeFileSync's
	// default mode (0666 & ~umask, which is 0644 under the conventional
	// 0022 umask, but Chmod makes it unconditional rather than umask-lucky).
	if err := os.Chmod(path, 0o644); err != nil {
		return fmt.Errorf("htmlview: Write: chmod %s: %w", path, err)
	}
	return nil
}

// marshalCompact replicates JSON.stringify(v) for the subset of Go values
// this package marshals: no indentation, no HTML auto-escaping (matching
// JSON.stringify, which never escapes '<', '>' or '&'), and no trailing
// newline (json.Encoder.Encode always appends one; JSON.stringify never
// does, so it is trimmed here).
func marshalCompact(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// jsonStringContent returns the JSON-escaped CONTENT of the string s,
// without the surrounding quote characters -- i.e. what would sit between
// the quotes JSON.stringify(s) itself would emit. Used for tokenJSONPath,
// whose surrounding quotes are already static text in viewerTemplate (see
// Render's doc comment).
func jsonStringContent(s string) (string, error) {
	quoted, err := marshalCompact(s)
	if err != nil {
		return "", err
	}
	if len(quoted) >= 2 && quoted[0] == '"' && quoted[len(quoted)-1] == '"' {
		return string(quoted[1 : len(quoted)-1]), nil
	}
	return string(quoted), nil
}
