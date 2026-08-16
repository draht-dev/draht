# Typed scalar and list registers — implementation handoff

This document specifies the register storage primitive used by the harness.

Registers are identified by ordinary typed token values rather than a global `RegisterValues` or `ListRegisterValues` namespace map:

- **scalar register:** one current value per `(token, key)`; set replaces it;
- **list register:** immutable values appended under `(token, key)` and read in bounded sequence pages.

Built-in tokens live together in `packages/agent/src/harness/session/registers.ts` and are imported directly by their consumers. There is no `HarnessRegisters` bundle, runtime catalog, declaration merging, or raw register access from tools.

## Goals

1. Keep persisted register IDs stable while moving their value types onto tokens.
2. Allow built-in and future application register definitions without editing a global type map.
3. Preserve type inference through reads, writes, scans, and list appends.
4. Preserve existing scalar replacement semantics.
5. Append a list element without reading or rewriting existing elements.
6. Use the existing transaction sequence as list order and cursor.
7. Produce identical logical behavior on Memory, JSONL, and SQLite.
8. Keep list reads bounded and explicit.
9. Commit scalar/list writes atomically with entries and usage.

## Non-goals

This slice does not define:

- assistant-frame contents or reduction semantics;
- tool progress semantics;
- per-token runtime value validation;
- per-element or per-key byte limits;
- list truncation or per-element deletion;
- a generic event log or operation-state reducer;
- dynamic registration, token catalogs, or dependency-injected built-in token bundles.

Consumers own key grammar, content limits, cleanup points, and restore hydration policy. Values remain trusted typed in-process data under the validation boundary in `harness.md`.

## Token model

A token carries its register kind, stable persisted ID, and compile-time value type:

```ts
declare const registerValueType: unique symbol;

interface RegisterTokenBase {
  readonly id: string;
  readonly kind: "scalar" | "list";
}

export interface ScalarRegisterToken<T> extends RegisterTokenBase {
  readonly kind: "scalar";
  /** Compile-time only; makes the value type part of the token. */
  readonly [registerValueType]?: (value: T) => T;
}

export interface ListRegisterToken<T> extends RegisterTokenBase {
  readonly kind: "list";
  /** Compile-time only; T is one element, not the whole list. */
  readonly [registerValueType]?: (value: T) => T;
}

export function scalarRegister<T>(id: string): ScalarRegisterToken<T> {
  validateRegisterId(id);
  return Object.freeze({ id, kind: "scalar" });
}

export function listRegister<T>(id: string): ListRegisterToken<T> {
  validateRegisterId(id);
  return Object.freeze({ id, kind: "list" });
}
```

The phantom function keeps the type invariant: a token for one value type cannot silently widen to a token for another. It has no runtime field.

A register ID must be non-empty and must not contain the internal Memory-map separator (`\u0000`). It is serialized into JSONL and SQLite and therefore remains stable across reopen. Changing an ID or changing its scalar/list kind requires a storage migration.

Token object identity carries no durability meaning. Storage addresses a register by `(kind, token.id, key)`.

### No global value map

Delete these shapes:

```ts
interface RegisterValues { /* namespace → value */ }
interface ListRegisterValues { /* namespace → element */ }

type RegisterNamespace = keyof RegisterValues;
type ListRegisterNamespace = keyof ListRegisterValues;
```

A type belongs to its token regardless of where the token is defined:

```ts
export const laneLeaf = scalarRegister<string | null>("lane.leaf");
export const applicationState = scalarRegister<MyApplicationState>("my-app.state");
```

The storage API does not need to know either type centrally.

## Built-in tokens

Define built-ins directly in `packages/agent/src/harness/session/registers.ts`:

```ts
export const laneLeaf = scalarRegister<string | null>("lane.leaf");
export const laneConfig = scalarRegister<LaneConfiguration>("lane.config");
export const laneState = scalarRegister<LaneState>("lane.state");
export const laneLastResult = scalarRegister<LaneLastResult>("lane.lastResult");

export const operationMeta = scalarRegister<Operation>("op.meta");
export const operationState = scalarRegister<OperationState>("op.state");
export const operationToolArgs =
  scalarRegister<Record<string, JsonValue>>("op.tool_args");
export const operationToolFact = scalarRegister<JsonValue>("op.tool_fact");
export const operationPreparation =
  scalarRegister<DurableStructuralPreparation>("op.preparation");

export const pendingEntry = scalarRegister<PendingEntry>("pending.entry");
export const pendingToolOutput =
  scalarRegister<AgentToolResult<unknown>>("pending.tool_output");

/** Compact frames defined by the assistant-partial durability slice. */
export const pendingAssistantFrames =
  listRegister<DurableAssistantFrame>("pending.assistant_frame");

export const factName = scalarRegister<string>("fact.name");
export const factLabel = scalarRegister<string>("fact.label");
export const factCustom = scalarRegister<JsonValue>("fact.custom");
```

These are normal constants, not a configuration object. Harness code imports the token it uses:

```ts
await reader.getRegister(operationState, operationId);
await reader.readList(pendingAssistantFrames, frameKey, options);
```

A future application token may be defined in the application's own `registers.ts`. Persisted IDs must be globally unique within a session. Defining two tokens with the same `(kind, id)` but different TypeScript value types is a trusted-programming defect. Defining scalar and list tokens with the same ID is also a defect.

Tests assert that all built-in exported tokens have unique IDs and fixed kinds.

## Typed scalar API

```ts
export interface ScalarRegisterValue<T> {
  key: string;
  value: T;
  seq: number;
}

interface SessionReader {
  getRegister<T>(
    register: ScalarRegisterToken<T>,
    key: string,
  ): Promise<ScalarRegisterValue<T> | undefined>;

  listRegisters<T>(
    register: ScalarRegisterToken<T>,
    keyPrefix?: string,
  ): Promise<ScalarRegisterValue<T>[]>;
}
```

`listRegisters` lists scalar keys under one token; it is unrelated to list-register element reads. It retains its existing bounded-use contract: harness callers use exact operation-owned prefixes, and no public API exposes an unrestricted session dump.

Register writes are created through typed helpers. The stored transaction representation is erased only after the helper checks the token/value relationship:

```ts
interface RegisterSetWrite {
  kind: "register";
  op: "set";
  namespace: string;
  key: string;
  value: unknown;
}

interface RegisterDeleteWrite {
  kind: "register";
  op: "delete";
  namespace: string;
  key: string;
}

export function setRegister<T>(
  register: ScalarRegisterToken<T>,
  key: string,
  value: NoInfer<T>,
): RegisterSetWrite {
  return {
    kind: "register",
    op: "set",
    namespace: register.id,
    key,
    value,
  };
}

export function deleteRegister<T>(
  register: ScalarRegisterToken<T>,
  key: string,
): RegisterDeleteWrite {
  if (register.kind !== "scalar") throw new Error("Expected scalar register");
  return {
    kind: "register",
    op: "delete",
    namespace: register.id,
    key,
  };
}
```

`NoInfer<T>` makes the token authoritative. TypeScript must not widen `T` from an incompatible value argument.

The raw write interfaces are storage internals. Harness and application code use `setRegister()` and `deleteRegister()` rather than manually constructing erased writes.

## Typed list API

A list token's `T` is one immutable element:

```ts
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

interface SessionReader {
  readList<T>(
    register: ListRegisterToken<T>,
    key: string,
    options?: ListReadOptions,
  ): Promise<ListRegisterElement<T>[]>;
}
```

List writes also use typed helpers:

```ts
interface ListRegisterAppendWrite {
  kind: "list-register";
  op: "append";
  namespace: string;
  key: string;
  value: unknown;
}

interface ListRegisterDeleteWrite {
  kind: "list-register";
  op: "delete";
  namespace: string;
  key: string;
}

export function appendList<T>(
  register: ListRegisterToken<T>,
  key: string,
  value: NoInfer<T>,
): ListRegisterAppendWrite {
  return {
    kind: "list-register",
    op: "append",
    namespace: register.id,
    key,
    value,
  };
}

export function deleteList<T>(
  register: ListRegisterToken<T>,
  key: string,
): ListRegisterDeleteWrite {
  if (register.kind !== "list") throw new Error("Expected list register");
  return {
    kind: "list-register",
    op: "delete",
    namespace: register.id,
    key,
  };
}
```

