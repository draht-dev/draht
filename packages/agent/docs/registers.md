# Scalar and list registers — implementation handoff

This document specifies the storage primitive only. It is intended to be implemented before tool durability and before any harness-native streaming tool API.

The existing register store becomes two statically typed namespace kinds:

- **scalar:** one current value per key; `set` replaces it;
- **list:** immutable elements appended under a key and read in bounded sequence pages.

List elements are append-only. Deleting a whole list key remains necessary for lifecycle cleanup. There is no element update, element delete, insertion, or truncation.

## Goals

1. Preserve the existing scalar register API and behavior.
2. Append a list element without reading the existing list.
3. Use the existing transaction sequence as the element cursor and order.
4. Produce identical pages on Memory, JSONL, and SQLite.
5. Keep list reads bounded and explicit.
6. Allow list writes to commit atomically with entries, usage, and scalar writes.

## Non-goals

This slice does not define:

- tool output or assistant stream element types;
- retention catalogs;
- per-element or per-key byte limits;
- empty-list existence markers;
- list truncation;
- audit logging;
- a generic event log or reducer for operation recovery.

Consumers own their key grammar, content limits, cleanup points, and restore hydration policy.

## Types

Keep the existing scalar value map and APIs. Do not rename `RegisterValues`, `Register`, `getRegister`, or `listRegisters` as part of this slice.

```ts
export interface RegisterValues {
  // Existing scalar namespaces, unchanged.
}

/** The value is one element, not an array. */
export interface ListRegisterValues {
  // Concrete namespaces are added by their consuming slices.
}

export type RegisterNamespace = keyof RegisterValues;
export type ListRegisterNamespace = keyof ListRegisterValues;

export interface ListRegisterElement<T> {
  /** Global transaction-write sequence assigned by storage. */
  seq: number;
  value: T;
}

export interface ListCursor {
  seq: number;
}

export interface ListReadOptions {
  /** Exclusive cursor. */
  cursor?: ListCursor;
  /** Default: `asc`. */
  order?: "asc" | "desc";
  /** Default: 1,000. Maximum: 10,000. */
  limit?: number;
}
```

Values remain trusted in-process values under the validation boundary in `harness.md`. Storage serializes them where required but does not runtime-validate their application shape or defensively clone them.

## Writes

One append write carries one element:

```ts
export type ListRegisterAppendWrite = {
  [N in ListRegisterNamespace]: {
    kind: "list-register";
    op: "append";
    namespace: N;
    key: string;
    value: ListRegisterValues[N];
  };
}[ListRegisterNamespace];

export type Write =
  | ExistingWrite
  | ListRegisterAppendWrite
  | {
      kind: "list-register";
      op: "delete";
      namespace: ListRegisterNamespace;
      key: string;
    };
```

A transaction appending several elements contains several append writes. This deliberately reuses the existing rule that every write receives its own strictly increasing sequence number. No ordinal or list-local counter is needed.

```text
TX[
  append list/ns/key = A,   // seq 41
  set scalar/ns/key = X,    // seq 42
  append list/ns/key = B    // seq 43
]
```

The elements under the list key are ordered `A, B` by sequence. Gaps caused by unrelated writes are irrelevant.

Rules:

- append never reads the list;
- whole-key delete removes every element under `(namespace, key)`;
- delete of an absent list is a no-op;
- delete followed by append in one transaction creates a fresh list atomically;
- all validation and serialization needed to admit a transaction occurs before any Memory state is changed;
- a failed transaction exposes none of its list or non-list writes.

“Append-only” describes an element while its key exists. Whole-key deletion is a lifecycle operation, not an element mutation.

## Reads

Add the same method to `Storage`, `SessionReader`, and `SessionMutator`:

```ts
readList<N extends ListRegisterNamespace>(
  namespace: N,
  key: string,
  options?: ListReadOptions,
): Promise<ListRegisterElement<ListRegisterValues[N]>[]>;
```

Semantics:

- ascending reads return `seq > cursor.seq`;
- descending reads return `seq < cursor.seq`;
- results are ordered according to `order` before `limit` is applied;
- absent and empty are both represented as `[]`;
- callers continue with the last returned element's `seq`;
- an empty page ends iteration;
- `limit` must be a positive safe integer, defaults to 1,000, and is capped at 10,000.

Example:

```ts
let cursor: ListCursor | undefined;
while (true) {
  const page = await reader.readList("example.items", "k", {
    cursor,
    order: "asc",
    limit: 100,
  });
  if (page.length === 0) break;
  consume(page);
  cursor = { seq: page[page.length - 1]!.seq };
}
```

A cursor is a sequence filter, not a snapshot or key-incarnation token. Concurrent later appends may appear on later ascending pages. A whole-key delete may make a cursor stale; reads simply apply its sequence comparison to the current elements.

Do not add an unbounded “read the whole list” helper.

## Restore policy

Scalar state remains authoritative:

1. restore scalar lane and operation registers;
2. perform current-state semantic validation;
3. derive any auxiliary list keys from that valid scalar state;
4. optionally hydrate bounded list pages for snapshots, diagnostics, or activation.

A missing list never invalidates an otherwise valid operation. List contents never prove that an external effect completed and never select the operation restart point.

This permits auxiliary append streams to be restored without making an unbounded list part of current-state validation. Each concrete consumer must define a hydration byte/page budget.

## Memory backend

Use one map keyed like scalar registers:

```ts
type StoredListElement = { seq: number; value: unknown };
const lists = new Map<string, StoredListElement[]>();
// map key: `${namespace}\u0000${key}`
```

- append pushes the already-sequenced element;
- delete removes the map entry;
- read filters by the exclusive cursor and slices to the validated limit;
- transaction preparation must complete before mutating entries, scalar registers, lists, usage, or stats.

