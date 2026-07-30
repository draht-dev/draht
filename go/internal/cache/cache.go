package cache

import (
	"context"
	"strconv"
	"sync"
)

// Key identifies one cached per-file extraction payload.
// Two entries with equal Keys are interchangeable; a mismatch in ANY field
// is a miss.
type Key struct {
	Path        string // repo-relative POSIX path (identity)
	ContentHash string // lowercase hex sha256 of the raw file bytes (64 chars)
	Version     string // producer version; see ComposeVersion
}

// Stats is observability for the CLI's "(cache: N hit / M miss)" line.
type Stats struct {
	Entries int // entries present after the run
	Hits    int
	Misses  int
	Dropped int // loaded entries not referenced this run (evicted at Commit)
}

type record struct {
	key     Key
	payload []byte
	live    bool
}

// Snapshot is an in-memory working set. Get/Put are safe for concurrent use
// by the worker pool. Get marks the entry live; unreferenced entries are
// dropped by Commit.
type Snapshot struct {
	mu      sync.RWMutex
	entries map[string]record // keyed by Key.Path
	hits    int
	misses  int
}

// NewSnapshot returns an empty snapshot. Store implementations use this to
// build the value returned from Load.
func NewSnapshot() *Snapshot {
	return &Snapshot{entries: make(map[string]record)}
}

// Get looks up k by Path and validates ContentHash + Version. A match marks
// the entry live (it survives Commit); any mismatch counts as a miss.
func (s *Snapshot) Get(k Key) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.entries[k.Path]
	if !ok || r.key.ContentHash != k.ContentHash || r.key.Version != k.Version {
		s.misses++
		return nil, false
	}
	r.live = true
	s.entries[k.Path] = r
	s.hits++
	return r.payload, true
}

// Put inserts or replaces the entry for k.Path and marks it live.
func (s *Snapshot) Put(k Key, payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[k.Path] = record{key: k, payload: payload, live: true}
}

// Stats reports current entry/hit/miss/dropped counts.
func (s *Snapshot) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	dropped := 0
	for _, r := range s.entries {
		if !r.live {
			dropped++
		}
	}
	return Stats{Entries: len(s.entries), Hits: s.hits, Misses: s.misses, Dropped: dropped}
}

// liveEntries returns the entries touched by Get or Put during this run.
// Store implementations sort this by Path before persisting (see
// filestore.go).
func (s *Snapshot) liveEntries() []record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]record, 0, len(s.entries))
	for _, r := range s.entries {
		if r.live {
			out = append(out, r)
		}
	}
	return out
}

// Store is the persistence seam.
//
// CONTRACT:
//   - Load NEVER fails fatally: a missing, truncated, corrupt, or version-
//     mismatched cache yields an empty Snapshot and a nil error. A returned
//     error means only "the caller may want to log this"; the Snapshot is
//     valid.
//   - Commit is atomic (temp file + rename) and deterministic: identical
//     Snapshot content => byte-identical file.
//   - Commit writes ONLY entries touched by Get or Put during this run.
type Store interface {
	Load(ctx context.Context) (*Snapshot, error)
	Commit(ctx context.Context, s *Snapshot) error
}

// ComposeVersion builds Key.Version from its parts. Callers MUST use it so
// the format stays consistent: "f<factsSchema>|p<parserVersion>|x<extractVersion>".
func ComposeVersion(factsSchema int, parserVersion, extractVersion string) string {
	return "f" + strconv.Itoa(factsSchema) + "|p" + parserVersion + "|x" + extractVersion
}

type memStore struct{}

// NewMemStore is a non-persistent Store for tests: Load always returns a
// fresh empty snapshot and Commit is a no-op.
func NewMemStore() Store { return memStore{} }

func (memStore) Load(ctx context.Context) (*Snapshot, error)   { return NewSnapshot(), nil }
func (memStore) Commit(ctx context.Context, s *Snapshot) error { return nil }

type nopStore struct{}

// NewNopStore always Loads empty and never writes. Used by --no-cache.
func NewNopStore() Store { return nopStore{} }

func (nopStore) Load(ctx context.Context) (*Snapshot, error)   { return NewSnapshot(), nil }
func (nopStore) Commit(ctx context.Context, s *Snapshot) error { return nil }
