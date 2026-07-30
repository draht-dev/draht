package graph

import (
	"os"
	"sync"

	"github.com/draht-dev/draht/go/internal/model"
	"github.com/draht-dev/draht/go/internal/scan"
	"github.com/draht-dev/draht/go/internal/symindex"
)

// buildRationaleAll scans EVERY discovered file (not just code modules —
// draht-tools.cjs:2159 runs this over markdown/html/sql too) with a
// recognised comment style for inline SECURITY/BUG/.../WHY markers, in a
// bounded worker pool. Results are index-addressed (like extractAll) so the
// flattened output is always in `files` order (path ascending), regardless
// of goroutine completion order — required for symindex.BuildRationaleIndex's
// stable (severity, file, line, scan-order) tie-break.
//
// This is deliberately NOT cached (unlike extract.Facts): rationale hits are
// a cheap regex scan and caching them would mean threading a second,
// content-hash-keyed payload through the cache store for comparatively
// little payoff. The cost is an extra full read of every eligible file on
// EVERY run, warm or cold — see go/README.md's honest accounting of this
// tradeoff.
func buildRationaleAll(files []scan.File, workers int) []model.RationaleEntry {
	if len(files) == 0 {
		return nil
	}
	results := make([][]model.RationaleEntry, len(files))

	jobs := make(chan int, workers*4)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = rationaleForFile(files[i])
			}
		}()
	}
	for i := range files {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	var all []model.RationaleEntry
	for _, r := range results {
		all = append(all, r...)
	}
	return all
}

// rationaleForFile returns f's rationale hits, or nil when f is unreadable
// (design's Readable() gate, mirroring `size < 1024*1024`), its language has
// no recognised comment style, or a filesystem read fails (swallowed, same
// posture as extractOne's own read-error handling).
func rationaleForFile(f scan.File) []model.RationaleEntry {
	if !f.Readable() {
		return nil
	}
	if _, ok := symindex.StyleFor(string(f.Lang)); !ok {
		return nil
	}
	content, err := os.ReadFile(f.Abs)
	if err != nil {
		return nil
	}
	hits := symindex.ExtractRationale(content, string(f.Lang))
	if len(hits) == 0 {
		return nil
	}
	return symindex.HitsToEntries(f.Rel, hits)
}
