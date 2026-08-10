# AgentHarness v3 — implementation specification

**Status:** construction skeleton. When complete, this document supersedes `agent-harness-spec.md` in full, which itself superseded `harness-v2.md`. Until then, `agent-harness-spec.md` remains authoritative.

**Sources being merged:**

- `agent-harness-spec.md` — the audited base spec ("base" below). Its interpreter, effects boundary, hooks, events, classifier, abort/close, and race catalog carry over with mechanical renames only; do not rewrite them.
- The storage walkthrough jot ("jot" below, parts 1–9) — the three-store model, pending registers, terminal cleanup, recovery, retention/partitioning, schema evolution, backend stories, API deltas, and the binding decisions in jot part 9.
- The storage-redesign critique findings, as resolved by jot part 9.

**Global renames applied throughout v3:**

```text
node / Node*            → entry / *Entry          (continuity with coding-agent)
slot                    → register
"storage substrate"     → "Storage"
StoredValue / valueId   → gone (no values table)
```

**Section disposition markers used in this skeleton:**

- `[CARRY]` — take the base section verbatim, apply global renames.
- `[CARRY+]` — carry, plus the listed deltas.
- `[REWRITE]` — rewrite against the listed jot part / decision.
- `[NEW]` — no base equivalent; write from the listed jot part.

---

# Part 0 — Orientation

- **0.1 What this is** `[CARRY]`
- **0.2 Three concepts** `[CARRY]` — session/lane/harness unchanged.
- **0.3 Worked example — a Slack thread** `[CARRY+]` — example ids become UUIDv7-shaped.
- **0.4 Worked example — a crash mid-tool** `[CARRY]`
- **0.5 The three stores** `[REWRITE: jot 1]` — replaces "the four ideas": entries (immutable conversation), registers (current mutable state incl. pending payloads), usage ledger. The one-sentence invariant: *every payload is in an entry, a register, or the ledger; there is no third place.* Keep the effect sandwich and durable-program-counter ideas from base 0.5.
- **0.6 Non-goals** `[CARRY+]` — add: durable history/audit (telemetry adapter instead, jot 1); partition expiry is TTL, not compliance deletion (jot 5).
- **0.7 Notation and source types** `[REWRITE]` — TX notation gains `upsert register` / `delete register`; id examples are UUIDv7 prefixes; source-type provenance list updated (no value types).

# Part 1 — Storage

- **1.1 The model** `[REWRITE: jot 1]` — `Entry` (complete row: placement + payload), `Register<N>` (namespace, key, seq, typed value), usage row. Register deletion is a first-class write, distinct from storing JSON `null`.
- **1.2 Identity and partitions** `[NEW: jot 9]` — UUIDv7 entry ids; the 48-bit time prefix *is* the partition assignment, truncated to the period; follower ids (tool results only) mint with their assistant id's prefix; reserved ids are minted at reservation; no partition columns anywhere. Retired-vs-corrupt traversal rules (vacuous on non-partitioned backends).
- **1.3 Register namespaces** `[REWRITE: jot 1, 3, 9]`

```text
lane.leaf | lane.config | lane.state | lane.lastResult
op.meta | op.state | op.tool_args/{opId}:{i} | op.preparation/{opId}:{t}
pending.entry/{entryId}
fact.name | fact.label | fact.custom
```

  No `queue.disposition` (removed, jot 9). Lifetimes: `lane.*`/`fact.*` = session; `op.*`/`pending.*` = operation, deleted at terminal TX.
- **1.4 Transactions** `[REWRITE: jot 8]` — write kinds: `entry`, `register set`, `register delete`, `usage`. All-or-none, consecutive session-wide `seq`, serialized writer, validation before admission, fault on failed admitted commit (carry those rules from base 1.3).
- **1.5 Queries** `[REWRITE: jot 8]` — `getEntries`, `getRegister`/`listRegisters` (typed values), `scanBranch`/`scanBranchStructure`/`scanEntries`, `getStats`. No `getLog`, no value scans. Bounded/index-driven rules carry from base 1.4.
- **1.6 Usage ledger** `[NEW-ish: jot 1]` — append-only rows incl. failed attempts; `getStats` as maintained aggregate; adjustment rows.
- **1.7 Backends** `[REWRITE: jot 7; base 1.6]`
  - Memory: maps are the store; register delete = map delete; no log.
  - JSONL **format 4**: one line per commit (object/array); line kinds entry/register-set/register-del/usage/header with `storageVersion`; replay = decoding; torn final line discarded whole; **snapshot compaction** (temp+rename) with the growth-asymmetry rationale and eager-compaction note for sensitive cancelled payloads. Keep base's fsync/durability language.
  - SQLite: entries/registers/usage tables, branch index, FTS, leases, `BEGIN IMMEDIATE` — carry base's discipline sections; registers become upsert/delete rows; drop values/`slot_history`/`getLog` machinery.
  - Postgres `[NEW: jot 5, 9]` — future fourth backend; `PARTITION BY RANGE (id)` on the uuid column with period-boundary UUID bounds; hot unpartitioned catalog (registers, branch_meta, inventory, stats, leases) + partitioned entries/usage/branch index/FTS; single-transaction atomicity across both; DETACH/DROP expiry protocol driven by inventory.
