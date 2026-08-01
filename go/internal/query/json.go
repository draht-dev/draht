package query

import (
	"bytes"
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/model"
)

// MarshalPretty replicates JSON.stringify(v, null, 2): 2-space indent, the
// same key order the struct declares (matching JS object insertion order),
// no HTML escaping (JSON.stringify never escapes <, >, or &), and NO
// trailing newline — every graph-* --json branch prints this via a single
// console.log, which appends exactly one trailing "\n" itself; callers of
// MarshalPretty are responsible for that one newline (see e.g. context.go).
func MarshalPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// ContextJSON is one element of graph-context --json's array payload.
// Field order matches the CJS object literal's key order exactly.
type ContextJSON struct {
	ID           string                  `json:"id"`
	Package      *string                 `json:"package"`
	Layer        string                  `json:"layer"`
	Cluster      string                  `json:"cluster"`
	ClusterLabel *string                 `json:"clusterLabel"`
	EntryPoint   *model.ModuleEntryPoint `json:"entryPoint"`
	Exports      []string                `json:"exports"`
	Importers    []string                `json:"importers"`
	Imports      []string                `json:"imports"`
	Sinks        []string                `json:"sinks"`
	Rationale    []model.RationaleEntry  `json:"rationale"`
	// Signatures is the declaration text for each entry in Exports, same
	// order, same length. Present only for a MAP.json built with
	// --symbol-signatures; the omitempty keeps the payload byte-identical
	// to the CJS engine's for every other map. MUST stay the last field —
	// encoding/json emits struct fields in declaration order, and the ones
	// above match the CJS object literal's key order exactly.
	Signatures []string `json:"signatures,omitempty"`
}

// OrderedStrSlices is an insertion-ordered string->[]string map (JS object
// semantics for graph-impact's byPackage), analogous to model.OrderedCounts
// but for []string values. It is intentionally NOT in internal/model: it is
// a query-command-local JSON shape, not part of the MAP.json schema.
type OrderedStrSlices struct {
	keys []string
	m    map[string][]string
}

// NewOrderedStrSlices returns an empty OrderedStrSlices.
func NewOrderedStrSlices() *OrderedStrSlices {
	return &OrderedStrSlices{m: make(map[string][]string)}
}

// Append appends v to k's slice, recording k on first sight.
func (o *OrderedStrSlices) Append(k, v string) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = append(o.m[k], v)
}

// Keys returns the keys in insertion order.
func (o *OrderedStrSlices) Keys() []string { return o.keys }

// Get returns k's slice (nil if absent).
func (o *OrderedStrSlices) Get(k string) []string { return o.m[k] }

// Len returns the number of distinct keys.
func (o *OrderedStrSlices) Len() int { return len(o.keys) }

// MarshalJSON emits {"k1":["v1",...],...} in insertion order.
func (o *OrderedStrSlices) MarshalJSON() ([]byte, error) {
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

// ImpactJSON is graph-impact --json's payload shape.
type ImpactJSON struct {
	Targets     []string                     `json:"targets"`
	Impacted    []string                     `json:"impacted"`
	EntryPoints []string                     `json:"entryPoints"`
	ByPackage   *OrderedStrSlices            `json:"byPackage"`
	Clusters    []string                     `json:"clusters"`
	Sinks       []string                     `json:"sinks"`
	Warnings    []model.SurprisingConnection `json:"warnings"`
}

// Hop is one graph-callers/graph-callees BFS edge.
type Hop struct {
	From   string  `json:"from"`
	To     string  `json:"to"`
	Symbol *string `json:"symbol"`
	Hop    int     `json:"hop"`
}

// CallDirJSON is graph-callers/graph-callees --json's payload shape.
type CallDirJSON struct {
	Target    string `json:"target"`
	Direction string `json:"direction"`
	Hops      []Hop  `json:"hops"`
}

// QueryHit is one graph-query result (both text and --json rendering share
// this shape).
type QueryHit struct {
	Score    float64 `json:"score"`
	Deg      int     `json:"deg"`
	Path     string  `json:"path"`
	Line     int     `json:"line"`
	Kind     string  `json:"kind"`
	Name     string  `json:"name"`
	Exported bool    `json:"exported"`
	Doc      string  `json:"doc"`
}

// ClustersJSON is graph-clusters --json's payload shape. SurprisingConnections
// is a *[]model.SurprisingConnection (not a plain slice) so that
// `omitempty` only fires when the flag was never set (nil pointer) — a
// plain-slice `omitempty` would also incorrectly drop the key when
// --surprising is set but the connections list happens to be empty, which
// diverges from JSON.stringify's undefined-vs-empty-array distinction.
type ClustersJSON struct {
	Clusters              []model.Cluster               `json:"clusters"`
	SurprisingConnections *[]model.SurprisingConnection `json:"surprisingConnections,omitempty"`
}
