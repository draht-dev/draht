package model

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// ErrNotImplemented marks scaffold stubs awaiting their real implementation.
var ErrNotImplemented = errors.New("model: not implemented (scaffold stub)")

// WriteMapJSON writes 2-space-indented JSON + exactly one trailing newline,
// with SetEscapeHTML(false). Equivalent to JSON.stringify(m,null,2)+"\n".
func WriteMapJSON(w io.Writer, m *Map) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(m)
}

// normalizedJSON re-encodes m with GeneratedAt/BuildMs zeroed, so two Maps
// that differ only in those two volatile fields compare equal. m is not
// mutated (a shallow copy is normalized instead).
func normalizedJSON(m *Map) ([]byte, error) {
	clone := *m
	clone.GeneratedAt = ""
	clone.BuildMs = 0
	var buf bytes.Buffer
	if err := WriteMapJSON(&buf, &clone); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// WriteIfChanged ports visWriteOutputs' idempotent-write rule: it decodes
// any prior file at path into a *Map, re-encodes both old and new with
// GeneratedAt="" and BuildMs=0, and skips the write when the bytes match.
// Returns changed=false when nothing was written. Any decode error (missing
// file, corrupt JSON, ...) is treated as "changed" — the new file is always
// written in that case. The write itself is atomic: a temp file in the same
// directory, then os.Rename.
func WriteIfChanged(path string, m *Map) (changed bool, err error) {
	newNormalized, err := normalizedJSON(m)
	if err != nil {
		return false, err
	}

	if prevBytes, readErr := os.ReadFile(path); readErr == nil {
		var prev Map
		if decErr := json.Unmarshal(prevBytes, &prev); decErr == nil {
			if prevNormalized, mErr := normalizedJSON(&prev); mErr == nil {
				if bytes.Equal(prevNormalized, newNormalized) {
					return false, nil
				}
			}
		}
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(dir, ".map-*.json.tmp")
	if err != nil {
		return false, err
	}
	tmpPath := tmp.Name()
	// Best-effort cleanup: after a successful Rename this is a no-op
	// (the file no longer exists at tmpPath), and os.Remove of a
	// nonexistent file is not an error we need to surface.
	defer os.Remove(tmpPath)

	if err := WriteMapJSON(tmp, m); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return false, err
	}
	return true, nil
}
