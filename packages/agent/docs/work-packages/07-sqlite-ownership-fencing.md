# WP07 — SQLite ownership fencing

**Status: actionable handoff; not implemented.**

This package fixes data-safety defects in `packages/session-backends/sqlite-node`. It does not optimize branch indexing, forks, search, frame persistence, or general query performance.

Shared-container mode (`databasePath`) remains supported. Removing it is outside this package.

## 0. Mandatory reading

Read completely before editing:

1. `packages/agent/docs/harness.md` §§1.4, 1.7, 2.7–2.8, 4.3, and Part 9.
2. `packages/agent/docs/post-wp05-roadmap.md`.
3. `packages/agent/src/harness/session/types.ts`, `session.ts`, `memory.ts`, and repository conformance.
4. every source file under `packages/session-backends/sqlite-node/src`.
5. every test and benchmark under `packages/session-backends/sqlite-node`.
6. `packages/session-backends/sqlite-node/README.md` and `CHANGELOG.md`.

Do not use stale files under `dist/` as implementation input.

## 1. Problem

### 1.1 Commit fencing has a gap

Current commit order:

```text
TX A: renew/assert (owner_id, fence); COMMIT
                                      ← replacement may claim here
TX B: read next_seq; write Session data; COMMIT
```

`SqliteStorage.applyCommit()` calls `beforeCommit()` before `db.transaction(...)`. `SqliteSessionRepo` supplies a `beforeCommit` callback that renews the writer lease in its own transaction. The data transaction never checks the lease.

Concrete failure:

```text
writer A renews fence 4
A pauses until that lease expires
writer B claims fence 5 and commits
A resumes and commits Session rows without checking fence 4
```

The lease table has then failed to enforce one writer. Sequence allocation and branch/value updates can interleave across owners that both believe they are authoritative.

### 1.2 Deletion has the same check/use gap

Current deletion order:

```text
open connection A
read writer_lease; observe no live claim
close A
                                      ← writer may claim here
open connection B and delete rows, or unlink the file
```

A shared-container delete can remove rows after a replacement writer claims them. A per-session delete can unlink a database that another process has just opened and claimed.

### 1.3 Repository identity and close are not strong enough

- `openStorages` is keyed only by Session ID. `open()` accepts metadata paths, so a fork using the same ID at another path can snapshot the wrong active storage.
- `create()` makes `options.directory`, not the parent of an explicit `databasePath`.
- Per-session filenames interpolate caller-supplied IDs directly. The public repository contract and conformance use explicit arbitrary IDs; path separators must not escape the configured directory.
- `repo.close()` uses fail-fast `Promise.all`. One rejection can return while other Session closes are still draining and releasing writer claims.

These are included because they affect ownership identity or release. Deterministic list ordering, bind-variable limits, branch-copy cost, fork scalar scans, prepared statements, and VACUUM policy do not.

## 2. Required result

### 2.1 Fence inside every data transaction

Every `SqliteStorage` commit must execute this order in **one** `BEGIN IMMEDIATE` transaction:

```text
BEGIN IMMEDIATE
assert and renew this exact (session_id, owner_id, fence)
read/advance next_seq
apply entries, usage, values, lists, branch projection, and stats
COMMIT
```

If the exact lease is absent or replaced, the transaction rolls back without changing Session data. Lease assertion must not call a nested transaction.

The idle renewal timer remains a separate transaction because no data transaction exists while idle. Any timer renewal failure leaves ownership uncertain and fail-closes that open Session; distinguishing transient SQLite availability failures from confirmed lease replacement is later policy work. A successful idle renewal does not authorize a later commit by itself: the commit still checks inside its own transaction.

Repository-owned `SqliteStorage` must receive the exact lease identity or a transaction-local assertion callback, not an unfenced “before commit” side effect. Standalone storage instances used by storage conformance have no repository lease and remain unfenced. Keep the concrete sequence-allocation and write loop visible.