The storage snapshot used by JSONL/fork tooling must include current list elements with their original sequence numbers.

## SQLite backend

Add a schema migration rather than modifying an already-applied migration:

```sql
CREATE TABLE list_registers (
  namespace TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  value     TEXT    NOT NULL,
  PRIMARY KEY (namespace, key, seq)
) WITHOUT ROWID;
```

Operations:

```sql
INSERT INTO list_registers(namespace, key, seq, value)
VALUES (?, ?, ?, ?);

SELECT seq, value
FROM list_registers
WHERE namespace = ? AND key = ? AND seq > ?
ORDER BY seq ASC
LIMIT ?;

SELECT seq, value
FROM list_registers
WHERE namespace = ? AND key = ? AND seq < ?
ORDER BY seq DESC
LIMIT ?;

DELETE FROM list_registers
WHERE namespace = ? AND key = ?;
```

For a missing cursor, omit the sequence predicate. All writes run in the existing `BEGIN IMMEDIATE` transaction under the existing writer lease. No marker table, counter row, additional connection, or lock order is needed.

Assert with `EXPLAIN QUERY PLAN` that paging uses the primary key and does not sort through a temporary b-tree.

## JSONL backend

Committed records retain the write sequence:

```jsonl
{"kind":"list-register","op":"append","seq":41,"namespace":"example.items","key":"k","value":{"text":"a"}}
{"kind":"list-register","op":"delete","seq":52,"namespace":"example.items","key":"k"}
```

Replay folds them into the Memory list map:

- append adds `{ seq, value }`;
- delete removes the complete map entry.

A transaction continues to occupy one physical JSONL line, using an array when it has multiple writes. Torn-tail handling therefore remains atomic for list writes without a new framing mechanism.

### Snapshot compaction

Compaction must preserve list cursors. Write every surviving list element as an append record carrying its original `seq`, merged into sequence order with surviving entries, scalar registers, and usage rows.

Do not collapse a live list into one synthetic append and do not assign new sequence numbers. Either action would change cursors and backend ordering.

Deleted lists produce no snapshot records. Preserve the storage sequence high-water mark using the same mechanism as the rest of JSONL snapshot compaction; dropping the latest delete must not permit sequence reuse after reopen.

## Forks and rewrites

The generic storage primitive does not decide whether a list namespace is copied. Session-level fork and precise-rewrite code must make an explicit decision for each concrete namespace.

Operation-owned auxiliary list namespaces are not copied into an idle fork. A future explicit application list may choose different behavior.

Precise rewrites that retain a list element preserve its sequence cursor unless that rewrite explicitly defines sequence remapping for the entire destination store.

## Schema evolution

A namespace's kind is static for one storage version. Changing a namespace from scalar to list or list to scalar requires an explicit migration; storage must never infer or coerce the change.

A list element migration iterates current elements in sequence order and either maps each value while preserving `seq` or explicitly deletes the whole key/namespace. The migration mechanism must page rather than load an unbounded namespace at once.

Adding the generic SQLite table is a storage schema migration. Adding the first logical list namespace does not require rewriting sessions that contain no values for it.

## Instrumentation

The instrumented storage decorator must expose list reads and continue recording committed writes exactly in transaction order. Telemetry's session-write item kinds gain `list-register` or otherwise count list writes explicitly; do not report them as scalar sets.

Append-path tests must be able to prove that no `readList` call occurred before commit.

## Invariants

1. Every namespace has one static kind in a storage version.
2. A scalar write cannot target a list namespace, and a list write cannot target a scalar namespace at the typed call site.
3. Every list element is immutable and addressed by its globally unique write `seq`.
4. Elements under one key are returned in sequence order on every backend.
5. Append performs no read of the target list.
6. List writes are atomic with entries, usage rows, and scalar writes in the same transaction.
7. Whole-key delete leaves no elements under the key.
8. Missing and empty have the same read result: `[]`.
9. Scalar restore and validation never depend on list contents.
10. JSONL compaction preserves surviving element sequences.

## Required tests

Extend the existing backend conformance suite; do not create a separate list-backend suite.

- append one element and page it;
- multiple appends to one key in one transaction;
- appends separated by unrelated writes preserve per-key order;
- ascending and descending exclusive cursors;
- default, explicit, invalid, and capped limits;
- absent key returns `[]`;
- whole-key delete and delete of absent key;
- delete followed by append in one transaction;
- rollback when a later write in the transaction is invalid;
- atomic list + entry + usage + scalar transaction;
- identical pages and sequence cursors on Memory, JSONL, and SQLite;
- JSONL torn multi-write transaction exposes none of its list elements;
- JSONL replay and snapshot compaction preserve cursors;
- SQLite paging query plans use the primary key;
- append path performs no list read;
- restore validation succeeds without reading lists, followed by bounded auxiliary hydration where a consumer requests it;
- close rejects later list reads and drains admitted list commits under the existing contract.

## Implementation map

Primary files expected to change:

- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/storage-state.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/jsonl/codec.ts`
- `packages/agent/src/harness/session/jsonl/storage.ts`
- `packages/agent/src/harness/session/testing/storage-decorator.ts`
- `packages/agent/src/harness/session/testing/instrumented-storage.ts`
- `packages/agent/src/harness/session/testing/conformance/storage.ts`
- `packages/session-backends/sqlite-node/src/sqlite/migrations.ts`
- a new migration under `packages/session-backends/sqlite-node/src/sqlite/migrations/`
- `packages/session-backends/sqlite-node/src/sqlite/session.ts`
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`
- a focused SQLite list-register module under `packages/session-backends/sqlite-node/src/sqlite/session/`
- SQLite storage tests and query-plan tests

After implementation, update the register portions of `harness.md` to point at the concrete API rather than maintaining a divergent second design.