- **1.8 Why write-once plus registers** `[REWRITE of base 1.7]` — recovery is register reads; crash states enumerable; operation cleanup is register deletion; nothing to collect.

# Part 2 — The conversation tree

- **2.1 Entries** `[REWRITE: jot 8]` — the four complete entry types; no materialization function; assistant entries settled-only; `terminate` on tool results; `fromHook`; self-contained `retainedTail` — carry base rules minus node/value compatibility (moot).
- **2.2 Placement** `[REWRITE: jot 2]` — born-placed (one TX) vs pending-register content (`pending.entry` written at enqueue, complete entry inserted + register deleted at placement, one TX, no third state); reserved-id regimes: plain strings for assistant/tool ids, pending registers for queued content.
- **2.3 Lanes** `[CARRY]` — three registers plus `lane.lastResult`; creation TX; permanence rules.
- **2.4 Facts** `[CARRY+]` — deletion is register deletion (no tombstones); JSON `null` remains a legal `fact.custom` value.
- **2.5 Branch queries and context** `[CARRY]` — scans, cursors, context projection, append-only context invariant, overflow-normalization interaction. Add: branch-scan truncation marker at retention boundaries (jot 5/8).
- **2.6 The branch index** `[CARRY+ jot 9]` — segment machinery carries; add the two partition-purity rules: appends crossing a partition boundary close the segment (new segment, old as base); copy-on-diverge caps at partition boundaries and chains instead of copying; base-in-retired-partition = boundary, lazy truncation. `branch_meta` stays hot.
- **2.7 Forks** `[CARRY+]` — copy retained path/tree; normalize retained roots at retention boundaries; destination gets relevant inventory entries (critique 26).
- **2.8 Session and repository boundary** `[CARRY+]` — `storageVersion` in metadata; codec options; fork coordination; coding-agent v3-format normalization pointer.

# Part 3 — The operation state machine

Semantics carry from base Part 3 wholesale; the representation changes (jot 3, 8):

- **3.1 Operations** `[CARRY+]` — `op.meta` register; `promptEntryIds`.
- **3.2 Operation state** `[REWRITE repr]` — inline `LaneConfiguration`/streamOptions/retryPolicy in generation/deferred/batch/summary contexts; tool args and preparation via deterministic `op.*` register keys; queue items are plain entry-id lists; **no `FinishedState`** in the union.
- **3.3 Lane state and validity** `[CARRY+]` — validation checks registers/entries; no value checks.
- **3.4 Atomic transition rule** `[CARRY]`
- **3.5 The graph** `[CARRY]` — terminal node becomes "terminal TX" rather than a state.
- **3.6 Acceptance** `[REWRITE TX tables]` — pending-capture placement; reservation admission for compact/summarized-nav carries.
- **3.7 Assistant generation** `[REWRITE TX tables]` — classifier table, overflow rules, worked example carry verbatim; transactions re-expressed as entry inserts + register upserts.
- **3.8 Tools** `[REWRITE TX tables]` — `op.tool_args` register at clearance; batch semantics carry.
- **3.9 Summary generation** `[REWRITE TX tables]` — `op.preparation` register; decision/generation machinery carries.
- **3.10 Navigation** `[CARRY+]` — one-TX completion; terminal writes per 3.13.
- **3.11 Inbox, queues, deferred writes** `[REWRITE: jot 2, 9]` — pending registers; `cancelQueued` triage without dispositions: pending → `cancelled`; entry exists → `already_consumed`; else → `not_found`. Abort drains keep pending registers alive until terminal.
- **3.12 The checkpoint procedure** `[CARRY]`
- **3.13 Terminal transactions** `[NEW: jot 3]` — delete `op.meta`/`op.state`/`op.tool_args/*`/`op.preparation/*` and operation-owned pending registers (`inbox.* ∪ control.drained*`, never `pendingNextRun`); upsert `lane.lastResult`; clear `lane.state.currentOperationId`; result computed pre-commit; observation contract (live promise + lastResult until next terminal TX).