### 2.2 Make deletion exclusive through the destructive boundary

#### Shared container

Validate lease state and delete all rows for the Session in one `BEGIN IMMEDIATE` transaction. No other writer may claim between the check and row deletion. A live unexpired claim rejects deletion without changing rows.

#### Per-session file

A normal expiring writer lease cannot fence unlink by itself: a deleter may stall past expiry after closing SQLite, a replacement may claim, and the stale deleter may then unlink the replacement's live database. Per-file deletion therefore uses one narrow path tombstone and an owner-specific quarantine path:

1. atomically create a sibling deletion-tombstone file containing a fresh deletion owner id; `open`, source-fork reads, listing probes, and destination creation use open-existing/tombstone-aware helpers rather than create-on-open;
2. in one `BEGIN IMMEDIATE` transaction, reject a live ordinary writer or install a **non-expiring deletion claim** under that owner and a fresh fence;
3. close SQLite, atomically rename the canonical database and any WAL/SHM files to owner-specific quarantine names while the tombstone excludes new opens;
4. after rename, this deletion attempt removes only its owner-specific quarantine files, never the canonical database or canonical sidecars;
5. remove the tombstone last with an exact owner check; a later `delete` may idempotently finish the quarantine named by that tombstone, and concurrent finishers remain harmless because neither touches canonical paths;
6. if an ordinary writer won the database transaction after checking the path but before tombstone creation, deletion observes that live claim, removes only its own tombstone, and rejects.

Extend `SqliteDatabaseFactory` with an `openExisting` operation whose contract is read-write open without file creation. The Node adapter uses SQLite URI `mode=rw`; missing paths fail instead of leaving empty containers. Reserve `open` for intentional creation. Destination creation checks the tombstone both before and immediately after its exclusive file reservation, before SQLite initialization; if deletion won, it removes only that reservation and rejects. Use `openExisting` for metadata open, list probes, deletion, and closed-source forks.

This is a purpose-built deletion intent, not a general filesystem lock manager. It closes all three gaps: the database transaction orders already-in-flight openers against deletion, the tombstone covers canonical-path publication, and quarantine ensures a stale/concurrent finisher can never unlink a later recreated Session. A process crash may leave deletion pending and the Session unavailable; retrying `delete` completes it. Never let an ordinary writer take over a deletion claim, and never remove another owner's tombstone, claim, or quarantine.

Deletion of an already-open Session in the same repository continues to reject before destructive work. Cross-process correctness must not depend on the process-local `pendingIds` set.

### 2.3 Bind active storage to physical identity

Active-source lookup for fork must include canonical container identity and Session ID. A foreign or mismatched metadata path must never select another active `SqliteStorage` merely because IDs match.

Define one helper for repository-affine physical identity and use it consistently when publishing, looking up, and removing active storage. Preserve intentional shared-container behavior: two Session IDs in one canonical container remain distinct.

Do not silently open arbitrary foreign metadata as though it belonged to this repository. Either validate repository affinity at `open`/`fork` or handle the foreign source only through its exact path without aliasing a local active Session; pin the chosen rule in tests and README.

### 2.4 Make paths safe and predictable

- Create the actual parent directory of `databasePath` when that option is present.
- Map explicit Session IDs to safe per-session filenames without changing the durable Session ID. Encoding must prevent `/`, `\\`, `..`, or platform separators from escaping `directory`.
- Metadata returned by create/list/open must continue to identify the actual container path.
- Existing metadata paths are opened as supplied after the repository-affinity checks above; this WIP format package adds no migration or filename-renaming pass.

### 2.5 Drain all closes

This is backend-local claim cleanup, not a decision about adding `close()` to the shared `SessionRepo` interface or changing JSONL repository ownership.

`SqliteSessionRepo.close(context)` must:

1. seal repository admission once;
2. start close on every currently open Session;
3. wait for every close to settle;
4. resolve when all succeed;
5. otherwise reject only after all claims/connections have had their cleanup attempt, preserving every failure in an `AggregateError` when more than one exists.

