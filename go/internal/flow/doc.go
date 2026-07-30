// Package flow ports the CJS engine's swim-lane flow graph
// (draht-tools.cjs:2536-2890): one BFS-derived "flow" per entry point, the 6
// fixed architectural "lanes", and the "boxes" (actor / package / sink
// nodes) that a swim-lane viewer positions on those lanes.
//
// Every exported function is pure: it takes slices/maps in and returns
// records out, performing no I/O and touching no package-level mutable
// state. Determinism (a hard requirement — see the design's jobs=1 vs
// jobs=8 byte-identical gate) is maintained by never ranging over a Go map
// to produce output order; every ordered collection in this package is
// tracked as an explicit slice alongside its membership map.
package flow
