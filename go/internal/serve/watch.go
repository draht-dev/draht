package serve

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/draht-dev/draht/go/internal/scan"
)

// watchExtSet/watchManifestSet are derived from scan.LangByExt/CodeLangs and
// scan.WatchManifests, mirroring VIS_WATCH_EXTS/VIS_WATCH_MANIFESTS
// (draht-tools.cjs:5157-5160): only code-language files and workspace
// manifests trigger a rebuild.
var watchExtSet, watchManifestSet = buildWatchSets()

// planningWatchInputs are the planning files consumed by graph generation.
// Keep generated MAP/HTML/report/cache files out of this list so a rebuild
// cannot trigger itself.
var planningWatchInputs = []string{
	filepath.Join(scan.PlanningDir, "STATE.md"),
	filepath.Join(scan.PlanningDir, "ROADMAP.md"),
	filepath.Join(scan.PlanningDir, "PROJECT.md"),
	filepath.Join(scan.PlanningDir, "DOMAIN.md"),
	filepath.Join(scan.PlanningDir, "DOMAIN-MODEL.md"),
	filepath.Join(scan.PlanningDir, "codebase", "GROUPS.json"),
	filepath.Join(scan.PlanningDir, "codebase", "FLOWS.json"),
}

func buildWatchSets() (map[string]struct{}, map[string]struct{}) {
	codeLangs := make(map[scan.Lang]struct{}, len(scan.CodeLangs))
	for _, l := range scan.CodeLangs {
		codeLangs[l] = struct{}{}
	}
	exts := make(map[string]struct{})
	for ext, lang := range scan.LangByExt {
		if _, ok := codeLangs[lang]; ok {
			exts[ext] = struct{}{}
		}
	}
	manifests := make(map[string]struct{}, len(scan.WatchManifests))
	for _, m := range scan.WatchManifests {
		manifests[m] = struct{}{}
	}
	return exts, manifests
}

func isWatchedFile(relPath string) bool {
	base := filepath.Base(relPath)
	if _, ok := watchManifestSet[base]; ok {
		return true
	}
	_, ok := watchExtSet[strings.ToLower(filepath.Ext(base))]
	return ok
}

// fileSig is a cheap per-file change signature (size + mtime); good enough
// to detect edits/creates/deletes without hashing file content.
type fileSig struct {
	size  int64
	mtime int64
}

// snapshotWatched walks root (scan.Walk already excludes node_modules,
// .git, .planning and the rest of DefaultIgnores) and returns a signature
// for every watched source plus the explicit non-output planning inputs.
func snapshotWatched(root string) (map[string]fileSig, error) {
	res, err := scan.Walk(scan.WalkOptions{Root: root})
	if err != nil {
		return nil, err
	}
	out := make(map[string]fileSig, len(res.Files))
	for _, rel := range res.Files {
		if !isWatchedFile(rel) {
			continue
		}
		info, statErr := os.Stat(filepath.Join(root, rel))
		if statErr != nil {
			continue
		}
		out[rel] = fileSig{size: info.Size(), mtime: info.ModTime().UnixNano()}
	}
	for _, rel := range planningWatchInputs {
		info, statErr := os.Stat(filepath.Join(root, rel))
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		out[rel] = fileSig{size: info.Size(), mtime: info.ModTime().UnixNano()}
	}
	return out, nil
}

func equalSnapshots(a, b map[string]fileSig) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if v2, ok := b[k]; !ok || v != v2 {
			return false
		}
	}
	return true
}

// startPollWatcher is this port's replacement for the CJS's recursive
// fs.watch: rather than depending on an OS-level recursive-watch API (not
// uniformly available across platforms without a third-party package, which
// this module may not add — see design constraints), it periodically
// re-walks the repo and diffs watched-file signatures. Simpler and slightly
// higher-latency than an event-driven watch, which is an acceptable
// trade-off for a local dev server (per the task's "keep it simple"
// guidance); onChange is called (from a background goroutine, so it must be
// safe to call concurrently with everything else) whenever the signature
// set changes. Returns false if the very first snapshot fails (mirrors the
// CJS's "no watchers could be installed" fallback message).
func startPollWatcher(ctx context.Context, root string, interval time.Duration, onChange func()) bool {
	prev, err := snapshotWatched(root)
	if err != nil {
		return false
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cur, err := snapshotWatched(root)
				if err != nil {
					continue
				}
				if !equalSnapshots(prev, cur) {
					prev = cur
					onChange()
				}
			}
		}
	}()
	return true
}
