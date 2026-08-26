# Post-WP05 roadmap audit

**Audit baseline:** `5507d76ee` (`dev`, 2026-08-27).

**Status:** Planning inventory, not a behavior contract. [`harness.md`](harness.md) remains normative where it agrees with the current product boundary. Contradictions listed below must be resolved explicitly; this document does not silently choose one side.

## Scope and method

This audit covers the durable AgentHarness and its directly coupled Session backends and presentation path:

- `packages/agent/src/harness`, `packages/agent/src/search`, and their tests/docs;
- `packages/session-backends/sqlite-node`;
- the current `packages/protocol`, `packages/client`, and `packages/server` presentation path;
- `packages/coding-agent/src/experimental` and its focused tests where they host that path;
- telemetry plumbing in `packages/telemetry`, `packages/ai`, and `packages/agent`.

The inventory was checked against current source, tests, package READMEs, the complete `harness.md`, WP00–WP06 status, explicit stubs/TODOs/skips, and the shipped package boundaries. Historical handoffs are not treated as backlog when current source and the completed WP05 contract supersede them.

## Executive result

WP05 is complete through M10. M11 is its only recorded follow-up. The current Harness execution graph has no unfinished runtime path: `watchSession()` is the sole `SliceNotImplemented` Harness method.

That does **not** mean the surrounding durable system is complete. The audit found:

1. two SQLite ownership races that can violate single-writer fencing or delete an actively claimed Session;
2. normative JSONL snapshot-compaction behavior with no implementation;
3. one required Harness method stub (`watchSession`);
4. a deliberate removal of raw `RemoteSession` that conflicts with later normative WP06/`harness.md` text;
5. a public search type skeleton that conflicts with the newer search design and has no implementation;
6. a full telemetry vocabulary whose only production span is the tool-hook span;
7. smaller repository, client-watch, query-bound, documentation, and end-to-end-test gaps.

The immediate package is therefore SQLite ownership fencing, not a combined “cleanup” package. Its handoff is [`work-packages/07-sqlite-ownership-fencing.md`](work-packages/07-sqlite-ownership-fencing.md).

## Required missing functionality and contract contradictions

### R12 — Session-wide Harness watch

**Evidence**

- `AgentHarness.watchSession(context)` is public in `src/harness/agent-harness.ts`.
- `Harness.watchSession()` throws `SliceNotImplemented("watchSession")` in `src/harness/runtime/harness.ts`.
- `SessionSnapshot` currently contains only `{ lanes: LaneInfo[]; faulted: boolean }`.
- Lane watch, event buffering, delivery-tail barriers, and `resnapshot()` already exist in `src/harness/events.ts` and `src/harness/runtime/lane.ts`.

**Remaining boundary**

Define one coherent capture and fold for dynamic lane inventory and fault state. Decide whether the intentionally small `SessionSnapshot` stays small or gains session metadata/stats/global configuration. Then implement snapshot-before-events, lane creation, resnapshot, listener reentrancy, close/fault behavior, and a session reducer if event-only replication is promised.

**Dependency**

Independent of M11 and SQLite internals. It should precede any revisioned Transcript service or remote session-wide observation built on it.

### JSONL snapshot compaction

**Evidence**

`harness.md` §1.7 normatively specifies temp-file-and-rename snapshot compaction, preserved sequence high-water marks/list cursors, threshold checks on open, and reclamation after terminal/outcome deletions. `JsonlStorage` implements atomic creation, torn-tail repair, legacy-v3 rewrite, append, and fork snapshots, but no current-state snapshot rewrite or dead-byte accounting exists.

**Consequence**

Superseded `pi.op.state`, deleted pending payloads, deleted tool checkpoints, and deleted assistant-frame lists remain physical bytes indefinitely. Generic compaction and M11 are distinct mechanisms but their recorded scopes overlap: WP05 M11 also cites dead post-settlement JSONL frame history, while `harness.md` tracks generic reclamation separately. Compaction reclaims all dead write history after the fact; frame-specific bounding limits peak logical/physical progress while an effect is pending.

**Dependency**

Memory/SQLite M11 measurement and mechanism design may proceed in parallel. Implement and measure JSONL snapshot compaction before setting M11's final JSONL post-settlement budget, so M11 distinguishes pending-effect volume from already-dead physical history and does not invent a second reclamation mechanism.

### Remote Session contract contradiction — decision required

**Current product boundary**

