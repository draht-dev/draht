# go — the Go knowledge-graph engine

This module replaces the hand-rolled-regex knowledge-graph engine inside
`packages/draht-tools/bin/draht-tools.cjs` (`map-codebase`, `map-graph`,
`graph-*`) with real AST parsing (via
[gotreesitter](https://github.com/odvcencio/gotreesitter)), goroutine
concurrency, a clean multi-package architecture, and an incremental
content-hash cache.

**Status: Phase 1 + Phase 2 + Phase 3 implemented.** This is NOT a scaffold
of stubs — `map-graph` is a real, working, tested end-to-end pipeline: real
gotreesitter AST parsing, a bounded worker pool, a content-hash incremental
cache, and a schemaVersion-5 `MAP.json` writer with 26 of its 28 top-level
fields populated (`tests` and `planning` are still Phase-1 stubs — see
below). `go test ./...` and the CJS byte-parity gate (`make parity`) both
pass. The CJS engine at `packages/draht-tools/` is untouched and keeps
working alongside it.

**What Phase 3 added.** `map-graph` now emits all three artifacts the CJS
engine does — `MAP.json`, `GRAPH_REPORT.md` (`internal/report`), and
`MAP.html` (`internal/htmlview`, which ships the CJS's ~2,000-line viewer
verbatim as an embedded asset rather than reimplementing it) — with the
same write-gating rules as `visWriteOutputs`: `GRAPH_REPORT.md` shares
`MAP.json`'s unchanged-gate (`internal/emit.WriteOutputs`), `MAP.html` is
rewritten unconditionally unless `--quiet`. Every `graph-*` query
subcommand is wired and byte-parity-tested against the real CJS engine:
`graph-context`, `graph-impact`, `graph-callers`, `graph-callees`,
`graph-path`, `graph-query`, `graph-hotspots`, `graph-clusters`
(`internal/query`), plus `graph-hook` (`internal/hook`) and `map-serve`
(`internal/serve`). `map-graph`'s own non-`--quiet` stdout (banner, the
"Wrote:" block listing all three artifact paths, the summary line, the
"Read the report:" footer) was also brought into parity with the CJS
engine's exact wording — this had drifted in Phase 1/2 and is now fixed.
See "Byte-exact `graph-*` parity" below for what is and isn't covered.

**What Phase 2 added.** All 13 fields that Phase 1 always emitted as empty
arrays are now real: `groups`, `containers`, `boundedContexts`, `callEdges`,
`containerEdges`, `entryPoints`, `sinks`, `flows`, `boxes`, `symbolIndex`,
`clusters`, `surprisingConnections`, `rationaleIndex` — plus `lanes`,
`hotspots`, and per-module `modules[*].depth`/`modules[*].cluster`.
`internal/graph/parity_test.go`'s `TestParity_RegexParserMatchesCJSEngine`
(the `make parity` gate) asserts every one of those fields — plus
`root`/`packages`/`modules`/`edges`/a `stats` subset carried over from
Phase 1 — is **byte-identical** (order-sensitive, position-by-position) to
the real CJS engine's own `MAP.json` for this repo when the Go engine runs
with `--parser=regex` (the byte-parity oracle: `parse.NewRegex` is a
verbatim port of the CJS engine's own import-regex logic). This is enforced
by CI-equivalent automation, not just asserted in prose — run `make parity`
yourself to reproduce it.

**The default `--parser=treesitter` build is NOT held to that same
byte-parity bar, and the gap is large, not cosmetic.** Tree-sitter's richer
AST-based import extraction (real for 9 of 14 listed languages the CJS
regex engine cannot parse at all — see `testdata/ts-vs-regex-edges.md`)
produces a different edge set than the CJS engine's regex heuristic, and
because `depth`/`cluster`/`clusters`/`symbolIndex`/`flows`/
`surprisingConnections`/`containers`/`boxes`/`hotspots` are ALL derived from
the edge graph, that one upstream delta cascades into every one of them. A
snapshot measurement on this repo (1,479 modules; re-run `make parity` /
diff two fresh `map-graph` runs yourself for the current numbers — these
WILL drift as the repo grows and are not re-verified on every edit to this
file):

| field | cjs | go (treesitter) | positions differing |
|---|---|---|---|
| edges | 6205 | 6235 | n/a (count differs) |
| callEdges | 3580 | 3583 | n/a (count differs) |
| containerEdges | 36 | 37 | n/a (count differs) |
| modules[*].depth | — | — | 41 of 1479 |
| modules[*].cluster | — | — | 13 of 1479 |
| clusters | 96 | 96 | 53 of 96 |
| symbolIndex | 3100 | 3100 | 2051 of 3100 |
| flows | 37 | 37 | 13 of 37 |
| surprisingConnections | 20 | 20 | 12 of 20 |
| containers / boundedContexts | 38 | 38 | 5 of 38 |
| boxes | 47 | 47 | 2 of 47 |
| hotspots (4 lists, 15 each) | — | — | 2, 2, 3, 1 |
| groups | 6 | 6 | 0 |

If you need byte-parity with the CJS engine's output (e.g. for a
side-by-side diff during cutover evaluation), use `--parser=regex`. The
default `--parser=treesitter` is the intentionally-richer, intentionally-
divergent mode — prefer it for actual usage, not for parity comparisons.

New packages: `internal/cluster` (label-propagation clustering +
`surprisingConnections`), `internal/rank` (hotspots, entry points, sinks,
depth BFS), `internal/container` (containers/groups/containerEdges, plus
`GROUPS.json` curation), `internal/symindex` (symbolIndex + rationaleIndex),
`internal/flow` (flows/lanes/boxes, plus `FLOWS.json` curation),
`internal/rawobj` (the insertion-ordered JSON object type shared by
`internal/container`'s and `internal/flow`'s curation merges — see its
package doc comment). `callEdges` now flows from a real symbol-level regex
scan cached inside `extract.Facts.CallSites` (schema bumped 1→2) and joined
against resolved imports at assemble time — see
`internal/extract/callsites.go` and `internal/graph/edges.go`'s
`BuildCallEdgesAll`.

**What still does NOT exist** (tracked as future work, not bugs):
- `tests` (`{total, byContainer}`) and `planning`
  (`{hasProject, hasRoadmap, hasDomain, currentState}`) are still emitted as
  Phase-1 stubs — `tests.total`/`tests.byContainer` are always `0`/`{}`, and
  every `planning.*` field is always `false`/`""` — regardless of the real
  repo's test-file count or `.planning/` directory contents (pinned in
  `model.NewMap`, never overwritten by `Assemble`). These were outside
  Phase 2's 13-field brief and remain unimplemented.
