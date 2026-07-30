// Package rawobj provides a single, shared insertion-ordered JSON object
// type that reproduces JS Object.assign / property-assignment semantics
// exactly: setting an existing key replaces its value in place (keeping its
// original position); setting a new key appends it at the end.
//
// Both internal/container's GROUPS.json curation and internal/flow's
// FLOWS.json curation need this — each merges
// `Object.assign({}, base, overlay, forced)` and must round-trip
// schema-unknown user keys a typed struct would silently drop — so this
// package is the ONE implementation shared by both, instead of two
// independent ~100-line copies that could silently drift apart.
//
// MarshalNoEscape is exported for the same reason: every byte produced here
// is ultimately embedded, as raw bytes, into the final MAP.json written by
// model.WriteMapJSON (which disables HTML escaping via
// json.Encoder.SetEscapeHTML(false)). Building those bytes with the
// package-level json.Marshal (which always HTML-escapes <, >, &, U+2028,
// U+2029) would bake escaped bytes in BEFORE the outer writer ever runs —
// the outer SetEscapeHTML(false) cannot undo an escape that already
// happened inside an embedded json.RawMessage.
package rawobj

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrNotObject is returned by UnmarshalJSON when the input's top-level JSON
// value is not an object.
var ErrNotObject = errors.New("rawobj: expected a JSON object")

// Object is an insertion-ordered JSON object: a key slice plus a
// key->raw-value map.
type Object struct {
	keys []string
	vals map[string]json.RawMessage
}

// New returns an empty Object.
func New() *Object {
	return &Object{vals: make(map[string]json.RawMessage)}
}

// From marshals v (typically a typed struct) and re-decodes it into an
// Object, which canonicalizes key order to v's JSON field order.
func From(v any) (*Object, error) {
	b, err := MarshalNoEscape(v)
	if err != nil {
		return nil, fmt.Errorf("rawobj: marshal for From: %w", err)
	}
	o := New()
	if err := o.UnmarshalJSON(b); err != nil {
		return nil, fmt.Errorf("rawobj: decode for From: %w", err)
	}
	return o, nil
}

// Set assigns raw to key, appending key at the end if it is new and
// preserving its existing position (only replacing the value) otherwise —
// the exact semantics of a JS object property assignment.
func (o *Object) Set(key string, raw json.RawMessage) {
	if o.vals == nil {
		o.vals = make(map[string]json.RawMessage)
	}
	if _, exists := o.vals[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = raw
}

// SetValue marshals v (HTML-escaping disabled, see MarshalNoEscape) and
// stores it under key via Set.
func (o *Object) SetValue(key string, v any) error {
	raw, err := MarshalNoEscape(v)
	if err != nil {
		return fmt.Errorf("rawobj: marshal value for key %q: %w", key, err)
	}
	o.Set(key, raw)
	return nil
}

// Get returns key's raw value and whether it is present.
func (o *Object) Get(key string) (json.RawMessage, bool) {
	raw, ok := o.vals[key]
	return raw, ok
}

// Keys returns a copy of the object's keys in insertion order.
func (o *Object) Keys() []string {
	out := make([]string, len(o.keys))
	copy(out, o.keys)
	return out
}

// Clone returns a deep-enough copy of o (raw values are copied byte slices;
// mutating the clone never affects o).
func (o *Object) Clone() *Object {
	c := New()
	for _, k := range o.keys {
		v := o.vals[k]
		cp := make(json.RawMessage, len(v))
		copy(cp, v)
		c.Set(k, cp)
	}
	return c
}

// Into JSON-decodes o into dst (a typed struct).
func (o *Object) Into(dst any) error {
	b, err := o.MarshalJSON()
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

// MarshalJSON emits {"k1":v1,"k2":v2,...} in insertion order, with HTML
// escaping disabled (see the package doc comment).
func (o *Object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := MarshalNoEscape(k)
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		v := o.vals[k]
		if len(v) == 0 {
			buf.WriteString("null")
		} else {
			buf.Write(v)
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// UnmarshalJSON decodes b (which MUST be a JSON object) into o, preserving
// the source's key order via json.Decoder tokens.
func (o *Object) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return ErrNotObject
	}
	o.keys = nil
	o.vals = make(map[string]json.RawMessage)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := keyTok.(string)
		if !ok {
			return fmt.Errorf("rawobj: expected a string key, got %v", keyTok)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		o.Set(key, raw)
	}
	_, err = dec.Token() // consume closing '}'
	return err
}

// KV is one forced key/value pair applied last in Assign.
type KV struct {
	Key   string
	Value json.RawMessage
}

// Assign ports `Object.assign({}, base, overlay, forced...)`: base's key
// order first, then overlay-only keys in overlay order, then forced-only
// keys in forced order. A key already present from an earlier source keeps
// its ORIGINAL position and only has its value replaced — exactly how
// Object.assign behaves when copying onto a target that already holds the
// key. base and overlay may be nil (treated as empty objects).
func Assign(base, overlay *Object, forced ...KV) *Object {
	out := New()
	if base != nil {
		for _, k := range base.keys {
			out.Set(k, base.vals[k])
		}
	}
	if overlay != nil {
		for _, k := range overlay.keys {
			out.Set(k, overlay.vals[k])
		}
	}
	for _, kv := range forced {
		out.Set(kv.Key, kv.Value)
	}
	return out
}

// Truthy reproduces JS truthiness for a decoded JSON value: false/0/""/null
// are falsy; everything else (including an empty array/object) is truthy.
func Truthy(raw json.RawMessage) bool {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return false
	}
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	default:
		return true
	}
}

// MarshalNoEscape marshals v like the package-level json.Marshal, except
// with HTML escaping disabled (json.Encoder.SetEscapeHTML(false)) — see the
// package doc comment for why this matters for every caller in this
// package.
func MarshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encoder.Encode appends a trailing newline; trim it so callers get the
	// same byte shape json.Marshal would produce.
	b := buf.Bytes()
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
	}
	return b, nil
}
