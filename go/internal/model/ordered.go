package model

import (
	"bytes"
	"encoding/json"
	"errors"
)

// OrderedCounts is an insertion-ordered string->int map that marshals in
// insertion order (JS object semantics), not Go's sorted-key map order.
// This is what keeps model.WriteIfChanged's idempotent-write guarantee
// intact (design §R4): Go's encoding/json sorts map[string]int keys, which
// would rewrite MAP.json on the first run and diverge from the CJS engine
// permanently.
type OrderedCounts struct {
	keys []string
	m    map[string]int
}

// NewOrderedCounts returns an empty OrderedCounts.
func NewOrderedCounts() *OrderedCounts {
	return &OrderedCounts{m: make(map[string]int)}
}

// Inc adds 1 to k, appending k on first sight.
func (o *OrderedCounts) Inc(k string) { o.Add(k, 1) }

// Add adds n to k's count, appending k on first sight.
func (o *OrderedCounts) Add(k string, n int) {
	if o.m == nil {
		o.m = make(map[string]int)
	}
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] += n
}

// Set assigns k's count, appending k on first sight — the equivalent of JS
// `obj[k] = n`, as opposed to Add's `obj[k] += n`. Needed where the CJS
// assigns rather than accumulates (e.g. tests.byContainer), so that two
// containers sharing a name yield the last value instead of their sum.
func (o *OrderedCounts) Set(k string, n int) {
	if o.m == nil {
		o.m = make(map[string]int)
	}
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = n
}

// Get returns k's current count (0 if absent).
func (o *OrderedCounts) Get(k string) int {
	if o == nil || o.m == nil {
		return 0
	}
	return o.m[k]
}

// Len returns the number of distinct keys.
func (o *OrderedCounts) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys returns a copy of the keys in insertion order.
func (o *OrderedCounts) Keys() []string {
	if o == nil {
		return nil
	}
	out := make([]string, len(o.keys))
	copy(out, o.keys)
	return out
}

// MarshalJSON emits {"k1":v1,"k2":v2,...} in insertion order ("{}" when
// empty or nil). It emits COMPACT JSON and relies on the enclosing
// json.Encoder's SetIndent to re-indent it — encoding/json re-indents the
// output of a custom MarshalJSON, so emitting pre-indented bytes here would
// double-indent.
func (o *OrderedCounts) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	if o != nil {
		for i, k := range o.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			kb, err := json.Marshal(k)
			if err != nil {
				return nil, err
			}
			buf.Write(kb)
			buf.WriteByte(':')
			vb, err := json.Marshal(o.m[k])
			if err != nil {
				return nil, err
			}
			buf.Write(vb)
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

var errOrderedCountsNotObject = errors.New("model: OrderedCounts.UnmarshalJSON: expected a JSON object")

// UnmarshalJSON preserves the source file's key order — needed by the
// idempotent-write round-trip (model.WriteIfChanged decodes the prior
// MAP.json to compare it against the freshly-built one).
func (o *OrderedCounts) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return errOrderedCountsNotObject
	}
	o.keys = nil
	o.m = make(map[string]int)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := keyTok.(string)
		var val int
		if err := dec.Decode(&val); err != nil {
			return err
		}
		o.Add(key, val)
	}
	_, err = dec.Token() // consume closing '}'
	return err
}
