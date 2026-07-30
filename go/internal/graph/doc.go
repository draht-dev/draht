// Package graph orchestrates the pipeline: discovery, cache load, the
// bounded-worker-pool extraction stage, specifier-to-module resolution, and
// edge/stat assembly. It is the only package that imports model, scan,
// extract, and cache together.
package graph
