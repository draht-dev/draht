# Graphify parity (PR #2) — fix session

> **Status:** proposed, 2026-09-05. **Target:** draft PR #2 `claude/graphify-draht-parity-rwxyka`.
> **Origin:** pre-release review of the PR on top of the 2026-09-04 main (upstream fix sync merged).
> Review evidence: merged-onto-main tree passes `bun run check`, Go (700), draht-tools (37),
> gateway (666 + the known identity-header tripwire). The code review found the defects below.
> Line numbers are from the PR branch files; re-derive them before editing.

`kg` = `packages/draht-tools/bin/draht-kg.cjs`, `tools` = `packages/draht-tools/bin/draht-tools.cjs`.

## Goal

Make the PR mergeable for the next release: `kg build`, `kg report` and `kg export wiki`
produce what the README promises, and a stale Go `draht-graph` binary can no longer silently
serve the pre-PR engine.

## Non-goals

- Porting the `kg` engine to Go. No parity test is claimed for it; none is required here.
- Semantic changes to graphify's ID scheme (M1 is detection, not a new scheme).
- The alternate MAP.json layouts, Insights UI polish, or new `kg` subcommands.

## Wave 1 — blocking (must land before the PR leaves draft)

### T1. `graph.json` community members round-trip (H1)

`writeGraph` strips `members` (kg:981 `communities.map(({ members, ...c }) => c)`), but
`writeReport` (kg:1493) and `exportWiki` (kg:1633, 1639) read communities back from disk via
`loadGraph` (kg:999). Result: `kg report` after `kg build` rewrites `KG_REPORT.md` without the
`Members:` lines, and every wiki community article is empty.

Fix: rebuild `members` in `loadGraph` from `nodes[*].community` (keeps graph.json in graphify's
node-link shape) — or keep `members` in the file if graphify's loader tolerates it. Pick one and
say why in the commit body.

Acceptance:
- `kg build && kg report` leaves `KG_REPORT.md` byte-identical (test asserts the file hash
  before and after `kg report`).
- `kg export wiki` on the fixture repo produces at least one community article whose
  "Source Files" section is non-empty (test asserts on content, not on `index.md` existing —
  `kg.test.mjs:172-180` currently only checks existence).

### T2. schemaVersion bump, or drop the claim (H2)

PR text and branch README say "schemaVersion 5 → 6"; the code stamps 5 at tools:3043,
tools:5311 (`GRAPH_SCHEMA_VERSION`), `packages/draht-claude/cli.mjs:619`,
`packages/draht-codex/cli.mjs:586`, `go/internal/model/map.go:352`. `GRAPH_GO_COMMANDS`
(tools:5298-5302) delegates `map-graph`/`graph-query`/`graph-impact`/`graph-clusters` to any
installed `draht-graph` stamped 5 (tools:5354), so a user with an older Go binary silently gets
the pre-PR engine: empty barrels, per-symbol AND ranking, duplicate cluster labels.

Decision (pick one, record it in the PR description):
- **A — bump to 6.** All four JS sites, Go `NewMap`, `fixture-repo.MAP.json`, the stamp in
  `graph-delegation.test.cjs`, README, and cut a Go `draht-graph` release so the installer block
  in both `cli.mjs` files points at it. `check:schema-version-sync` must pass.
- **B — keep 5.** Remove the v6 claims from PR text and README and add a README note that the
  Go engine must be at least the PR's release to match the CJS output.

A is the correct one; B is the escape hatch if a Go release cannot be cut in the session.

Also: `test/graph.test.mjs` `run()` (:15-17) inherits `env`/`HOME`, so on a machine with
`~/.draht/bin/draht-graph` it tests the Go binary. Pass `DRAHT_GRAPH_ENGINE: "js"` in the test
env (as `graph-delegation.test.cjs` already sandboxes `HOME`/`PATH`).

Acceptance: `check:schema-version-sync`, `check:draht-tools`, `check:mirrors` green; the graph
tests pass with and without a Go binary on `PATH`; with option A, `draht-tools graph-query`
against a stamped-5 binary falls back to JS (or refuses) instead of delegating.

### T3. Import-cycle enumeration bound (M6)