`Write` adds the four erased scalar/list write representations alongside entries and usage. A transaction may mix every write kind atomically.

## List write semantics

One append write carries one element. A transaction appending several elements contains several append writes. Every write receives its existing globally increasing transaction sequence:

```text
TX[
  append pendingAssistantFrames/O:R = A,  // seq 41
  set operationState/O = X,               // seq 42
  append pendingAssistantFrames/O:R = B   // seq 43
]
```

Elements under list key `O:R` are ordered `A, B` by sequence. Gaps caused by unrelated writes are irrelevant.

Rules:

- append never reads existing elements;
- an element is immutable after commit;
- whole-key delete removes every element under `(token.id, key)`;
- delete of an absent list is a no-op;
- delete followed by append in one transaction creates a fresh list atomically;
- there is no per-element update, delete, insertion, or truncation;
- all validation and serialization needed to admit a transaction completes before Memory state changes;
- a failed transaction exposes none of its list or non-list writes.

“Append-only” describes elements while the key exists. Whole-key deletion is lifecycle cleanup, not element mutation.

## List read semantics

- ascending reads return `seq > cursor.seq`;
- descending reads return `seq < cursor.seq`;
- results are ordered according to `order` before `limit` is applied;
- absent and empty both return `[]`;
- callers continue with the last returned element's `seq`;
- an empty page ends iteration;
- `limit` must be a positive safe integer, defaults to 1,000, and is capped at 10,000.

```ts
let cursor: ListCursor | undefined;
while (true) {
  const page = await reader.readList(pendingAssistantFrames, frameKey, {
    cursor,
    order: "asc",
    limit: 100,
  });
  if (page.length === 0) break;
  consume(page);
  cursor = { seq: page[page.length - 1]!.seq };
}
```

A cursor is a sequence filter, not a snapshot or key-incarnation token. Concurrent later appends may appear on later ascending pages. A whole-key delete may make a cursor stale; reads simply apply its sequence comparison to the currently surviving elements.

Do not add an unbounded “read the whole list” helper.

## Assistant partial frames

Assistant partial durability is the first list consumer:

```text
register: pendingAssistantFrames
key:      {operationId}:{responseEntryId}
value:    one bounded DurableAssistantFrame
```

The frame type is finalized with the assistant-stream design, not by storage. It must be a compact incremental frame. Do not append raw `AssistantMessageEvent`: update events contain a growing `partial` message and would reintroduce write amplification inside the list elements.

The assistant procedure may batch several frame appends into one transaction, but each frame remains an independently sequenced list element. Its scalar `effect_pending` state remains authoritative.

On restore:

1. restore and validate scalar lane/operation state;
2. derive the exact frame key from the valid assistant effect-pending state;
3. read bounded pages from `pendingAssistantFrames`;
4. reduce frames into the latest durable partial assistant message.

A missing frame list is valid and means no partial frame committed. Frames never prove provider completion and never select a restart state.

Final assistant settlement atomically commits the complete immutable assistant entry and deletes the whole frame-list key:

```text
TX[
  insert final assistant entry,
  insert usage,
  deleteList(pendingAssistantFrames, O:R),
  set operationState/O = next state
]
```

Unknown-effect recovery may reduce the latest durable frames into its synthetic interrupted assistant response, but that policy belongs in the assistant durability specification.

## Restore policy

Scalar state remains authoritative for every list consumer:

1. restore scalar lane and operation registers;
2. perform current-state semantic validation;
3. derive auxiliary list keys from valid scalar state;
4. optionally hydrate bounded list pages for snapshots, diagnostics, or activation.

A missing list never invalidates an otherwise valid operation. List contents never prove that an external effect completed.

Each concrete list consumer defines:

