package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
)

// cacheFileName is the single NDJSON file a fileStore reads and writes,
// rooted at the store's directory.
const cacheFileName = "facts.ndjson"

// cacheFormatVersion is the header "v" field. Bump only if the on-disk
// record shape (diskEntry / fileHeader) changes in a way old readers cannot
// tolerate; per-entry invalidation is handled by Key.Version, not this.
const cacheFormatVersion = 1

// cacheTool is the header "tool" field; informational only.
const cacheTool = "draht-graph"

// maxCacheFileBytes guards against reading a pathologically large or
// corrupted cache file into memory. Exceeding it is treated exactly like any
// other corruption: an empty snapshot and an advisory error.
const maxCacheFileBytes = 128 << 20 // 128 MiB

// fileHeader is line 1 of facts.ndjson.
type fileHeader struct {
	V       int    `json:"v"`
	Tool    string `json:"tool"`
	Entries int    `json:"entries"`
}

// diskEntry is one entry line (lines 2..N) of facts.ndjson. Payload is kept
// as raw JSON so this package never needs to know the shape of the extractor
// payload it stores.
type diskEntry struct {
	Path        string          `json:"p"`
	ContentHash string          `json:"h"`
	Version     string          `json:"k"`
	Payload     json.RawMessage `json:"f"`
}

type fileStore struct {
	dir          string
	readFile     func(string) ([]byte, error)
	maxFileBytes int64 // zero uses maxCacheFileBytes; tests may exercise small boundaries
}

var errCacheTooLarge = errors.New("cache output exceeds size limit")

type boundedWriter struct {
	w         io.Writer
	remaining int64
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errCacheTooLarge
	}
	n, err := w.w.Write(p)
	w.remaining -= int64(n)
	return n, err
}

// NewFileStore returns the NDJSON store rooted at dir. It creates dir and a
// self-ignoring dir/.gitignore containing "*\n" on first Commit.
func NewFileStore(dir string) Store {
	return &fileStore{dir: dir}
}

func (f *fileStore) path() string {
	return filepath.Join(f.dir, cacheFileName)
}

// Load implements Store. Per the CONTRACT on Store, it never fails fatally:
// a missing, oversized, truncated, or header-corrupt file yields an empty
// Snapshot. A non-nil error is purely advisory (surfaced under --verbose);
// callers must not treat it as fatal. Individual entry lines that fail to
// parse, or that are missing a required field, are skipped silently — they
// simply become cache misses.
func (f *fileStore) Load(ctx context.Context) (*Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return NewSnapshot(), err
	}

	path := f.path()
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewSnapshot(), nil
		}
		return NewSnapshot(), fmt.Errorf("cache: read %s: %w", path, err)
	}
	if info.Size() > maxCacheFileBytes {
		return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d bytes, treating as cold", path, maxCacheFileBytes)
	}

	readFile := f.readFile
	if readFile == nil {
		readFile = func(path string) ([]byte, error) {
			file, err := os.Open(path)
			if err != nil {
				return nil, err
			}
			defer file.Close()
			// Read one byte beyond the accepted limit so growth between Stat and
			// Open is detected without ever allocating the remainder of the file.
			return io.ReadAll(io.LimitReader(file, maxCacheFileBytes+1))
		}
	}
	data, err := readFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewSnapshot(), nil
		}
		// Any other read error (permissions, I/O) degrades to a cold cache;
		// it is not this caller's job to fail the whole index build.
		return NewSnapshot(), fmt.Errorf("cache: read %s: %w", path, err)
	}
	if len(data) > maxCacheFileBytes {
		return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d bytes, treating as cold", path, maxCacheFileBytes)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return NewSnapshot(), fmt.Errorf("cache: %s is empty", f.path())
	}

	lines := bytes.Split(data, []byte("\n"))
	var hdr fileHeader
	if err := json.Unmarshal(lines[0], &hdr); err != nil || hdr.V != cacheFormatVersion {
		return NewSnapshot(), fmt.Errorf("cache: %s has an invalid or unsupported header (v=%d): %w", f.path(), hdr.V, err)
	}
	lines = lines[1:]
	// Drop a trailing blank line (Commit's Encoder appends a final "\n") and
	// any other blank line so a truncated write does not spawn a spurious
	// entry.
	for len(lines) > 0 && len(bytes.TrimSpace(lines[len(lines)-1])) == 0 {
		lines = lines[:len(lines)-1]
	}

	type parsed struct {
		ok bool
		e  diskEntry
	}
	results := make([]parsed, len(lines))
	if len(lines) > 0 {
		workers := runtime.GOMAXPROCS(0)
		if workers < 1 {
			workers = 1
		}
		if workers > len(lines) {
			workers = len(lines)
		}

		jobs := make(chan int, workers)
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range jobs {
					line := lines[i]
					if len(bytes.TrimSpace(line)) == 0 {
						continue
					}
					var e diskEntry
					if err := json.Unmarshal(line, &e); err != nil {
						continue // corrupt line => that entry is a miss, never fatal
					}
					if e.Path == "" || e.ContentHash == "" || e.Version == "" {
						continue // incomplete record => miss
					}
					results[i] = parsed{ok: true, e: e}
				}
			}()
		}
		for i := range lines {
			jobs <- i
		}
		close(jobs)
		wg.Wait()
	}

	// Build the map single-threaded, in original line order, so that if the
	// same path somehow appears twice the later occurrence wins
	// deterministically (Commit itself never produces duplicates).
	entries := make(map[string]record, len(results))
	for _, p := range results {
		if !p.ok {
			continue
		}
		entries[p.e.Path] = record{
			key:     Key{Path: p.e.Path, ContentHash: p.e.ContentHash, Version: p.e.Version},
			payload: append([]byte(nil), p.e.Payload...),
			live:    false,
		}
	}

	return &Snapshot{entries: entries}, nil
}