`importCycles` (kg:926-955) enumerates every simple path of length ≤5 from every file node and
only exits after 20 cycles are found. On a well-layered repo with barrel fan-out (out-degree
20+) that is ~d^5 states per start × N files per `kg build` — a hang. Bound the total visited
state count (and/or run a single Johnson/Tarjan pass), not only the cycle count.

Acceptance: a synthetic fixture with 200 files, out-degree 25 and zero cycles builds in under
2 s; existing cycle tests still find their cycles.

## Wave 2 — extraction correctness (deterministic, wrong; ship in the same PR if time allows)

| id | defect | evidence | acceptance |
|----|--------|----------|------------|
| M1 | `normalizeId`/`makeId` (kg:128-150) map `/ . -` to `_` and casefold; `addNode` is first-wins (kg:406-411) with no collision detection. `src/auth/session.ts` collapses into class `Session`; `dup.js` + `dup.ts` share one node. | fixture-verified | collisions are detected and reported in `KG_REPORT.md` (count + first 20 pairs); colliding nodes get a deterministic disambiguating suffix; test with the two fixtures above |
| M2 | brace depth tracked on raw lines (kg:234-259); a `{` in a comment hides every later declaration | `// see the docs for { options` on line 1 → zero symbols | scan `stripped` content (kg:434), test with a comment brace and a string brace |
| M3 | methods named like any language's keyword are dropped: kg:253 gates on the cross-language `CALL_KEYWORDS` (kg:108-115) so `delete()`, `select()`, `match()`, `go()`, `use()`, `type()` vanish | verified | per-language keyword sets; test a TS class with `delete`/`select`/`match` methods |
| M4 | `this.x()` binds to the first class in file order with a method `x` (kg:663-669), not the enclosing class | `B.go2 → A.run` | resolve against the enclosing class (region containment); test two classes with same-named methods |
| M5 | call regions have no end (kg:619-631): module-scope code after a function is attributed to that function | verified | close a region at the decl's closing brace; test top-level call after a function |

## Wave 3 — low, optional

- L1 `walk` (kg:178-198): 20 000-file cap silently truncates; ignores `.gitignore` (emitted `.js`
  beside `.ts` feeds M1); skips symlinked sources; sort order differs on Windows. At minimum
  report truncation and honour `.gitignore` for emitted output dirs.
- L2 `--output` on `kg export tree|graphml` writes to an arbitrary path (document it);
  `exportWiki` never removes stale articles; god-node articles keyed by `slugify(label)`
  collide (kg:1627, 1659).
- L3 `kgMain` (kg:1709-1716) exits 0 on "no graph — run kg build first" and on an unknown export
  format; `kgCommands[cmd]` is a plain-object lookup (`kg __proto__` throws a raw stack). Use
  `Object.hasOwn`, exit 1 on user errors.
- L4 `kg path` BFS uses `q.shift()` (kg:1352); `edgeBetween` (kg:1173) is dead code.
- L6 doc drift: README says both "schemaVersion 5" and "schema v6"; CHANGELOG/PR test counts
  (10/13) do not match the files (11/15).
- L7 `namedBlockRe` (tools:1455) runs on raw content, so a commented-out re-export is captured
  (Go `exports.go` mirrors it, so parity holds — fix both or neither).

## Rules for the session

- One defect per commit, each with its regression test in `packages/draht-tools/test/`.
  Every claim above was verified on a fixture; the test must reproduce the fixture.
- After every change to `packages/draht-tools/bin/*.cjs` run `node scripts/sync-draht-tools.mjs`
  so the six mirrored copies stay byte-identical (`check:draht-tools` enforces it).
- Go changes go with `go test ./...` un-`-short` — `go/internal/graph/parity_test.go` is the
  real CJS↔Go gate for `map-graph`; `check:graph-engine-parity` only diffs the installer block.
- Rebase the branch onto main first (it is 102 commits behind but merges clean as of
  2026-09-05); re-run the review's "verified as fine" list before calling it done: no
  `child_process`/`process.env`/network in `draht-kg.cjs`, writes confined to
  `.planning/codebase/` plus explicit `--output`, rebuild byte-identity test green.
- Done means: wave 1 landed, `bun run check` green, all three test suites green on the merged
  tree, PR out of draft with the T2 decision recorded.
