// Package cluster ports the CJS engine's label-propagation clustering
// (visComputeClusters / visPropagateLabels, draht-tools.cjs lines
// 1851-2027) plus the cluster-derived surprisingConnections computation
// (visComputeSurprising, cjs:2029-2063).
//
// Every exported function is pure: no I/O, no goroutines, no package-level
// mutable state. Determinism is the entire point of this package — Go map
// iteration order is never relied upon for output content or order; every
// emitted collection is either produced via an order-invariant argmax fold
// (see PropagateLabels) or explicitly sorted before being returned.
//
// # Deviation from the assigned GO SIGNATURES: Cluster is a package-local type
//
// The task's authoritative spec asks for `Compute` to return
// `[]model.Cluster`, matching a `model.Cluster` that carries 7 fields
// (id, label, size, members, dominantPackage, dominantLayer, packages).
// The `model.Cluster` type that actually exists in this worktree
// (go/internal/model/map.go) only has 4 fields (ID, Label, Size, Members) —
// it predates this task's spec.
//
// UPDATE (integration): model.Cluster has since been extended to the full
// 7-field shape (id, label, size, members, dominantPackage, dominantLayer,
// packages) that this package's Cluster type already carried. Result.Clusters
// intentionally stays the package-local Cluster type rather than switching to
// []model.Cluster directly — Cluster.ToModel() is the (now trivial, 1:1
// field-for-field) adapter the assembler calls at the internal/graph
// boundary, which keeps this package's own tests decoupled from model's
// wire-JSON concerns.
package cluster
