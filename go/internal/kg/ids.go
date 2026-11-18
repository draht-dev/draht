package kg

import (
	"crypto/sha1"
	"encoding/hex"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ID canonicalization — port of graphify ids.py.

// normalizeID: NFKC, every run of non-word characters → "_", trimmed, lowercased.
func normalizeID(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if !ascii {
		s = norm.NFKC.String(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	pending := false
	for _, c := range s {
		if c == '_' || unicode.IsLetter(c) || unicode.IsNumber(c) {
			if c == '_' {
				pending = true
				continue
			}
			if pending && b.Len() > 0 {
				b.WriteByte('_')
			}
			pending = false
			b.WriteRune(c)
		} else {
			pending = true
		}
	}
	return strings.ToLower(b.String())
}

func trimIDPart(p string) string { return strings.Trim(p, "_.") }

// makeID joins the non-empty parts with "_" and canonicalizes the result.
func makeID(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			kept = append(kept, trimIDPart(p))
		}
	}
	return normalizeID(strings.Join(kept, "_"))
}

// fileStem is the full repo-relative path with the extension dropped
// (extractors/base.py _file_stem): `/\.[^/.]+$/` removed.
func fileStem(rel string) string {
	dot := strings.LastIndexByte(rel, '.')
	if dot < 0 || dot == len(rel)-1 || strings.ContainsRune(rel[dot+1:], '/') {
		return rel
	}
	return rel[:dot]
}

func fileNodeID(rel string) string { return makeID(fileStem(rel)) }

func symbolNodeID(rel, name string) string { return makeID(fileStem(rel), name) }

func nameSalt(name string) string {
	sum := sha1.Sum([]byte(name))
	return hex.EncodeToString(sum[:])[:6]
}

// isPrivateMember reports whether `name` is private by the convention of the
// language family: js /^[_$#]/, py /^_/, go /^[^A-Z]/. ok is false for a
// family without a convention (Rust).
func isPrivateMember(family, name string) (private, ok bool) {
	if name == "" {
		return false, family == "js" || family == "py" || family == "go"
	}
	first := []rune(name)[0]
	switch family {
	case "js":
		return first == '_' || first == '$' || first == '#', true
	case "py":
		return first == '_', true
	case "go":
		return !(first >= 'A' && first <= 'Z'), true
	}
	return false, false
}

// saltedIDs gives each name of a group that shares a plain id its own id.
// graphify's rule (extractors/engine.py _underscore_salted_nid,
// _js_member_nid): the one public name of such a group keeps the plain id,
// every other name gets a suffix taken from its own name, so the result never
// depends on declaration order.
func saltedIDs(names []string, plainID func(name string) string, lang string, plainWithoutConvention bool) *OMap[string, string] {
	family := langFamily[lang]
	_, hasPrefix := isPrivateMember(family, "x")
	groups := newOMap[string, *OSet[string]]()
	for _, name := range names {
		id := plainID(name)
		set, ok := groups.Get(id)
		if !ok {
			set = newOSet[string]()
			groups.Set(id, set)
		}
		set.Add(name)
	}
	ids := newOMap[string, string]()
	for id, set := range groups.All() {
		var public []string
		if hasPrefix {
			for _, n := range set.Items() {
				if private, _ := isPrivateMember(family, n); !private {
					public = append(public, n)
				}
			}
		}
		for _, name := range set.Items() {
			plain := (plainWithoutConvention && !hasPrefix) || set.Len() < 2 || (len(public) == 1 && name == public[0])
			if plain {
				ids.Set(name, id)
			} else {
				ids.Set(name, makeID(id, nameSalt(name)))
			}
		}
	}
	return ids
}

// methodNodeIDs maps the method names of one class to node ids. makeID drops
// `_`, `$` and `#`, so `close()` / `#close()` or `load()` / `_load()` in one
// class would share an id and the second declaration would vanish. Accessor
// pairs and overloads are one name, not a collision.
func methodNodeIDs(rel, className string, methods []*Func, lang string) *OMap[string, string] {
	names := make([]string, len(methods))
	for i, m := range methods {
		names[i] = m.Name
	}
	stem := fileStem(rel)
	return saltedIDs(names, func(n string) string { return makeID(stem, className, n) }, lang, true)
}

// fileSymbolIDs maps the file-level names of one file to node ids by the same
// rule: names that would share an id (Go's `ResponseWriter` /
// `responseWriter`) each get their own.
func fileSymbolIDs(rel string, names []string, lang string) *OMap[string, string] {
	return saltedIDs(names, func(n string) string { return symbolNodeID(rel, n) }, lang, false)
}

// splitStr is `s.split(sep)`: strings.Split, named for the port.
func splitStr(s, sep string) []string { return strings.Split(s, sep) }
