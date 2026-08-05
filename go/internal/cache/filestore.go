package cache

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
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

// These bounds prevent a byte-bounded cache from amplifying into millions of
// per-line allocations or one pathological JSON token. They count every
// physical line, including blanks and corrupt records.
const (
	maxCacheLineBytes = 8 << 20
	maxCacheLines     = 262145 // one header plus at most 262144 entries
)

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
	maxLineBytes int   // zero uses maxCacheLineBytes
	maxLines     int   // zero uses maxCacheLines
}

var errCacheTooLarge = errors.New("cache output exceeds size limit")

type boundedWriter struct {
	w         io.Writer
	remaining int64
}

type countingReader struct {
	r io.Reader
	n int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	r.n += int64(n)
	return n, err
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
	fileLimit := f.maxFileBytes
	if fileLimit == 0 {
		fileLimit = maxCacheFileBytes
	}
	if info.Size() > fileLimit {
		return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d bytes, treating as cold", path, fileLimit)
	}

	var reader io.ReadCloser
	if f.readFile != nil {
		data, readErr := f.readFile(path)
		if readErr != nil {
			if os.IsNotExist(readErr) {
				return NewSnapshot(), nil
			}
			return NewSnapshot(), fmt.Errorf("cache: read %s: %w", path, readErr)
		}
		if int64(len(data)) > fileLimit {
			return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d bytes, treating as cold", path, fileLimit)
		}
		reader = io.NopCloser(bytes.NewReader(data))
	} else {
		file, openErr := os.Open(path)
		if openErr != nil {
			if os.IsNotExist(openErr) {
				return NewSnapshot(), nil
			}
			return NewSnapshot(), fmt.Errorf("cache: read %s: %w", path, openErr)
		}
		reader = file
	}
	defer reader.Close()

	lineLimit := f.maxLineBytes
	if lineLimit == 0 {
		lineLimit = maxCacheLineBytes
	}
	lineCountLimit := f.maxLines
	if lineCountLimit == 0 {
		lineCountLimit = maxCacheLines
	}

	// Read at most one byte past the accepted file budget so growth between
	// Stat and Open is detected. Scanner retains only the current line; entries
	// are decoded directly into the final map instead of bytes.Split plus an
	// all-results array proportional to the physical line count.
	counter := &countingReader{r: io.LimitReader(reader, fileLimit+1)}
	scanner := bufio.NewScanner(counter)
	initialBuffer := 64 << 10
	if lineLimit+1 < initialBuffer {
		initialBuffer = lineLimit + 1
	}
	scanner.Buffer(make([]byte, initialBuffer), lineLimit+1)

	lineNo := 0
	entries := make(map[string]record)
	var hdr fileHeader
	for scanner.Scan() {
		lineNo++
		if lineNo > lineCountLimit {
			return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d lines, treating as cold", path, lineCountLimit)
		}
		line := scanner.Bytes()
		if len(line) > lineLimit {
			return NewSnapshot(), fmt.Errorf("cache: %s line %d exceeds %d bytes, treating as cold", path, lineNo, lineLimit)
		}
		if lineNo == 1 {
			if err := json.Unmarshal(line, &hdr); err != nil || hdr.V != cacheFormatVersion {
				return NewSnapshot(), fmt.Errorf("cache: %s has an invalid or unsupported header (v=%d): %w", path, hdr.V, err)
			}
			if hdr.Entries+1 > lineCountLimit {
				return NewSnapshot(), fmt.Errorf("cache: %s header declares %d entries above line limit %d", path, hdr.Entries, lineCountLimit-1)
			}
			continue
		}
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
		// Original line order is preserved, so duplicate paths deterministically
		// retain the later occurrence (Commit never produces duplicates).
		entries[e.Path] = record{
			key:     Key{Path: e.Path, ContentHash: e.ContentHash, Version: e.Version},
			payload: append([]byte(nil), e.Payload...),
			live:    false,
		}
	}
	if err := scanner.Err(); err != nil {
		return NewSnapshot(), fmt.Errorf("cache: scan %s: %w", path, err)
	}
	if counter.n > fileLimit {
		return NewSnapshot(), fmt.Errorf("cache: %s exceeds %d bytes, treating as cold", path, fileLimit)
	}
	if lineNo == 0 {
		return NewSnapshot(), fmt.Errorf("cache: %s is empty", path)
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
