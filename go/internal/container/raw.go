package container

import (
	"encoding/json"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/rawobj"
)

// RawObject is an insertion-ordered JSON object: a key slice plus a
// key->raw-value map. It reproduces JS object semantics exactly — Set on an
// existing key keeps that key's position and replaces its value; Set on a
// new key appends at the end.
//
// This exists so the GROUPS.json curation merge (an `Object.assign({}, base,
// overlay, forced)`) can preserve schema-unknown keys the user writes into
// GROUPS.json: a typed model.Group would silently drop them on decode.
//
// The implementation itself lives in internal/rawobj (shared with
// internal/flow's identical FLOWS.json curation contract, and with the same
// HTML-escaping-disabled marshaling — see rawobj's package doc comment): this
// is a thin, container-scoped alias so this package's existing exported API
// (RawObject/NewRawObject/RawObjectFrom/Assign/KV) does not change shape.
type RawObject = rawobj.Object

// KV is one forced key/value pair applied last in Assign.
type KV = rawobj.KV

// Assign ports `Object.assign({}, base, overlay, forced...)` — see
// rawobj.Assign for the full semantics.
func Assign(base, overlay *RawObject, forced ...KV) *RawObject {
	return rawobj.Assign(base, overlay, forced...)
}

// NewRawObject returns an empty RawObject.
func NewRawObject() *RawObject {
	return rawobj.New()
}

// RawObjectFrom marshals v (typically a typed struct) and re-decodes it into
// a RawObject, which canonicalizes key order to v's JSON field order.
func RawObjectFrom(v any) (*RawObject, error) {
	return rawobj.From(v)
}

// ApplyGroupsCuration merges groups with the user overrides in groupsJSON
// (the raw bytes of .planning/codebase/GROUPS.json), producing an ordered
// list of RawObjects so unknown user-written keys survive round-tripping.
// Verbatim port of applyGroupsCuration (draht-tools.cjs:1217-1243):
//
//   - groupsJSON == nil/empty (file absent), or malformed JSON, or its
//     top-level "groups" is missing/not-an-array: returns groups unchanged
//     (converted to canonical-order RawObjects), matching the CJS
//     try/catch-and-return-groups posture.
//   - Each user group with a truthy "id" is merged onto the matching
//     existing group (or an empty object, for a brand-new id) via Assign,
//     with "source" forced to "curated". A matching id keeps its original
//     position in the output; a brand-new id is appended in
//     user.groups-encounter order.
//   - A second pass enforces a GLOBAL first-wins uniqueness constraint on
//     every group's "members" array, scanning groups in the (already
//     curated) output order.
func ApplyGroupsCuration(groups []model.Group, groupsJSON []byte) []*RawObject {
	order := make([]string, len(groups))
	byID := make(map[string]*RawObject, len(groups))
	for i, g := range groups {
		ro, err := RawObjectFrom(g)
		if err != nil {
			// model.Group always marshals cleanly; defend anyway rather
			// than panic on an unexpected encoding error.
			ro = NewRawObject()
		}
		order[i] = g.ID
		byID[g.ID] = ro
	}

	snapshot := func() []*RawObject {
		out := make([]*RawObject, len(order))
		for i, id := range order {
			out[i] = byID[id]
		}
		return out
	}

	if len(groupsJSON) == 0 {
		return snapshot()
	}

	var root map[string]json.RawMessage
	if err := json.Unmarshal(groupsJSON, &root); err != nil {
		return snapshot()
	}
	groupsRaw, ok := root["groups"]
	if !ok {
		return snapshot()
	}
	var items []json.RawMessage
	if err := json.Unmarshal(groupsRaw, &items); err != nil {
		return snapshot() // not an array
	}

	forcedSource := KV{Key: "source", Value: json.RawMessage(`"curated"`)}
	for _, item := range items {
		ug := NewRawObject()
		if err := ug.UnmarshalJSON(item); err != nil {
			continue // non-object entries are skipped defensively
		}
		idRaw, hasID := ug.Get("id")
		if !hasID || !rawobj.Truthy(idRaw) {
			continue
		}
		var id string
		if err := json.Unmarshal(idRaw, &id); err != nil {
			continue
		}
		existing := byID[id]
		merged := Assign(existing, ug, forcedSource)
		if existing == nil {
			order = append(order, id)
		}
		byID[id] = merged
	}

	seen := make(map[string]struct{})
	out := make([]*RawObject, 0, len(order))
	for _, id := range order {
		out = append(out, dedupMembers(byID[id], seen))
	}
	return out
}

// dedupMembers rebuilds g's "members" array, dropping any member id already
// seen (in the enclosing scan order) and recording newly-kept ids into seen.
// Mirrors the second pass of applyGroupsCuration (draht-tools.cjs:1230-1240):
// `Object.assign({}, g, {members: m})` — which, since "members" already
// exists on every auto/curated group, preserves that key's position and
// only replaces its value (RawObject.Set already has this semantics for a
// pre-existing key; for a brand-new curated group that never had "members"
// at all, Set correctly appends it, matching Object.assign's behavior when
// the key is new).
func dedupMembers(g *RawObject, seen map[string]struct{}) *RawObject {
	membersRaw, hasMembers := g.Get("members")
	var members []json.RawMessage
	if hasMembers {
		_ = json.Unmarshal(membersRaw, &members)
	}
	filtered := make([]json.RawMessage, 0, len(members))
	for _, mRaw := range members {
		key := memberDedupKey(mRaw)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		filtered = append(filtered, mRaw)
	}
	newMembers, err := rawobj.MarshalNoEscape(filtered)
	if err != nil {
		newMembers = []byte("[]")
	}
	out := g.Clone()
	out.Set("members", newMembers)
	return out
}

// memberDedupKey extracts a comparable key for one members[] entry: string
// entries dedup by value (the common case — container ids); any other JSON
// shape dedups by its raw byte form as a defensive fallback (GROUPS.json
// members are documented as string ids, but curation input is unvalidated
// user JSON).
func memberDedupKey(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return "s:" + s
	}
	return "r:" + string(raw)
}