Commit `f8a6e670d` deliberately deleted `RemoteSession`, its raw Session RPC protocol, and the server mutation-scope manager, replacing them with attachment-fenced routed semantic services. Current protocol/server READMEs explicitly state that real `Session` and `AgentHarness` objects remain process-local. The shipped path supports Session discovery/creation/attachment, main-lane prompt/watch, and allowlisted plugin-service calls; it does not expose `Session`, `SessionMutation`, values/lists, branches, or storage over RPC.

**Conflicting contract**

WP06, written after that deletion, requires the “current keyless RemoteSession mutation transport,” includes remote begin/read/commit/publication/end in required tests and stop conditions, and forbids its removal. `harness.md` §§2.8 and 9.1 likewise state that local and remote implementations preserve that lifecycle. No such implementation, protocol schema, client facade, server-held scope, worker adapter, or conformance test exists at the audit baseline.

**Required decision**

Choose one before scheduling implementation:

1. **Process-local Session remains intentional:** remove the false RemoteSession requirements from normative current-state docs while preserving semantic service RPC; or
2. **RemoteSession is required:** commission a dedicated package for mutation begin/read/commit/end, disconnect/timeout cleanup, publication-before-end, values/lists/branches/entries/stats, protocol validation, client/server/worker adapters, and remote conformance.

Do not count the current lane-watch compatibility RPC or plugin-service RPC as RemoteSession. Do not restore the deleted 507-line facade unchanged: it predates the keyless Session/Branch contract and relied heavily on untyped decoding.

### Telemetry contract exceeds implementation

**Evidence**

`src/harness/telemetry.ts` and generated `docs/telemetry-schema.md` declare `pi.ai.request`, operation, checkpoint, turn, step, tool, hook, sleep, event-handler, and session-write spans. Production source starts only `pi.harness.hook`, and only for registered `before_tool`/`after_tool` handlers. AI options propagate `telemetryContext`, but no provider path starts `pi.ai.request`. Server request ingress has cancellation but no trace carrier or client/server RPC spans. `TODO_CONTEXT` remains at transport/worker lifecycle and event-delivery boundaries.

**Remaining boundary**

Treat this as separate packages:

1. local Harness/Session/AI instrumentation and runtime tests;
2. RPC trace-carrier/client/server propagation;
3. an optional application-selected exporter/adapter.

First reconcile whether every declared span is still wanted. If retained, implement it; if not, remove the unsupported public schema surface and correct `harness.md`. Do not mix telemetry with Context/RPC cancellation, which already has independent request-ID signaling.

### S3 — Search

**Evidence**

`src/search/index.ts` exports a public `SessionSearchService` skeleton with `sync()`, `notify()`, and array-returning `searchEntries()`. `harness.md` §2.8 instead specifies a standalone service, separate catch-up/notify utilities, generation-aware cursors, and optional `AsyncIterable` entry search. There is no factory, sync utility, cursor store, projection, or source SQLite FTS implementation. At the audit baseline the SQLite README advertised nonexistent `createSqliteSessionSearch()` behavior; this audit corrected that README rather than treating the absent API as implemented.

**Remaining boundary**

Before implementation, replace or reconcile the draft public interface and decide metadata filtering (`cwd`), candidate restriction, or indexed metadata. Post-filtering after ranked `limit` is unsound. Then implement standalone catch-up and a separate SQLite FTS5 projection; do not add repository search methods.

### R11 — Schema migrations, activation-gated

No current format-4 migration is required. Memory is current-only; JSONL and SQLite reject unsupported storage versions; SQLite runs only idempotent `001_initial.sql`. R11 becomes required immediately before the first incompatible durable storage version/address/state change after format 4 is stabilized. It is not prerequisite work for M11 or current WIP format replacement.

When activated, it must provide ordered transactional migrate-on-open under exclusive ownership, version-specific JSONL decoding plus post-migration compaction, and total mappings for every reachable open operation leaf and surviving value/list.

## Correctness and data-safety debt

### SQLite ownership and deletion — immediate

1. `SqliteStorage.applyCommit()` renews the writer lease in a separate transaction before the data transaction. A replacement writer can claim an expired lease in that gap; the stale owner’s data transaction never checks `(owner_id, fence)`.
2. `SqliteSessionRepo.delete()` checks the lease, closes that connection, then deletes through another connection or unlinks the file. Another process can claim between check and deletion.

These violate the documented single-writer guarantee and can corrupt or remove active Session data. WP07 owns them.

### SQLite repository identity and path safety