Idempotent repeated close returns the same promise.

## 3. Implementation slices

### Slice A — transaction-local writer assertion

Files:

- `src/sqlite/storage.ts`
- `src/sqlite/repo.ts`
- `src/sqlite/session/writer-lease.ts`
- focused storage/repository tests

Tasks:

1. Replace `beforeCommit` with exact lease fencing available inside `SqliteStorage.applyCommit()`’s transaction.
2. Keep timer renewal transaction-wrapped in the open-Session owner.
3. Ensure lease loss propagates through `SqliteOpenSession` without releasing a replacement lease.
4. Add a deterministic two-connection regression that fails under the old renew-then-commit split.

Stop after Slice A if making the lease check transaction-local requires hiding the storage write procedure behind a generic transaction abstraction.

### Slice B — exclusive deletion

Files:

- `src/index.ts`
- `src/sqlite/types.ts`
- `src/sqlite/repo.ts`
- `src/sqlite/session/session-row.ts`
- `src/sqlite/session/writer-lease.ts`
- focused repository tests

Tasks:

1. Add a read-write, no-create `openExisting` factory operation and move every non-creation path to it.
2. Shared container: one lease-check-and-row-delete transaction.
3. Per-session file: atomic sibling tombstone, non-expiring database deletion claim, owner-specific quarantine, resumable cleanup, and tombstone-last removal.
4. Test both race orders, concurrent deletion finishers, and crashes at each tombstone/claim/quarantine boundary.

### Slice C — physical identity, safe paths, and close draining

Files:

- `src/sqlite/repo.ts`
- focused repository/conformance tests

Tasks:

1. Canonical `(container, sessionId)` active-source keys and repository-affinity checks.
2. Actual `databasePath` parent creation.
3. Safe filename encoding for explicit IDs.
4. all-settled repository close with complete error reporting.

### Slice D — documentation

Files:

- `packages/session-backends/sqlite-node/README.md`
- `packages/agent/docs/harness.md` SQLite subsection
- `packages/agent/docs/post-wp05-roadmap.md`
- changelog only under the repository’s normal changelog rules

The roadmap audit already corrected the README's class/example/search/connection claims and `harness.md`'s shared-container wording. Preserve those corrections. After the implementation lands, document:

- writer fencing is checked in the same transaction as Session writes;
- shared-container deletion is atomic with its lease check;
- per-file deletion uses a resumable path tombstone, database deletion claim, and owner-specific quarantine;
- non-creation opens use no-create mode, so deletion races cannot leave empty containers;
- a crash may leave deletion pending and ordinary open rejected until `delete` resumes it.

Do not describe S3 search as implemented.

## 4. Required tests

Use real `node:sqlite` connections for ownership tests. Test helpers may wrap `SqliteDatabase` to expose deterministic transaction boundaries; production code must not gain sleep hooks or race-only flags.

### Commit fencing

- exact current owner/fence commits successfully and renews expiry in the same transaction;
- stale owner after another repository claims a higher fence cannot insert an entry, advance `next_seq`, change a value/list, update stats, or mutate branch projections;
- deterministically force a replacement claim at the old between-transactions seam: old code commits incorrectly, new code gives the replacement either the before-commit or after-commit history, never stale-owner data after replacement;
- idle timer renewal still retains ownership;
- timer-detected loss rejects later reads/mutations according to the existing open-Session lease-failure policy;
- stale close cannot release a replacement `(owner_id, fence)`.

### Deletion

For both shared-container and per-session-file modes:

- live unexpired writer first → delete rejects and Session remains usable;
- delete owns exclusivity first → later open/claim rejects and deletion completes;
- expired lease without replacement → delete succeeds;
- shared-container deletion removes only the target Session;
- per-file rename/removal failure leaves a resumable tombstone/claim/quarantine and ordinary open stays rejected until deletion is retried;
- crash after tombstone creation, after the database deletion claim, after canonical-to-quarantine rename, and after each quarantine removal is resumable;
- concurrent deletion finishers cannot touch canonical paths after quarantine and cannot remove another owner's tombstone;
- a stale deleter never removes a replacement writer’s claim or data;
- metadata open, listing, source fork, and delete racing a removed path cannot recreate an empty container file;
- destination create checks the tombstone before and after exclusive reservation and cannot publish a Session during deletion.

### Identity and paths

- same Session ID at two physical paths cannot cross-select an active fork source;
- two different Session IDs in one shared container remain independently addressable;
- custom `databasePath` succeeds when its parent does not exist;
- explicit IDs containing `../`, `/`, `\\`, `%`, and Unicode remain inside `directory` and round-trip as metadata IDs, as required by the currently unconstrained `SessionCreateOptions.id`;
- foreign/mismatched metadata follows the documented reject-or-exact-path rule;
- list/create/open/fork return the actual path.

### Close

- one Session close failure does not prevent every other open Session from finishing cleanup;
- multiple failures are reported after all settle;
- repeated repository close is idempotent;
- no connection or writer claim remains owned by a Session whose cleanup succeeded.

### Regression

- existing storage and repository conformance remains unchanged;
- fork snapshot boundaries remain coherent;
- every write transaction still begins `BEGIN IMMEDIATE`;
- shared-container create/list/open/fork/delete behavior remains supported;
- no storage-version bump, migration, schema rewrite, or compatibility layer is added.

## 5. Validation

After each code slice:

```bash
npm run check
```

Run each modified focused test from `packages/session-backends/sqlite-node` with the repository Vitest binary. Final validation:

```bash
./test.sh
```

Do not run `npm test`, the full Vitest suite directly, or `npm run build` unless requested.

Review checkpoints:

1. Fable review after Slice A, focused on whether a stale owner can still write.
2. Fable review after Slice B, focused on both deletion race orders and unlink failure.
3. Final Fable review of implementation, tests, docs, and exclusions.

Delegated reviews use provider `anthropic` and model `claude-fable-5`.

## 6. Metrics

Record before/after results for:

- SQL transaction count per ordinary commit (target: one write transaction, not renew plus write);
- SQL transaction count per shared-container deletion (target: one destructive transaction);
- per-file tombstone/claim/quarantine transitions and no-create open failures;
- open writer-lease rows and connections after repository close;
- focused race-test histories for both orders.

A small increase in statements inside the one commit transaction is expected and required. Throughput optimization is not an exit criterion.

## 7. Exclusions

Do not include:

- SQLite branch-segment redesign or uncompacted-divergence optimization;
- fork scalar filtering/indexing;
- `getEntries` bind-limit chunking or general query-limit normalization;
- statement caches or stats aggregation optimization;
- catalog redesign, async database replacement, VACUUM/space-reclamation policy;
- search/FTS;
- R11 migration machinery or a storage-version bump;
- M11 assistant-frame changes or JSONL compaction;
- repository-wide `SessionRepo.close()` contract changes;
- removal of shared-container support;
- generic lock managers (the per-file deletion tombstone is the one narrow exception), transaction DSLs, schedulers, or compatibility layers.

If a correctness fix requires one excluded item, stop and revise the handoff rather than expanding silently.

## 8. Exit condition

WP07 is complete when:

- no repository-owned Session data transaction can commit without proving its exact writer fence inside that transaction;
- shared deletion is atomic with its lease check;
- per-file deletion orders in-flight openers through the database claim, quarantines canonical files before removal, and never lets stale cleanup touch a recreated canonical Session;
- active fork sources are selected by physical container identity plus Session ID;
- explicit IDs cannot escape the per-session directory and custom database parents are created;
- repository close waits for all Session cleanup attempts;
- shared-container mode remains fully covered;
- README and normative SQLite documentation describe the implementation that exists;
- focused tests, `npm run check`, and `./test.sh` pass;
- final Fable review reports no blocker.