// Commit implements Store. It is atomic (temp file + rename) and
// deterministic: entries are sorted by Path before encoding, so an identical
// Snapshot always produces a byte-identical file. Only entries touched by
// Get or Put during this run (Snapshot's "live" set) are written; anything
// loaded but never referenced is dropped. Encoding streams through a bounded
// writer, so Commit can never produce a file Load rejects. If the live set
// exceeds the reader's limit, Commit removes both its temporary output and any
// prior cache: the next run is deliberately cold rather than repeatedly
// loading stale data.
func (f *fileStore) Commit(ctx context.Context, s *Snapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	live := s.liveEntries()
	sort.Slice(live, func(i, j int) bool { return live[i].key.Path < live[j].key.Path })

	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		return fmt.Errorf("cache: mkdir %s: %w", f.dir, err)
	}

	gitignorePath := filepath.Join(f.dir, ".gitignore")
	if _, err := os.Stat(gitignorePath); os.IsNotExist(err) {
		if werr := os.WriteFile(gitignorePath, []byte("*\n"), 0o644); werr != nil {
			return fmt.Errorf("cache: write %s: %w", gitignorePath, werr)
		}
	} else if err != nil {
		return fmt.Errorf("cache: stat %s: %w", gitignorePath, err)
	}

	tmpPath := filepath.Join(f.dir, fmt.Sprintf(".%s.tmp-%d", cacheFileName, os.Getpid()))
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("cache: create temp file: %w", err)
	}
	removeTmp := true
	defer func() {
		_ = tmp.Close()
		if removeTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	limit := f.maxFileBytes
	if limit == 0 {
		limit = maxCacheFileBytes
	}
	bw := &boundedWriter{w: tmp, remaining: limit}
	enc := json.NewEncoder(bw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(fileHeader{V: cacheFormatVersion, Tool: cacheTool, Entries: len(live)}); err != nil {
		return f.commitEncodeError(tmp, tmpPath, err, "header")
	}
	for _, r := range live {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := writeDiskEntry(bw, r); err != nil {
			return f.commitEncodeError(tmp, tmpPath, err, fmt.Sprintf("entry %q", r.key.Path))
		}
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("cache: close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, f.path()); err != nil {
		return fmt.Errorf("cache: rename temp file into place: %w", err)
	}
	removeTmp = false
	return nil
}

func (f *fileStore) commitEncodeError(tmp *os.File, tmpPath string, err error, what string) error {
	if errors.Is(err, errCacheTooLarge) {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		if removeErr := os.Remove(f.path()); removeErr != nil && !os.IsNotExist(removeErr) {
			return fmt.Errorf("cache: encode %s: %w (also failed to clear prior cache: %v)", what, err, removeErr)
		}
	}
	return fmt.Errorf("cache: encode %s: %w", what, err)
}

// writeDiskEntry streams the potentially large raw payload instead of asking
// encoding/json to allocate a second, serialized copy of the whole entry.
func writeDiskEntry(w io.Writer, r record) error {
	payload := r.payload
	if len(payload) == 0 {
		payload = []byte("null")
	}
	if !json.Valid(payload) {
		return fmt.Errorf("invalid payload JSON")
	}
	fields := []struct {
		prefix string
		value  string
	}{
		{`{"p":`, r.key.Path},
		{`,"h":`, r.key.ContentHash},
		{`,"k":`, r.key.Version},
	}
	for _, field := range fields {
		if _, err := io.WriteString(w, field.prefix); err != nil {
			return err
		}
		var encoded bytes.Buffer
		enc := json.NewEncoder(&encoded)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(field.value); err != nil {
			return err
		}
		quoted := bytes.TrimSuffix(encoded.Bytes(), []byte("\n"))
		if _, err := w.Write(quoted); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(w, `,"f":`); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	_, err := io.WriteString(w, "}\n")
	return err
}

// Purge deletes the on-disk cache directory (and everything in it,
// including a stray temp file from an interrupted Commit). It is the
// mechanism behind a "--purge-cache" / "graph-cache clear" style operation.
// A non-existent directory is not an error.
func Purge(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("cache: purge %s: %w", dir, err)
	}
	return nil
}