- `databasePath` creation makes `options.directory`, not the actual custom path’s parent.
- Per-session filenames interpolate arbitrary explicit IDs without encoding; separators can escape `directory`.
- Active fork lookup is keyed only by Session ID, so caller-supplied metadata for the same ID at another path can select the wrong open source.
- `repo.close()` uses fail-fast `Promise.all`, so it can reject before other Session closes settle and release their claims.
- Equal-`createdAt` list ordering has no deterministic tie-break.

Path/identity/close items that share writer ownership belong in WP07. Deterministic listing is a later behavior-preserving cleanup.

### Repository close ownership is unspecified

`JsonlSessionRepo.close()` contains the only active Agent source TODO and closes no open Session handles. Memory and SQLite repositories do close owned resources, but both currently use fail-fast `Promise.all`; `SessionRepo` itself declares no `close()` method and shared conformance does not define repository-to-handle ownership. Resolve ownership and all-settled cleanup in one repository-lifecycle package; WP07 may harden SQLite's claim release locally, but do not patch JSONL alone without deciding the common contract.

### Client watch staleness after disconnect

`Client` clears its active watch-listener map on disconnect, but existing `LaneWatch` objects keep local `ready`/`started` state and old watch IDs. After reconnect/reattach they can call `start()` or `resnapshot()` and fail remotely instead of deterministically rejecting as stale, contrary to `packages/client/README.md`. Service-subscription objects have the sibling problem: their listeners are cleared and surviving objects become silently dead. Fix both with connection/attachment incarnation fencing and focused reconnect tests. This is independent of R12: the current client method is a compatibility main-lane watch.

### Query bounds and SQLite bind limits

- SQLite `getEntries(ids)` emits one placeholder per requested ID and can exceed the engine’s variable limit.
- Entry, usage, and branch limits use ad hoc `Math.max(0, limit)` behavior. Memory and SQLite diverge for `NaN`, infinities, fractions, and extreme values; unlike list reads, there is no shared normalization contract.

Define cross-backend query-limit semantics in agent conformance, then chunk SQLite ID lookups. This is a storage-contract hardening package, not part of lease fencing.

### Disabled real worker persistence regression

`packages/coding-agent/test/experimental-remote-runtime.test.ts` still skips “completes and persists a prompt through the worker-owned Harness” with the obsolete note “Re-enable with runtime no-tool execution.” No-tool execution now exists. Re-enable or replace it with a deterministic faux-provider real-worker persistence test; do not use a real paid provider.

## Performance debt

### M11 — durable assistant-frame volume

The user-supplied motivating mini Session outside the repository is 303,920 bytes across 569 physical lines. These external measurements are evidence, not a reproducible checked-in fixture:

- 477 assistant-frame appends totaling about 118,418 serialized write bytes;
- 12 frame-list deletes; physical lines mentioning the frame namespace total 148,214 bytes;
- about 51,568 bytes of superseded `pi.op.state` writes and 26,192 bytes of one structural preparation, showing why generic JSONL compaction and frame-specific bounding are distinct.

M11 must first add a deterministic repository fixture and measurement script that reproduces or replaces these figures.

M11 must measure Memory logical elements, SQLite rows/pages/WAL, JSONL peak bytes during an effect, JSONL post-settlement bytes, and JSONL reopen/replay time. It must then bound persisted progress without weakening unknown-outcome recovery, invocation fencing, non-blocking provider streaming, or settlement cleanup. Live event fidelity need not imply one durable write per provider event.

Candidate mechanisms remain design inputs, not approved architecture: coalesced durable checkpoints, a bounded full snapshot plus short delta tail, or logarithmic snapshot points. The exit condition needs numerical budgets derived from fixtures, not only “smaller than before.”

### SQLite branch divergence

`createDivergentBranchForEntry()` copies every row after the newest compaction; with no compaction it copies root-through-parent. A first divergence from a long uncompacted transcript is therefore O(history) writes. This exposes an internal contradiction in `harness.md` §2.6: its opening bounded-prefix promise conflicts with its own compaction-based copy algorithm, which the implementation follows. Change both the specification and segment representation so a divergence can reference a covering segment at the parent boundary. Preserve shared-container support and add large uncompacted divergence plus chain-soundness tests/benchmarks.

### SQLite fork cost

Active and closed forks load every scalar value, including application values that are later excluded, and `createForkSnapshot()` repeatedly searches those arrays for branch/config/label state. Select only fork-relevant built-in namespaces, index once, and fetch labels only for copied entries. Measure large application-state forks before/after.

### SQLite catalog, statements, stats, and reclamation

