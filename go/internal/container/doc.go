// Package container derives the MAP.json container/group/containerEdge layer
// from an already-assembled module + edge graph: `containers` (packages, or
// top-level directories as a single-package fallback), `groups` (functional
// clusters of containers, with a `.planning/codebase/GROUPS.json` curation
// merge), the `boundedContexts` alias (the same slice as `containers`, wired
// by the caller), and `containerEdges` (import/call edges collapsed to the
// container level).
//
// Every exported function here is pure: no file I/O, no globals, no
// goroutines. Callers inject anything that would otherwise require I/O (the
// GROUPS.json bytes, a package.json "bin" probe) as a parameter.
//
// Verbatim port of draht-tools.cjs's containers/deriveGroups/
// applyGroupsCuration/containerEdges block (lines ~1119-1243 and
// ~2328-2496). See the Phase 2 container work-package spec for line-level
// citations.
package container
