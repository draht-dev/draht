package cluster

import (
	"strings"

	"github.com/draht-dev/draht/go/internal/model"
)

// ContainerOf mirrors the assembler's containerOf (cjs:2355): "pkg:" +
// *m.Package when set, else "dir:" + the first path segment. Duplicated
// here (not imported from a container/assembler package) so this package
// stays a leaf with no dependency beyond internal/model and stdlib.
func ContainerOf(m *model.Module) string {
	if m.Package != nil && *m.Package != "" {
		return "pkg:" + *m.Package
	}
	first := m.Path
	if idx := strings.IndexByte(m.Path, '/'); idx >= 0 {
		first = m.Path[:idx]
	}
	return "dir:" + first
}

// Seed mirrors visClusterSeed (cjs:1892-1896): the first `depth` directory
// segments of id's dirname, joined by "/". Returns "" for a root-level file
// (no "/" in id) or when the dirname has no non-empty segments — both cases
// are "falsy" in the JS source and trigger the seedOf caller's
// containerOf(...) fallback.
func Seed(id string, depth int) string {
	idx := strings.LastIndexByte(id, '/')
	if idx < 0 {
		return ""
	}
	dirname := id[:idx]
	segs := splitNonEmpty(dirname)
	if depth > len(segs) {
		depth = len(segs)
	}
	if depth < 0 {
		depth = 0
	}
	return strings.Join(segs[:depth], "/")
}

// splitNonEmpty splits s on "/" and drops empty segments, mirroring JS
// `s.split("/").filter(Boolean)`.
func splitNonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "/")
	out := parts[:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// LongestCommonDirPrefix mirrors visLongestCommonDirPrefix (cjs:1898-1908):
// the longest shared leading run of directory segments across every member
// id's dirname, joined by "/". Returns "" when there is no common prefix or
// memberIDs is empty.
func LongestCommonDirPrefix(memberIDs []string) string {
	var common []string
	first := true
	for _, id := range memberIDs {
		var dirname string
		if idx := strings.LastIndexByte(id, '/'); idx >= 0 {
			dirname = id[:idx]
		}
		segs := splitNonEmpty(dirname)
		if first {
			common = segs
			first = false
			continue
		}
		j := 0
		for j < len(common) && j < len(segs) && common[j] == segs[j] {
			j++
		}
		common = common[:j]
		if len(common) == 0 {
			break
		}
	}
	return strings.Join(common, "/")
}
