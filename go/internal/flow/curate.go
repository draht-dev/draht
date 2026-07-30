package flow

import (
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/rawobj"
)

// flowList is the ordered-by-id equivalent of the CJS `byId` Map used by
// the FLOWS.json curation pass: `byId.set(id, v)` keeps v's original slot
// when id already exists, and appends when it is new.
type flowList struct {
	ids  []string
	objs map[string]*rawobj.Object
}

func newFlowList() *flowList {
	return &flowList{objs: make(map[string]*rawobj.Object)}
}

func (l *flowList) set(id string, o *rawobj.Object) {
	if _, ok := l.objs[id]; !ok {
		l.ids = append(l.ids, id)
	}
	l.objs[id] = o
}

func (l *flowList) values() []*rawobj.Object {
	out := make([]*rawobj.Object, len(l.ids))
	for i, id := range l.ids {
		out[i] = l.objs[id]
	}
	return out
}

var curatedTrue = json.RawMessage("true")

// parseFlowsOverlay extracts the "flows" array from FLOWS.json's raw bytes.
// Mirrors the CJS try/catch + Array.isArray guard: any parse failure,
// missing file, missing "flows" key, or non-array "flows" value is a
// silent no-op (ok=false), never an error.
func parseFlowsOverlay(flowsJSON []byte) (arr []json.RawMessage, ok bool) {
	if len(flowsJSON) == 0 {
		return nil, false
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(flowsJSON, &doc); err != nil {
		return nil, false
	}
	raw, present := doc["flows"]
	if !present {
		return nil, false
	}
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, false
	}
	return arr, true
}

// ApplyFlowsCuration ports the FLOWS.json merge (draht-tools.cjs:2821-2836).
// When flowsJSON is empty, unparsable, or lacks an array "flows" key, the
// auto-generated flows pass through unchanged (still re-marshaled through
// rawobj.Object so the output shape is identical either way).
//
// For each user flow with a non-empty "id": if the id matches an
// auto-generated flow, the two are shallow-merged with
// Object.assign semantics (auto flow's key order first, then any
// user-only keys in the user object's order, then "curated" forced to
// `true` and appended); UNKNOWN keys the Flow struct does not model
// (e.g. "owner", "notes") survive verbatim. New ids are appended, in the
// order they appear in FLOWS.json's "flows" array. Matched ids keep their
// original position in the output list.
func ApplyFlowsCuration(flows []Flow, flowsJSON []byte) []json.RawMessage {
	base := make([]*rawobj.Object, len(flows))
	for i, f := range flows {
		ro, err := rawobj.From(f)
		if err != nil {
			panic(err) // Flow always marshals cleanly; a failure here is a programmer error.
		}
		base[i] = ro
	}

	overlay, ok := parseFlowsOverlay(flowsJSON)
	fl := newFlowList()
	for i, f := range flows {
		fl.set(f.ID, base[i])
	}
	if ok {
		for _, raw := range overlay {
			ov := rawobj.New()
			if err := ov.UnmarshalJSON(raw); err != nil {
				continue
			}
			idRaw, has := ov.Get("id")
			if !has {
				continue
			}
			var idStr string
			if err := json.Unmarshal(idRaw, &idStr); err != nil || idStr == "" {
				continue
			}
			existing := fl.objs[idStr] // nil is fine: rawobj.Assign treats it as {}
			merged := rawobj.Assign(existing, ov, rawobj.KV{Key: "curated", Value: curatedTrue})
			fl.set(idStr, merged)
		}
	}

	result := fl.values()
	out := make([]json.RawMessage, len(result))
	for i, o := range result {
		b, err := o.MarshalJSON()
		if err != nil {
			panic(err)
		}
		out[i] = b
	}
	return out
}