- `map-codebase` (the narrative-docs analyzer) is a wholly separate CJS
  command from the `map-graph`/`graph-*`/`map-serve` family this port
  covers; it has no Go implementation and no spec was provided for one in
  Phase 3. Not started.
- `rationaleIndex`'s scan of non-code files (markdown/html/sql) is
  implemented but deliberately uncached — see `internal/graph/rationale.go`
  — which is the main driver of the warm-build regression noted below.
- `map-serve`'s live-reload watcher is a periodic re-walk-and-diff of
  watched-file signatures (`internal/serve/watch.go`), not an OS-level
  recursive filesystem watch — this module cannot add a new dependency
  (e.g. `fsnotify`) and Go's stdlib has no cross-platform recursive-watch
  primitive. Functionally equivalent (same debounce, same watched-extension
  filter, same ignore rules) but higher-latency (up to ~1s to notice a
  change, vs the CJS's near-instant `fs.watch` event) and not byte-tested
  against the CJS engine (`map-serve`'s own stdout is the lowest-priority
  surface per the Phase 3 consumer-risk ranking: no prompt file structurally
  parses it).
- `map-serve`'s `[HH:MM:SS] regenerated ...` line uses a fixed 24-hour
  `time.Format("15:04:05")` instead of the CJS's locale/TZ-dependent
  `toLocaleTimeString()` — deliberate, documented divergence (see
  `internal/serve/server.go`'s `regen` doc comment); that timestamp was
  never going to be byte-reproducible.
- `graph-hook install` interpolates the running Go binary's own path
  (`os.Executable()`) into the installed post-commit hook body instead of
  `node "<draht-tools.cjs path>"` — the one `graph-hook` output that cannot
  be byte-identical to the CJS engine by construction (see
  `internal/hook/hook.go`'s `buildHookBody` doc comment). The surrounding
  message text is unchanged and IS byte-identical.
- The top-level `help`/`-h`/`--help` text still only covers `map-graph`
  (`mapGraphUsage`); it does not yet list the `graph-*`/`graph-hook`/
  `map-serve` commands the way the CJS engine's `commands.help` does. None
  of the prompt files that structurally parse `graph-*` output depend on
  this text (see Phase 3 spec, consumer risk table), so it was left as-is
  rather than risking a change to an already-tested code path.

## Byte-exact `graph-*` parity

Roughly 30 prompt/skill markdown files across `packages/draht-claude/`,
`packages/draht-codex/` and `packages/coding-agent/prompts/` instruct an LLM
to run `graph-context`/`graph-impact`/`graph-callers`/`graph-callees`/
`graph-path`/`graph-query`/`graph-hotspots`/`graph-clusters` and parse their
stdout structurally — there is no schema and no test in those packages
protecting that text, so byte-exact stdout parity with the CJS engine's
`graph-*` commands is a hard requirement, not a nice-to-have. This is
enforced two ways:

1. `internal/query/golden_test.go`'s `TestGolden` — 52 cases captured
   verbatim from the live CJS engine against a frozen `testdata/MAP.json`
   snapshot, diffed byte-for-byte (first-differing-byte reporting, not a
   trimmed/normalized comparison).
2. A live side-by-side run of both engines against the SAME frozen
   `MAP.json` (so the two engines never disagree merely because the Go
   engine resolved more `export * from` re-export edges than the CJS regex
   — see the edge-count table above): every one of the 52 CLI invocations in
   the golden set, run through both `node draht-tools.cjs <cmd> <args>` and
   the compiled Go binary, byte-diffed on stdout AND exit code. All 52
   passed at the time of writing. `graph-hook install/uninstall/status`
   (throwaway `git init` temp repos, never the real repo) and the no-map /
   unknown-command paths were verified the same way.

What is **not** held to this bar, deliberately: `map-graph`'s own default
(AST-based, more re-export edges resolved) MAP.json content differs from
the CJS engine's by construction (see the edge-count table above) — so
`graph-context`/`graph-impact`/`graph-path` run against the Go engine's OWN
freshly-built `MAP.json` will legitimately return different importer/impact
counts than the same commands run against the CJS engine's own freshly-built
`MAP.json`, on files where those extra 30 edges land. That is the intended
correctness improvement, not a parity bug — the golden/side-by-side tests
above control for it by fixing the input `MAP.json`.

### `--symbol-signatures`, and why it is opt-in

`map-graph --symbol-signatures` records each symbol's declaration as written
— parameter list and return type included, body excluded — as
`modules[*].symbols[*].signature`, and `graph-context` then renders the
exports facet as a block of declarations instead of a comma-joined list of
bare names:

```
packages/ai/src/api/google-shared.ts  ·  pkg:@draht/ai  ·  layer:presentation  ·  …
  exports(11):
    export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean
    export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[]
    …
```

It is **off by default**, for the two reasons this document already cares
about:

- The CJS engine has no such field, so emitting it makes `MAP.json` diverge
  from it — the same reasoning as `--experimental-lang-edges`.
- `graph-context`'s stdout is parsed structurally by ~30 prompt/skill files
  (see above), and the block form is a different shape.

Both are enforced structurally rather than by convention. `model.Symbol`'s
`Signature` field is `omitempty` **and declared last** (`encoding/json`
emits fields in declaration order), so with the flag off the key is absent
and `modules[*].symbols` is byte-identical to the CJS engine's — which is
what lets `TestParity_RegexParserMatchesCJSEngine` keep asserting full
`DeepEqual` over `model.Module` with nothing normalized away. `graph-context`
likewise only switches to the block form when a signature is actually
present, so every map built without the flag — including every map the CJS
engine ever wrote — still renders through the original inline path and the
52 golden cases are untouched.

Note the split between extraction and emission: signatures are extracted
**unconditionally** (`extract.Symbol.Sig`) and only *emitted* under the flag
(`graph.convertSymbols`). That is deliberate — it keeps a cache entry valid
whether or not the run that produced it had the flag on, so toggling the
flag never serves stale facts. `FactsSchema` 2→3 and `extract.Version`
`x2`→`x3` invalidate the pre-signature cache once.

The extractor is a **text** extractor, not a type checker: it reports what
the source literally declares, so an unannotated parameter stays unannotated
rather than being inferred. Declarations are capped at
`extract.SignatureCap` (160 runes); on this repo that yields a median
declaration of 54 characters and costs ~12% on `MAP.json`.

## Why this lives outside `packages/`

`npm`/`bun` workspaces glob `packages/*`, and `scripts/sync-versions.js` +
`scripts/publish-workspaces.mjs` both `readdir` `packages/` expecting a
`package.json` in every subdirectory. Putting a Go module there would break
both. `quest/` (the Kotlin/Quest 3 module) is the existing precedent for a
non-npm toolchain living at the repo root instead.

## Distribution

The shipped artifact is named **`draht-graph`, not `draht-tools`** — even
though `go/Makefile`'s local dev build still emits `bin/draht-tools` (no
churn to the package dir / existing dev workflow). This is load-bearing, not
cosmetic: both `@draht/tools` and `@draht/coding-agent` declare
`bin.draht-tools` pointing at `packages/draht-tools/bin/draht-tools.cjs`
itself, so if a `$PATH`-lookup fallback ever found a binary literally named
`draht-tools`, it would resolve back to the CJS shim and spawn itself
forever (inside the unattended `gsd-post-phase` and git `post-commit`
hooks). `scripts/build-graph-binaries.sh` is the only thing that emits the
`draht-graph` name; see "Building release artifacts" below.

`draht-tools.cjs`'s dispatch shim resolves a binary via (one `statSync` each,
no spawns, no hashing on this path): `$DRAHT_GRAPH_BIN` →
`<bin/ of the running copy>/draht-graph[.exe]` →
`~/.draht/bin/draht-graph[.exe]` → `$PATH`. `DRAHT_GRAPH_ENGINE` selects
`auto` (default: prefer Go silently, fall back to JS silently), `go`
(require Go, exit 127 with a candidate list if absent), or `js` (never even
stat for a binary). Full detail: `.planning/kg-integration/SPEC.md`'s "Go
engine cutover" section.

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
make parity  # Go(--parser=regex) vs the real CJS engine's MAP.json (root/packages/modules/edges/stats subset + every Phase 2 field)
```

`make build-full` builds with no grammar tags (all 206 bundled grammars) —
it exists purely to make the size delta visible in review; Phase 1 never
ships it.

## Grammar tag coupling

The shipped binary is compiled with `grammar_subset` build tags that register
exactly the grammars `cmd/draht-tools`' `buildParser` enables (design D2:
typescript, tsx, javascript, python, go, rust). **That tag list has exactly
one source and must never be hand-written anywhere** — `internal/langset`
(`langset.CLILanguages` + `langset.BuildTags`), surfaced via
`go run ./cmd/grammar-tags`, and consumed identically (i.e. all shelling out
to that same command at build time, never a hand-copied list) by
`go/Makefile`, `scripts/build-graph-binaries.sh` and
`.github/workflows/ci.yml`. The hazard this closes: an unknown or typo'd
`grammar_subset_<name>` tag is **not a build error** —
`grammars.DetectLanguageByName` returns `nil` and
`parse.NewTreeSitter` silently `continue`s past that language, so the
binary still builds, still runs, and just stops seeing that language's
imports. `internal/parse/grammarsubset_test.go`'s
`TestShippedGrammarSubsetSupportsEveryCLILanguage` is the **behavioral**
guard, but it only bites in the **tagged** CI pass
(`go test -tags "$(go run ./cmd/grammar-tags)" ./...`) — the untagged pass
(all 206 grammars compiled) can't fail this way by construction.
`npm run check:grammar-tags` (`scripts/check-grammar-tags.mjs`) is a
narrower, separate thing: a format/well-formedness sanity check on
`cmd/grammar-tags`'s own output (non-empty, sorted, no malformed/duplicate
tags), runnable from the root `npm`/`bun` toolchain that has no Go test
runner. It intentionally does NOT hand-copy the tag list to compare against —
that would recreate the exact hazard this section describes — so it cannot
by itself catch a language silently dropping out of the shipped set; that is
`grammarsubset_test.go`'s job.

## Building release artifacts

```sh
./scripts/build-graph-binaries.sh              # all 5 platforms
./scripts/build-graph-binaries.sh --platform linux-x64   # one platform
# or: npm run build:graph-binaries
```

Cross-compiles `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
`windows-x64` with `CGO_ENABLED=0` (mandatory — this repo's dev box has no C
compiler, and it's what makes all five targets buildable from one machine),
`-trimpath -ldflags="-s -w"`, and the generated `grammar_subset` tags above.
Output is `go/binaries/`: `draht-graph-<platform>.tar.gz` (`.zip` for
Windows), each wrapping a `draht-graph/` directory containing the binary +
`README.md` + `LICENSE`, plus `SHA256SUMS` and a `manifest.json` index (the
contract the installer and the CJS shim's resolver-side stamp check both
read — see `.planning/kg-integration/SPEC.md`'s "Go engine cutover"). Also
extracts each archive into `go/binaries/<platform>/draht-graph[.exe]` for
local testing.

Measured on this repo, subset-tagged, `-trimpath -ldflags="-s -w"`:

| platform | binary | archive |
|---|---|---|
| linux-x64 | 14,434,466 B (13.76 MiB) | 6,319,543 B (6.02 MiB) tar.gz |
| — full 206-grammar build (`make build-full`), for comparison | ~30.2 MiB | — |

Binaries never enter npm — they ship only as GitHub release assets attached
to the same `v<version>` tag `pi`'s binaries use
(`.github/workflows/build-binaries.yml`'s `build-graph` job), fetched by an
explicit `install-graph-engine` step
(`packages/draht-claude/cli.mjs`/`packages/draht-codex/cli.mjs`), never from
a command path — `gsd-post-phase` runs `map-graph --quiet` after every
completed phase and must never block on the network.

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

The CJS engine indexes this repo (currently ~1,477 modules) in **~650ms** by
regex line-scanning the whole tree on every run — it is already fast.
**Cold** Go (full re-parse, no cache) is expected to be *slower* than that,
not faster: real AST parsing plus JSON serialization of a ~5.9MB MAP.json
costs more than one regex pass. Measured on this repo: cold **~2.7s**
(up from Phase 1's ~2.2s — Phase 2 adds clustering, symbol-index ranking,
containerEdge classification, and the flow-graph BFS on top of the same
parse+extract cost), warm (cache hit, same repo state) **~100ms** (up from
Phase 1's ~57ms — the increase is almost entirely `rationaleIndex`'s
deliberately-uncached full-repo comment scan, plus the extra Phase 2
computation itself, which runs unconditionally on every build since none of
it is cached). Both numbers are still well under the CJS engine's
unconditional ~650ms for a warm/incremental invocation (e.g. the
`gsd-post-phase` hook that runs `map-graph --quiet` after every completed
phase). **Phase 3 update:** with `GRAPH_REPORT.md` and `MAP.html` now also
written on every non-`--quiet` build (`internal/emit`), a full cold run on
this repo (now ~1,518 modules, up from ~1,479 at Phase 2's measurement) was
~3.8-4.4s and warm ~95-300ms wall-clock in this session's verification runs
— the `--quiet` hook path is unaffected by `MAP.html` (skipped entirely) and
`GRAPH_REPORT.md`'s write is a single already-in-memory `[]byte` write, so
its cost is negligible next to the AST parse/extract stage. The value
proposition of this rewrite is **correctness** (real AST
vs regex heuristics — 9 of 14 listed languages currently get zero import
parsing under the CJS engine), **coverage** (Phase 2 populates 13 fields
that were always empty arrays in Phase 1, plus `lanes`/`hotspots`/
`modules[*].depth`/`modules[*].cluster` — `tests` and `planning` remain
Phase-1 stubs, see "What still does NOT exist" above), **architecture**, and
the **incremental cache**. Do not cite raw cold-build speed as a reason to
prefer this engine over the CJS one — cite the warm path and the
coverage/correctness gap instead.

## Package layout

```
go/
├── cmd/draht-tools/   CLI entrypoint: map-graph, map-serve, graph-*,     [WP-D /
│                      graph-hook subcommand dispatch.                    Phase 3]
└── internal/
    ├── scan/      File discovery, language classification, manifests. [WP-A]
    ├── parse/     The Parser swap seam: tree-sitter + regex importers. [WP-B]
    ├── extract/   Per-file facts (exports/symbols/sinks/routes/callSites).
    ├── cache/     Content-hash-keyed on-disk store for facts.          [WP-C]
    ├── model/     MAP.json schemaVersion-5 wire structs + writer.      [WP-D]
    ├── rank/      Hotspots, entry points, sinks, the depth BFS.      [Phase 2]
    ├── cluster/   Label-propagation clustering + surprisingConnections. [Phase 2]
    ├── container/ containers/groups/containerEdges + GROUPS.json curation. [Phase 2]
    ├── symindex/  symbolIndex + rationaleIndex.                      [Phase 2]
    ├── flow/      flows/lanes/boxes + FLOWS.json curation.           [Phase 2]
    ├── rawobj/    Shared insertion-ordered JSON object type (Object.assign
    │              semantics + HTML-escaping-disabled marshaling) used by
    │              container's GROUPS.json and flow's FLOWS.json curation. [Phase 2]
    ├── graph/     Pipeline orchestration: worker pool, resolver, assemble. [WP-D]
    ├── report/    GRAPH_REPORT.md renderer (push-for-push port of        [Phase 3]
    │              visRenderReport).
    ├── htmlview/  MAP.html: the CJS's ~2,000-line viewer shipped         [Phase 3]
    │              verbatim as an embedded asset (asset/viewer.html.tmpl)
    │              plus the two dynamic substitutions (embedded JSON,
    │              JSON_PATH). See asset/extract.mjs for re-lift steps.
    ├── emit/      visWriteOutputs' write-gating: GRAPH_REPORT.md shares  [Phase 3]
    │              MAP.json's unchanged-gate; MAP.html is unconditional
    │              unless --quiet.
    ├── query/     Pure, I/O-free graph-context/impact/callers/callees/   [Phase 3]
    │              path/query/hotspots/clusters renderers. Byte-exact
    │              stdout parity with the CJS engine is this package's
    │              acceptance bar (testdata/golden/*.txt, captured from
    │              the live CJS engine).
    ├── hook/      graph-hook install/uninstall/status (writes files,     [Phase 3]
    │              unlike the read-only query package).
    └── serve/     map-serve: loopback HTTP server for MAP.html/MAP.json  [Phase 3]
                   with SSE live-reload (polling watcher, not fsnotify —
                   see "What still does NOT exist" above).
```

Dependency direction (no cycles, no shared "types" package): every Phase 2
package (`rank`, `cluster`, `container`, `symindex`, `flow`) depends only on
`model` + stdlib and is mutually independent of the others, EXCEPT that
`container` and `flow` both additionally depend on `rawobj` (itself
stdlib-only) for their curation-merge implementation — `graph` is the only
place any of them meet each other.

```
cmd/draht-tools ──> graph ──> model
                      ├────> scan      (imports nothing but stdlib)
                      ├────> extract ──> parse   (imports gotreesitter only)
                      ├────> cache     (imports nothing but stdlib)
                      ├────> rank      (imports nothing but model + stdlib)
                      ├────> cluster   (imports nothing but model + stdlib)
                      ├────> container (imports model, rawobj + stdlib)
                      ├────> symindex  (imports nothing but model + stdlib)
                      └────> flow      (imports model, rawobj + stdlib)
                                            rawobj imports nothing but stdlib
```

`cache` is byte-oriented (`[]byte` payloads) so it never imports `extract`;
the codec lives in `extract`. This is what lets the four work packages
compile independently of one another once `go.mod`/`go.sum` exist.

Phase 3's five new packages layer on top without introducing any new
cycles: `report` and `htmlview` depend only on `model` (+ stdlib, +
`_ "embed"` for `htmlview`'s asset); `emit` depends on `model`, `report`,
and `htmlview` (it is the only package that imports both); `query` depends
only on `model` and `scan` (for `FindRepoRoot`); `hook` depends on nothing
but stdlib (it never touches `model` — it only edits a shell script);
`serve` is the one Phase 3 package that reaches back into `graph` (to
rebuild the map on file changes) and therefore also pulls in `emit`,
`parse`, and `scan`. `cmd/draht-tools` is still the only place `query`,
`hook`, and `serve` meet each other.

## Dependency policy

The only direct dependency is `github.com/odvcencio/gotreesitter v0.47.1`,
pinned exactly (no `^`, no `latest`), with `go.sum` committed. **No other
direct dependency may be added.** The worker pool uses `sync.WaitGroup` +
channels from stdlib, not `x/sync`. If you think you need a new dependency,
that is a signal to stop and raise it rather than `go get` it — a second
implementer's parallel branch would otherwise conflict on `go.mod`/`go.sum`.
