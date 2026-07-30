package flow

// orderedSet is an insertion-ordered string set, standing in for the JS
// `Set` instances the CJS engine relies on for BFS bookkeeping
// (visitedModules, visitedContainers, enqueued, emittedSinkKinds, ...).
// Iteration order (Items()) is always first-insertion order, never Go map
// order.
type orderedSet struct {
	items []string
	seen  map[string]struct{}
}

func newOrderedSet() *orderedSet {
	return &orderedSet{seen: make(map[string]struct{})}
}

// add inserts id if not already present, appending it to the end.
func (s *orderedSet) add(id string) {
	if _, ok := s.seen[id]; ok {
		return
	}
	s.seen[id] = struct{}{}
	s.items = append(s.items, id)
}

// has reports whether id was previously added.
func (s *orderedSet) has(id string) bool {
	_, ok := s.seen[id]
	return ok
}

// len returns the number of distinct members.
func (s *orderedSet) len() int { return len(s.items) }
