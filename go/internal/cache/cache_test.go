package cache

import (
	"fmt"
	"sync"
	"testing"
)

func TestComposeVersion(t *testing.T) {
	got := ComposeVersion(1, "ts/3+gotreesitter@v0.47.1", "x1")
	want := "f1|pts/3+gotreesitter@v0.47.1|xx1"
	if got != want {
		t.Fatalf("ComposeVersion = %q, want %q", got, want)
	}
}

func TestSnapshotGetMissOnEmpty(t *testing.T) {
	s := NewSnapshot()
	if _, ok := s.Get(Key{Path: "a.go", ContentHash: "h1", Version: "v1"}); ok {
		t.Fatalf("Get on empty snapshot should miss")
	}
	st := s.Stats()
	if st.Misses != 1 || st.Hits != 0 || st.Entries != 0 {
		t.Fatalf("Stats = %+v, want Misses=1 Hits=0 Entries=0", st)
	}
}

func TestSnapshotPutThenGetHits(t *testing.T) {
	s := NewSnapshot()
	k := Key{Path: "a.go", ContentHash: "h1", Version: "v1"}
	payload := []byte(`{"loc":10}`)
	s.Put(k, payload)

	got, ok := s.Get(k)
	if !ok {
		t.Fatalf("Get after Put should hit")
	}
	if string(got) != string(payload) {
		t.Fatalf("Get payload = %q, want %q", got, payload)
	}

	st := s.Stats()
	if st.Hits != 1 || st.Entries != 1 || st.Dropped != 0 {
		t.Fatalf("Stats = %+v, want Hits=1 Entries=1 Dropped=0", st)
	}
}

func TestSnapshotContentHashMismatchIsMiss(t *testing.T) {
	s := NewSnapshot()
	k := Key{Path: "a.go", ContentHash: "h1", Version: "v1"}
	s.Put(k, []byte(`{"loc":10}`))

	if _, ok := s.Get(Key{Path: "a.go", ContentHash: "h2", Version: "v1"}); ok {
		t.Fatalf("Get with a different content hash should miss")
	}
}

func TestSnapshotVersionMismatchIsMiss(t *testing.T) {
	s := NewSnapshot()
	k := Key{Path: "a.go", ContentHash: "h1", Version: "v1"}
	s.Put(k, []byte(`{"loc":10}`))

	if _, ok := s.Get(Key{Path: "a.go", ContentHash: "h1", Version: "v2"}); ok {
		t.Fatalf("Get with a different version should miss")
	}
}

func TestSnapshotDroppedTracksUntouchedEntries(t *testing.T) {
	s := NewSnapshot()
	s.entries["untouched.go"] = record{
		key:     Key{Path: "untouched.go", ContentHash: "h1", Version: "v1"},
		payload: []byte(`{}`),
		live:    false,
	}
	st := s.Stats()
	if st.Dropped != 1 || st.Entries != 1 {
		t.Fatalf("Stats = %+v, want Dropped=1 Entries=1", st)
	}
}

// TestSnapshotConcurrentAccess exercises Get/Put from many goroutines over a
// shared set of keys. Run with -race to prove there is no data race; the
// assertions on top additionally prove Get/Put stay correct under
// contention (not just race-clean).
func TestSnapshotConcurrentAccess(t *testing.T) {
	const goroutines = 64
	const keysPerGoroutine = 20

	s := NewSnapshot()
	var wg sync.WaitGroup

	// Phase 1: concurrent Put of disjoint keys.
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < keysPerGoroutine; i++ {
				path := fmt.Sprintf("g%d/f%d.go", g, i)
				k := Key{Path: path, ContentHash: "h", Version: "v1"}
				s.Put(k, []byte(fmt.Sprintf(`{"n":%d}`, g*keysPerGoroutine+i)))
			}
		}(g)
	}
	wg.Wait()

	// Phase 2: concurrent Get of the same disjoint keys, plus concurrent Put
	// of a shared hot key, all at once — this is the part that would panic
	// or corrupt state under a real race.
	hot := Key{Path: "hot.go", ContentHash: "h", Version: "v1"}
	for g := 0; g < goroutines; g++ {
		wg.Add(2)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < keysPerGoroutine; i++ {
				path := fmt.Sprintf("g%d/f%d.go", g, i)
				k := Key{Path: path, ContentHash: "h", Version: "v1"}
				got, ok := s.Get(k)
				if !ok {
					t.Errorf("Get(%s) miss, want hit", path)
					return
				}
				want := fmt.Sprintf(`{"n":%d}`, g*keysPerGoroutine+i)
				if string(got) != want {
					t.Errorf("Get(%s) = %q, want %q", path, got, want)
				}
			}
		}(g)
		go func(g int) {
			defer wg.Done()
			s.Put(hot, []byte(fmt.Sprintf(`{"writer":%d}`, g)))
			_, _ = s.Get(hot)
			_ = s.Stats()
		}(g)
	}
	wg.Wait()

	if _, ok := s.Get(hot); !ok {
		t.Fatalf("hot key should be present after concurrent Puts")
	}
}
