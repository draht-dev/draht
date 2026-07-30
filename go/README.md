# go — the Go knowledge-graph engine

This module replaces the hand-rolled-regex knowledge-graph engine inside
`packages/draht-tools/bin/draht-tools.cjs` (`map-codebase`, `map-graph`,
`graph-*`) with real AST parsing (via
[gotreesitter](https://github.com/odvcencio/gotreesitter)), goroutine
concurrency, a clean multi-package architecture, and an incremental
content-hash cache.

**Status: Phase 1 implemented, scoped.** This is NOT a scaffold of stubs —
`map-graph` is a real, working, tested end-to-end pipeline: real
gotreesitter AST parsing, a bounded worker pool, a content-hash incremental
cache, and a schemaVersion-5 `MAP.json` writer. `go test ./...` and the CJS
byte-parity gate (`make parity`) both pass. The CJS engine at
`packages/draht-tools/` is untouched and keeps working alongside it.

What Phase 1 deliberately does NOT implement yet (Phase-2 scope, tracked as
future work, not bugs): 13 of `MAP.json`'s 27 top-level fields are always
emitted as empty arrays — `groups`, `containers`, `boundedContexts`,
`callEdges`, `containerEdges`, `entryPoints`, `sinks`, `flows`, `boxes`,
`symbolIndex`, `clusters`, `surprisingConnections`, `rationaleIndex` — and
every `modules[*].depth`/`modules[*].cluster` is always `null`. Only the
module/package/import-edge surface (`modules[]`, `packages[]`, `edges[]`,
`stats`, `assets`) is real. This means the Go engine is not yet a
replacement for `map-serve`, `graph-clusters`, `graph-callers`,
`graph-callees`, or anything that reads clustering/symbol-index/call-graph
data — schemaVersion 5 shape-matching the reference `MAP.json` is true at
the top-level-key level, but is NOT the same claim as content/feature
parity. See `internal/graph/stats.go` and `internal/model/map.go`'s
`NewMap` for exactly where these are pinned to their Phase-1 zero values.

## Why this lives outside `packages/`

`npm`/`bun` workspaces glob `packages/*`, and `scripts/sync-versions.js` +
`scripts/publish-workspaces.mjs` both `readdir` `packages/` expecting a
`package.json` in every subdirectory. Putting a Go module there would break
both. `quest/` (the Kotlin/Quest 3 module) is the existing precedent for a
non-npm toolchain living at the repo root instead.

## Build

Go 1.26.4 is not on `PATH` by default on this box, and there is **no C
compiler** (cc/gcc/clang are all absent) — `CGO_ENABLED=0` is mandatory for
every Go command run in this repo.

```sh
export PATH="/nix/store/gb0njhqswlc5n127ikgyikvq39r40l6f-go-1.26.4/bin:$PATH"
export CGO_ENABLED=0
cd go
go build ./...
go vet ./...
go test ./...
```

Or, equivalently, via the Makefile (which sets `PATH`/`CGO_ENABLED` itself):

```sh
cd go
make build   # -> bin/draht-tools, 6-grammar subset (typescript/tsx/javascript/python/go/rust)
make test
make vet
make parity  # Go(--parser=regex) vs the real CJS engine's MAP.json (modules[]/packages[]/edges[]/stats subset)
```

`make build-full` builds with no grammar tags (all 206 bundled grammars) —
it exists purely to make the size delta visible in review; Phase 1 never
ships it.

### `-race` is unavailable on this box, and what stands in for it

`go test -race ./...` cannot run here: it requires `CGO_ENABLED=1`, and this
box has no C compiler (`cc`/`gcc`/`clang` are all absent) — forcing
`CGO_ENABLED=1` fails at the `cgo: C compiler "gcc" not found` step. This is
an environment limitation, not something this module can work around.
`internal/graph/determinism_test.go`'s `TestBuild_JobsCountDoesNotAffectOutput`
is the designated substitute: it runs the full pipeline 5 times at `--jobs
1` and 5 times at `--jobs 8` over a fixture repo and asserts all 10 outputs
are byte-identical. This catches ordering-dependent nondeterminism (the
class of bug most likely to actually corrupt `MAP.json`) but — unlike
`-race`'s instrumentation — would not catch a data race that happens not to
produce an observable difference on a given run.

## Performance honesty statement

The CJS engine indexes this repo in **~622ms for ~1,340 modules** by
regex line-scanning the whole tree on every run — it is already fast.
**Cold** Go (full re-parse, no cache) is expected to be *slower* than that,
not faster: real AST parsing plus JSON serialization of a ~5.4MB MAP.json
costs more than one regex pass. The value proposition of this rewrite is
**correctness** (real AST vs regex heuristics — 9 of 14 listed languages
currently get zero import parsing under the CJS engine), **coverage**,
**architecture**, and the **incremental cache**: once warm, a repeated
invocation (e.g. the `gsd-post-phase` hook that runs `map-graph --quiet`
after every completed phase) is expected to land around 120-190ms, well
under the CJS engine's unconditional 622ms. Do not cite raw cold-build
speed as a reason to prefer this engine over the CJS one — cite the warm
path and the coverage/correctness gap instead.

## Package layout

```
go/
├── cmd/draht-tools/   CLI entrypoint; `map-graph` subcommand         [WP-D]
└── internal/
    ├── scan/    File discovery, language classification, manifests. [WP-A]
    ├── parse/   The Parser swap seam: tree-sitter + regex importers. [WP-B]
    ├── extract/ Per-file facts (exports/symbols/sinks/routes).      [WP-B]
    ├── cache/   Content-hash-keyed on-disk store for facts.         [WP-C]
    ├── model/   MAP.json schemaVersion-5 wire structs + writer.     [WP-D]
    └── graph/   Pipeline orchestration: worker pool, resolver.      [WP-D]
```

Dependency direction (no cycles, no shared "types" package):

```
cmd/draht-tools ──> graph ──> model
                      ├────> scan      (imports nothing but stdlib)
                      ├────> extract ──> parse   (imports gotreesitter only)
                      └────> cache     (imports nothing but stdlib)
```

`cache` is byte-oriented (`[]byte` payloads) so it never imports `extract`;
the codec lives in `extract`. This is what lets the four work packages
compile independently of one another once `go.mod`/`go.sum` exist.

## Dependency policy

The only direct dependency is `github.com/odvcencio/gotreesitter v0.47.1`,
pinned exactly (no `^`, no `latest`), with `go.sum` committed. **No other
direct dependency may be added.** The worker pool uses `sync.WaitGroup` +
channels from stdlib, not `x/sync`. If you think you need a new dependency,
that is a signal to stop and raise it rather than `go get` it — a second
implementer's parallel branch would otherwise conflict on `go.mod`/`go.sum`.
