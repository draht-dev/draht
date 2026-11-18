package kg

import "iter"

// OMap is a map that iterates in insertion order, as a JavaScript Map does.
// The JS engine's output order (and every first-wins decision) follows Map
// and Set insertion order, so the port must not range over a Go map where the
// original iterated one. A nil *OMap reads as empty.
type OMap[K comparable, V any] struct {
	idx   map[K]int
	keys  []K
	vals  []V
	alive []bool
	n     int
}

func newOMap[K comparable, V any]() *OMap[K, V] {
	return &OMap[K, V]{idx: map[K]int{}}
}

// Get is `m.get(k)` with the presence flag.
func (m *OMap[K, V]) Get(k K) (V, bool) {
	if m != nil {
		if i, ok := m.idx[k]; ok {
			return m.vals[i], true
		}
	}
	var zero V
	return zero, false
}

// G is `m.get(k)`: the zero value when absent.
func (m *OMap[K, V]) G(k K) V {
	v, _ := m.Get(k)
	return v
}

func (m *OMap[K, V]) Has(k K) bool {
	if m == nil {
		return false
	}
	_, ok := m.idx[k]
	return ok
}

// Set keeps the position of an existing key.
func (m *OMap[K, V]) Set(k K, v V) {
	if i, ok := m.idx[k]; ok {
		m.vals[i] = v
		return
	}
	m.idx[k] = len(m.keys)
	m.keys = append(m.keys, k)
	m.vals = append(m.vals, v)
	m.alive = append(m.alive, true)
	m.n++
}

func (m *OMap[K, V]) Delete(k K) {
	if m == nil {
		return
	}
	if i, ok := m.idx[k]; ok {
		m.alive[i] = false
		delete(m.idx, k)
		m.n--
	}
}

func (m *OMap[K, V]) Len() int {
	if m == nil {
		return 0
	}
	return m.n
}

// All iterates in insertion order; entries added while iterating are visited.
func (m *OMap[K, V]) All() iter.Seq2[K, V] {
	return func(yield func(K, V) bool) {
		if m == nil {
			return
		}
		for i := 0; i < len(m.keys); i++ {
			if m.alive[i] && !yield(m.keys[i], m.vals[i]) {
				return
			}
		}
	}
}

func (m *OMap[K, V]) Keys() []K {
	if m == nil {
		return nil
	}
	out := make([]K, 0, m.n)
	for i, k := range m.keys {
		if m.alive[i] {
			out = append(out, k)
		}
	}
	return out
}

func (m *OMap[K, V]) Values() []V {
	if m == nil {
		return nil
	}
	out := make([]V, 0, m.n)
	for i, v := range m.vals {
		if m.alive[i] {
			out = append(out, v)
		}
	}
	return out
}

// Clone is `new Map(m)`.
func (m *OMap[K, V]) Clone() *OMap[K, V] {
	c := newOMap[K, V]()
	for k, v := range m.All() {
		c.Set(k, v)
	}
	return c
}

// OSet is a set that iterates in insertion order, as a JavaScript Set does.
type OSet[K comparable] struct {
	m *OMap[K, struct{}]
}

func newOSet[K comparable](items ...K) *OSet[K] {
	s := &OSet[K]{m: newOMap[K, struct{}]()}
	for _, k := range items {
		s.Add(k)
	}
	return s
}

func (s *OSet[K]) Add(k K) { s.m.Set(k, struct{}{}) }
func (s *OSet[K]) Has(k K) bool {
	if s == nil {
		return false
	}
	return s.m.Has(k)
}
func (s *OSet[K]) Delete(k K) { s.m.Delete(k) }
func (s *OSet[K]) Len() int {
	if s == nil {
		return 0
	}
	return s.m.Len()
}
func (s *OSet[K]) Items() []K {
	if s == nil {
		return nil
	}
	return s.m.Keys()
}

// strSet is a plain lookup set for constant word lists (never iterated).
func strSet(words ...string) map[string]bool {
	m := make(map[string]bool, len(words))
	for _, w := range words {
		m[w] = true
	}
	return m
}

// runeSet is strSet for single characters.
func runeSet(chars string) map[rune]bool {
	m := map[rune]bool{}
	for _, c := range chars {
		m[c] = true
	}
	return m
}