- key grammar;
- element and total byte bounds;
- page/hydration budget;
- cleanup transitions;
- fork and migration policy.

## Memory backend

Keep scalar registers in the existing map, now addressed by token ID:

```ts
const scalars = new Map<string, ScalarRegisterValue<unknown>>();
// map key: `${register.id}\u0000${key}`
```

Add list storage:

```ts
type StoredListElement = { seq: number; value: unknown };
const lists = new Map<string, StoredListElement[]>();
// map key: `${register.id}\u0000${key}`
```

- scalar set replaces the map value;
- scalar delete removes it;
- list append pushes the already-sequenced element;
- list delete removes the complete array;
- list read filters by exclusive cursor and slices to the validated limit;
- transaction preparation completes before entries, scalar registers, lists, usage, or stats mutate.

Storage snapshots used by JSONL/fork tooling include current scalar values and surviving list elements with original sequence numbers.

## SQLite backend

The existing scalar register table continues to store `token.id` in its namespace column. No scalar schema change is required.

Add a schema migration for lists rather than modifying an applied migration:

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

For a missing cursor, omit the sequence predicate. All writes run in the existing `BEGIN IMMEDIATE` transaction under the writer lease. No marker table, counter row, connection, or new lock order is needed.

Assert with `EXPLAIN QUERY PLAN` that paging uses the primary key and no temporary sort.

## JSONL backend

Scalar records retain their current persisted namespace string. Typed tokens are an API change, not a JSONL format rewrite.

List records use the token ID as `namespace`:

```jsonl
{"kind":"list-register","op":"append","seq":41,"namespace":"pending.assistant_frame","key":"O:R","value":{"type":"text_delta","contentIndex":0,"delta":"hi"}}
{"kind":"list-register","op":"delete","seq":52,"namespace":"pending.assistant_frame","key":"O:R"}
```

Replay folds records into the Memory list map:

- append adds `{ seq, value }`;
- delete removes the complete list key.

A transaction remains one physical JSONL line, using an array for multiple writes. Torn-tail handling therefore remains atomic without new framing.

### Snapshot compaction

Compaction preserves list cursors. Write every surviving element as an append record carrying its original `seq`, merged in sequence order with surviving entries, scalar registers, and usage rows.

Do not collapse a live list into one synthetic append or assign new sequence numbers. Either changes cursors and backend ordering.

Deleted lists produce no snapshot records. Preserve the storage sequence high-water mark through the existing mechanism so dropping the latest delete cannot permit sequence reuse.

## Forks and rewrites

Fork and precise-rewrite code decides policy per concrete token, using token identity in source code and the stable ID in storage.

Operation-owned tokens are not copied into an idle fork:

- `operationMeta` and other `op.*` scalar tokens;
- `pendingEntry` and `pendingToolOutput`;
- `pendingAssistantFrames`.

Application-defined persistent tokens may define a different policy when their consuming feature is added.

A precise rewrite retaining a list element preserves its sequence cursor unless the rewrite explicitly remaps the entire destination sequence space.

## Schema evolution

A token's persisted ID and kind are static for one storage version.

- changing an ID requires an explicit old-ID to new-ID migration;
- changing scalar to list or list to scalar requires an explicit migration;
- storage never infers or coerces a kind change from observed records;
- changing only the TypeScript value type requires a total value migration when old stored values are not already valid under the new type.

A list migration pages current elements in sequence order and either maps values while preserving `seq` or deletes the whole key/token. It must not load an unbounded logical list at once.

Adding the generic SQLite list table is a storage schema migration. Adding a new token with no stored values does not rewrite existing sessions.

## Instrumentation

The instrumented storage decorator exposes token-based scalar/list reads and records committed erased writes in exact transaction order.

Telemetry session-write item kinds include `list-register` explicitly; list appends/deletes are not reported as scalar writes. Token IDs may be attributes, but values and assistant-frame contents never enter telemetry.

Append-path tests prove no `readList` call occurred before commit.

## Invariants