# Part 4 — Execution, recovery, abort, close

- **4.1 The interpreter** `[CARRY+]` — CAS tokens become register `seq` (`operationStateSeq`, `laneStateSeq`, expected `lane.config` seq).
- **4.2 The effects boundary** `[CARRY]`
- **4.3 The lane mutation line** `[CARRY]`
- **4.4 Restore** `[REWRITE: jot 4]` — the five register reads; bounded hydration of named entries/registers; worked crash example; per-backend notes; missing identities.
- **4.5 Crash positions and recovery policy** `[CARRY]`
- **4.6 Abort** `[CARRY+]` — drained pending registers survive until terminal.
- **4.7 Close** `[CARRY]`
- **4.8 Faults** `[CARRY]`

# Part 5 — Public surface

- **5.1–5.8** `[CARRY+ deltas from jot 8]` — `RecordUsageResult { usageId }`; usage event carries the ledger row; `lane.lastResult` read path; `cancelQueued` `not_found`; expired-lane condition and truncation markers (only meaningful on partitioned backends); everything else — lane surface, results/errors, harness, SessionTree, snapshots/watch, events, hooks, agent-loop building blocks, telemetry — verbatim with renames.

# Part 6 — Retention and partitioning `[NEW: jot 5, 9]`

- Three lifecycles (operation cleanup / context compaction / retention) and why they never couple.
- Postgres layout, hot catalog vs partitions, expiry protocol (seal → inventory aggregates → detach → drop; recoverable).
- Placement via id minting; follower inheritance; late-placement pins; drop preflight = bounded register scan (pending + open-op reserved ids) + per-lane compaction horizon.
- Retired-boundary semantics for traversal, lanes (expired-lane condition), labels, forks.
- Yes/no-dialog worked example (jot 9).
- Expiry ≠ deletion (`retainedTail` copies forward); compliance deletion = precise rewrite.
- Precise rewrite mechanism (copy-retained-and-swap; JSONL snapshot compaction with a keep-predicate is the same operation).
- Lease constraint: retention daemon does lease-free DDL/inventory only; all per-session repair is lazy, owner-executed.

# Part 7 — Schema evolution `[NEW: jot 6]`

- `storageVersion`, migrate-on-open under the writer lease, chained migrations.
- The settlement kernel (stable minimal fragment of `op.state`); migrate-or-force-settle rule for open operations.
- The three strata: entries/usage stable forever; lane/fact registers migrate mechanically; `op.*`/`pending.*` may churn.
- JSONL lenient replay of superseded shapes; compaction after migration.

# Part 8 — Build order `[REWRITE]`

- Rewrite slices 1–3 (storage substrate, JSONL, tree/repos) for the three-store model; carry slices 4–13, 15 with renames; SQLite slice drops values/history machinery; add slices: schema-version/migration scaffold, retention/partition inventory (design-complete, Postgres-deferred). Keep the stop-and-report rule.

# Part 9 — Invariants and tests `[REWRITE: jot 8]`

- The six restated invariants (write-once entries/usage; one home per payload; op registers ⇔ open operation; two reservation regimes; observation contract; prefix-retired = boundary vs prefix-live = corruption).
- Race catalog `[CARRY]`.
- Test tiers `[CARRY+]` — Tier B oracle is the instrumented-storage decorator recording `commit(tx)`; backend conformance drops `getLog` equality; add retention-boundary tier exercised via the abstract retired-range set on Memory/JSONL.

# Appendices

- **A Glossary** `[REWRITE]` — entry, register, usage row, pending entry, partition, retention boundary, settlement kernel.
- **B Changes from agent-harness-spec.md** `[NEW]` — the jot part 8 delta table plus part 9 decisions, each with its reason.
- **C Coding-agent v3-format compatibility** `[CARRY]` — unchanged normalization rules (note: "v3" there names the old JSONL session format, not this document).
- **D Open questions** `[NEW]` — whatever survives: per-session retention length vs shared partitions; expired-lane product semantics; usage rows with no entry (partition of structural-failure usage); Postgres partition count/ops limits; pending-payload write-amplification measurement.