- Default per-session `list()` synchronously opens/configures every SQLite file serially and silently skips failures. A shared container or external catalog is the scalable deployment choice; bounded async scheduling does not make `DatabaseSync` nonblocking.
- Most hot queries prepare a fresh statement each call. Cache narrowly owned statements after measuring.
- Each usage row parses and rewrites the full aggregate JSON usage payload.
- Shared-container row deletion does not reclaim pages. Define maintenance/VACUUM policy separately; never add `VACUUM` to ordinary deletion casually.

These are measurable optimization/operations packages, not correctness fixes.

### Pending-payload amplification and mutation-line parallelism

Queued payloads deliberately write `pendingEntry → immutable entry`; measure pathological payloads before changing it. Keyed Session mutation lines remain optional and require profiling plus a fresh mutable-ownership audit. Neither is current correctness work.

## Behavior-preserving cleanup and documentation repair

Completed by this audit:

- rewrote the SQLite README’s nonexistent `SqliteSessionRepository`/search APIs, wrong `await using` and `appendMessage` example, FTS trigger/rebuild claims, and “one shared connection” claim;
- reconciled `harness.md`’s default one-file SQLite wording with the supported optional shared container;
- reconciled `harness.md` Part 8 with this audit and corrected stale drive-ownership/RPC-cancellation status in `telemetry.md`;
- corrected coding-agent settings docs: install telemetry configuration also controls selected provider attribution headers.

Remaining cleanup:

- Preserve shared-container support; do not remove it incidentally.
- Remove or use unused `insertEntryRow()` and `insertUsageLedgerRow()`.
- Consolidate duplicated SQLite branch payload/structure scan plumbing only after correctness tests pin both paths.
- Decide whether unused `sessions.metadata` and unmeasured indexes have a future owner before schema removal; do not change schema casually.
- Consolidate `startAiSpan()`/`startHarnessSpan()` implementation only if the telemetry surface is retained.
- Mark historical durability documents as delivered where they still read as implementation queues. WP00–WP06, `runtime-simplification.md`, `values.md`’s old consumer deferrals, and external-finalization designs are not active runtime backlog.

## Optional or deferred product capabilities

These are not blockers for the durable Harness:

- standalone S3 search after its API decisions;
- Accounts removal, revisioned Transcript production, and Chat steer/follow-up/next-run/cancel/resume/compact/navigate service adapters;
- authenticated workspace/client authorization for the experimental local server;
- private returned references, service flow control, multi-pane presentation, plugin kernel/reload completion, and version-skew negotiation;
- administrative precise rewrite tooling;
- a partitioned Postgres backend/retention policy;
- generic remote Harness/object capabilities;
- DeltaState or delta replication before concrete snapshot pressure justifies it;
- a production telemetry exporter;
- schema migrations before an incompatible stabilized-format change activates R11.

## Recommended dependency order

The order is by data safety first, then dependencies. Independent tracks may proceed in parallel only when they do not edit the same contracts.

1. **WP07 — SQLite ownership fencing.** Atomic lease assertion with commits, exclusive deletion, path/source identity, close draining, and documentation correction.
2. **Remote Session decision (decision only).** Resolve the false normative boundary early. If process-local wins, repair the docs. If raw RemoteSession wins, later create a dedicated protocol/client/server/worker package; do not fold it into telemetry or R12.
3. **Client watch/subscription staleness** and **repository lifecycle contract.** Small independent correctness packages; complete them before expanding server/worker lifecycle semantics. The lifecycle package must also address Memory's fail-fast repository close.
4. **JSONL snapshot compaction.** Implement the already-normative physical reclamation path and metrics.
5. **M11 durable frame volume.** Memory/SQLite measurement can start earlier; set final JSONL budgets only with compaction measured, and preserve all recovery boundaries.
6. **R12 session-wide watch.** Complete the only Harness method stub before building revisioned Transcript/session-wide remote observation.
7. **Telemetry, if retained:** reconcile schemas, then local instrumentation, then RPC propagation, then an optional exporter. RPC propagation follows the Remote Session/product-boundary decision.
8. **SQLite branch/fork/query performance hardening.** Keep separate from lease correctness and require benchmarks.
9. **S3 search.** Resolve its API/filter/cursor decisions, then implement catch-up and the standalone FTS projection.
10. **R11 migrations.** Activate immediately before the first incompatible stabilized durable schema change, not earlier.

## Stop conditions for roadmap accuracy

This inventory must be updated when any of these facts changes:

- `watchSession` stops being the sole Harness `SliceNotImplemented` method;
- raw RemoteSession is either recommissioned or removed from the normative contract;
- JSONL snapshot compaction lands;
- telemetry schemas are implemented or removed;
- S3’s public API is reconciled;
- a durable format change activates R11.