1. Every token has one stable persisted ID and one static kind in a storage version.
2. Built-in token IDs are unique.
3. Token-based reads and helper-constructed writes preserve the token's value type.
4. A scalar helper cannot target a list token; a list helper cannot target a scalar token.
5. Every list element is immutable and addressed by its globally unique write `seq`.
6. Elements under one list key are returned in sequence order on every backend.
7. Append performs no read of the target list.
8. Scalar/list writes are atomic with entries and usage in the same transaction.
9. Whole-key list delete leaves no elements under that key.
10. Missing and empty lists both read as `[]`.
11. Scalar restore and validation never depend on list contents.
12. JSONL compaction preserves surviving element sequences.
13. Deleting operation-owned scalar and list state at terminal cleanup leaves no recoverable partial assistant content.

## Required tests

### Token typing and identity

- scalar reads infer the token's value type;
- list reads infer the token's element type;
- `setRegister` rejects an incompatible value at compile time;
- `appendList` rejects an incompatible element at compile time;
- scalar helpers reject list tokens and list helpers reject scalar tokens;
- independently defined application tokens work without declaration merging;
- built-in IDs are non-empty, separator-free, unique, and have fixed kinds;
- token IDs round-trip through Memory, JSONL, and SQLite;
- two differently typed definitions using one persisted ID are documented/tested as a programming defect rather than supported aliasing.

### Scalar regression

- existing scalar set/get/list/delete/recreate behavior is unchanged;
- replacement retains only the latest logical value;
- token-based helpers preserve mixed transaction write order;
- existing scalar JSONL and SQLite files open without a format rewrite.

### List conformance

Extend the shared backend conformance suite:

- append one element and page it;
- multiple appends to one key in one transaction;
- appends separated by unrelated writes preserve per-key order;
- ascending and descending exclusive cursors;
- default, explicit, invalid, and capped limits;
- absent key returns `[]`;
- whole-key delete and delete of absent key;
- delete followed by append in one transaction;
- rollback when a later write is invalid;
- atomic list + entry + usage + scalar transaction;
- identical pages and sequence cursors on Memory, JSONL, and SQLite;
- JSONL torn multi-write transaction exposes no list element;
- JSONL replay and snapshot compaction preserve cursors;
- SQLite paging query plans use the primary key;
- append path performs no list read;
- restore validation succeeds without reading lists, followed by bounded hydration;
- close rejects later list reads and honors already-admitted list commits.

### Assistant-frame integration

- compact frames append under the exact effect-pending response key;
- raw events with growing `partial` snapshots are never persisted;
- frame pages reduce to the same partial message as uninterrupted streaming;
- missing/empty frame list restores as no durable partial;
- final assistant settlement atomically deletes the frame list;
- unknown-effect recovery reads only the bounded list named by scalar state;
- external finalization deletes the operation-owned frame list;
- idle forks contain no assistant-frame list;
- backend byte-growth tests show append-linear rather than repeated-snapshot growth.

## Implementation map

Primary files expected to change:

- new `packages/agent/src/harness/session/registers.ts` for token types, factories, helpers, and built-in constants;
- `packages/agent/src/harness/session/types.ts` to remove global value maps and expose token-based reader methods;
- `packages/agent/src/harness/session/storage-state.ts`;
- `packages/agent/src/harness/session/memory.ts`;
- `packages/agent/src/harness/session/session.ts`;
- `packages/agent/src/harness/session/jsonl/codec.ts`;
- `packages/agent/src/harness/session/jsonl/storage.ts`;
- `packages/agent/src/harness/session/testing/storage-decorator.ts`;
- `packages/agent/src/harness/session/testing/instrumented-storage.ts`;
- `packages/agent/src/harness/session/testing/conformance/storage.ts`;
- `packages/session-backends/sqlite-node/src/sqlite/migrations.ts`;
- a new SQLite migration for `list_registers`;
- `packages/session-backends/sqlite-node/src/sqlite/session.ts`;
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`;
- focused SQLite list paging and query-plan tests.

After implementation, update `harness.md` to use imported tokens rather than namespace-string/type-map examples and add the concrete assistant-frame lifecycle.
