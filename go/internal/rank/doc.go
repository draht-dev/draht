// Package rank computes the graph-derived, non-cluster rollups of MAP.json:
// the four "hotspots" lists (godNodes / mostDependedOn / orchestrators /
// largest), the top-level entryPoints and sinks projections, and the
// multi-source BFS that fills modules[*].depth.
//
// Every exported function here is pure: slices/maps in, records out, no
// file I/O, no goroutines, no reliance on Go map iteration order (every
// emitted collection is sorted explicitly, mirroring the CJS engine's
// sort/tie-break rules verbatim — see the doc comments on Hotspots,
// Surprising-adjacent constants are intentionally NOT here; clustering
// lives in internal/cluster).
//
// This package depends only on internal/model and the standard library. It
// must never import internal/cluster.
package rank
