# AgentHarness storage and retention redesign

**Status:** proposed delta to `agent-harness-spec.md`. This document assumes that specification is known. It describes only the proposed replacement storage model and the questions that remain. Until merged into the main specification, the main specification is authoritative.

## Motivation

The current design separates a tree node from its payload value because queued content may become durable long before tree placement. It also writes each lane/operation state revision as an immutable value and moves a slot to the newest revision.

That produces three avoidable problems:

1. Completed operations leave operation, state, tool-argument, preparation, fact, and configuration values behind.
2. `slot_history` retains state-transition history that execution never reads.
3. A pending value and its eventual node can land in different retention partitions. Deleting the old value partition then corrupts the newer node.

Context compaction, operation garbage collection, and conversation retention are separate concerns:

- **Context compaction** changes what is sent to a provider.
- **Operation cleanup** removes state that stopped being observable when an operation completed.
- **Conversation retention** intentionally removes old user-visible tree history.

None should implicitly control another.

## New storage model

The durable model has three primary categories:

```text
nodes          complete immutable conversation nodes
slots          current mutable state and pending node payloads
usage_ledger   immutable billing/accounting events
```

SQLite keeps auxiliary tables for branch lookup, FTS, stats, partition metadata, sequencing, and writer leases.

There is no general `stored_values` table, no `valueId`, and no node/value materialization join.

### Complete nodes

A stored node is also the application-facing node:

```ts
interface NodeBase {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  partitionId: string;
}

interface MessageNode extends NodeBase {
  type: "message";
  message: AgentMessage;
  terminate?: true;
}

interface CompactionNode extends NodeBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

interface BranchSummaryNode extends NodeBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

interface CustomNode extends NodeBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

type Node = MessageNode | CompactionNode | BranchSummaryNode | CustomNode;
```

`StoredNode`, `StoredValue`, `ValueKind`, `valueId`, and `toNode()` disappear.

### Typed slots

A slot is a mutable namespaced key containing its current typed value, not an ID pointing at another state value:

```ts
interface SlotValues {
  "lane.leaf": string | null;
  "lane.config": LaneConfiguration;
  "lane.state": LaneState;

  "op.meta": Operation;
  "op.state": OperationState;
  "op.tool_args": Record<string, JsonValue>;
  "op.preparation": DurableStructuralPreparation;

  "pending.node": PendingNode;
  "queue.disposition": QueueDisposition;

  "fact.name": string;
  "fact.label": string;
  "fact.custom": JsonValue;
}

interface Slot<N extends keyof SlotValues = keyof SlotValues> {
  namespace: N;
  key: string;
  seq: number;
  value: SlotValues[N];
}
```

Large state that stays unchanged across transitions gets its own stable operation slot:

```text
op.meta/{operationId}
op.state/{operationId}
op.tool_args/{operationId}:{sourceIndex}
op.preparation/{operationId}:{taskId}
```

`op.state` contains the total mutable program counter but names deterministic operation slots for large stable data. This avoids repeatedly serializing tool arguments or preparation while keeping all operation-only data out of the conversation tables.

Conditional transitions compare the expected slot `seq` rather than the ID of an immutable state value.

Slot deletion is distinct from storing JSON `null`. Completing an operation deletes its operation slots. Deleting a fact deletes its slot; a custom fact may still store JSON `null` as a real value.

### Pending nodes

Content accepted before placement lives in a stable slot:

```ts
interface PendingNode {
  type: Node["type"];
  customType?: string;
  payload: JsonValue;
}
```

Examples are `nextRun`, steer/follow-up input, and deferred tree writes:

```text
pending.node/{reservedNodeId} -> payload
lane/op queue state           -> reservedNodeId
```

Placement atomically:

1. reads the pending slot;
2. creates one complete node with the current parent, sequence, timestamp, partition, and payload;
3. deletes the pending slot;
4. removes the node ID from queue state;
5. updates `lane.leaf`.

Assistant responses and tool results need no pending slot. Their IDs are reserved in operation state, and settlement creates the complete node directly.

A cancelled pending node is deleted without ever entering the conversation table.

### Usage ledger

Usage is neither mutable state nor necessarily a node. It has a dedicated append-only ledger:

```sql
usage_ledger(
  session_id,
  id,
  seq,
  node_id,
  adjustment,
  usage_json,
  details_json,
  partition_id,
  PRIMARY KEY (session_id, id)
);
```

`session_stats` remains the maintained aggregate. Retention may later collapse old usage rows into an adjustment without affecting totals.

### No built-in slot history

Remove:

- `slot_history`;
- `getLog()` and `LogItem`;
- Memory's transaction log;
- SQLite history-union queries and history-only indexes.

Execution reads only current slots. Applications that need an operational audit install a telemetry adapter and persist sanitized transaction/slot events externally.

JSONL may physically retain old slot updates until snapshot compaction, but they are not a queryable history contract and may disappear on any rewrite.

## Operation lifecycle and cleanup

Operation-only durable data exists entirely in current slots. Completion atomically:

1. publishes final nodes and usage;
2. writes the idle `lane.state` value;
3. deletes `op.meta/{operationId}` and `op.state/{operationId}`;
4. deletes all `op.tool_args` and `op.preparation` slots for the operation;
5. deletes any still-pending nodes owned by the operation;
6. clears the lane's current operation.

There is no durable `FinishedState` after completion. The terminal transaction and idle lane are the durable completion boundary. The live result is computed before commit from data that either remains in nodes/usage or is still in memory.

This makes operation cleanup explicit and bounded. It needs no historical reduction, value scan, or mark-and-sweep over old state revisions.

## SQLite shape

```sql
nodes(
  session_id,
  id,
  parent_id,
  seq,
  timestamp,
  partition_id,
  type,
  custom_type,
  payload_json,
  PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

slots(
  session_id,
  namespace,
  key,
  seq,
  value_json,
  PRIMARY KEY (session_id, namespace, key)
);
```

Branch and type indexes continue to use node metadata. Branch scans no longer join through a payload table. Pending-node placement can use `INSERT ... SELECT` from the pending slot followed by slot deletion in one transaction when catalog and nodes share a database.

## What this enables

### Trivial operation cleanup

State updates overwrite current slot values. Stable operation slots are deleted at completion. No immutable administrative values accumulate.

### Self-contained tree rows

A retained node always contains its payload. Deleting a node deletes its content; retaining it cannot leave a missing payload dependency.

### Simpler pending-content lifecycle

Unplaced content is visibly pending because a slot exists. Placement creates exactly one tree row. Cancellation deletes one slot.

### Easier partitioning

Pending data remains in the unpartitioned hot slot store. Partition assignment occurs only when a complete node is placed, so payload and structure cannot land in different partitions.

The normal partition contents become:

```text
complete nodes
branch-index rows
FTS rows
associated usage rows
```

Routine partition expiry therefore does not need to discover or move values referenced by retained nodes.

### Separation from context compaction

Calendar/TTL partitioning can remove old conversation history independently of model-context compaction. Compaction remains a provider-context operation and does not become a storage lifecycle marker.

## Retention mechanisms

Two conversation-retention mechanisms remain possible and may coexist:

1. **Partition expiry.** Assign complete nodes to context-safe time partitions and drop sealed partitions. This is the fast routine TTL path, but it must tolerate retired parents and current slots targeting expired nodes.
2. **Precise session rewrite.** Compute retained nodes from lane-specific policy, copy the retained set into a new store, briefly freeze commit admission, apply the tail, and atomically swap stores. This supports arbitrary branch-aware pruning but costs `O(retained data)` and is an administrative rewrite, not context compaction.

For SQLite, a rewrite should copy retained rows to a new file rather than run `DELETE ... NOT IN (...)` over all historical rows while writes are frozen. Operation cleanup uses neither mechanism; it happens continuously through slot lifecycle.

## Partitioning direction

A likely physical design is:

```text
hot session catalog
  current slots
  pending nodes
  operation state
  facts
  partition inventory
  aggregate stats

immutable/sealable partition P
  complete nodes
  branch/FTS projections
  usage rows
```

Nodes that must remain together for provider-valid context need the same partition key. At minimum, an assistant node containing tool calls and every corresponding tool-result node share a context-group partition. A simpler policy may assign all nodes from one accepted run to the run's partition epoch rather than each row's wall-clock timestamp.

A node whose parent belongs to an explicitly retired partition may become a valid retained root. A missing parent in a live partition remains corruption.

Retention duration does not need to be fixed when the session is created. It may be shortened later; it may be lengthened only for partitions that have not already been deleted.

## Open questions

### Branch segments across deleted partitions

The current `branch_nodes` / `branch_meta` chain can name a base segment in an older partition. It is not yet specified:

- whether each partition has independent branch projections;
- whether a retained segment may have a retired base;
- where the retired-boundary marker lives;
- how `scanBranch` distinguishes an expected retired base from corruption;
- whether partition deletion requires rebuilding retained branch metadata;
- how stale branches and branches shared by several lanes are represented after deletion.

This is the largest unresolved interaction with the current branch-chain design.

### Context-safe partition groups

The exact grouping rule is unresolved:

- assistant tool call plus results;
- one provider turn;
- one accepted run;
- another explicit context frame.

The rule must prevent retained context from starting with an orphan tool result or ending with an unresolved assistant tool call. Long-running operations must not prevent old partitions from sealing forever.

### Cross-partition parent semantics

Possible choices are:

1. retained nodes may point into retired partitions and traversal stops there;
2. create lightweight retention-boundary nodes;
3. rewrite crossing parents before deletion.

The first is cheapest but changes the current invariant that every parent exists.

### Physical SQLite partitioning

Logical `partition_id` rows in one SQLite file preserve easy atomic transactions but do not make deletion `O(1)`. Separate files make deletion cheap but require coordination between the hot slot store and node partition.

We need a crash-safe protocol for a transaction that both inserts a node into a partition and deletes/updates hot slots. Options include attached-database transactions, a small commit manifest, staging rows, or keeping an active writable partition together with the catalog.

### Partition sealing with live operations

If a run captures partition P and crosses a calendar boundary, either:

- P remains writable until the run finishes;
- the run's unsettled nodes remain staged in the hot store;
- context-group rows are copied/promoted when the group closes;
- the newer partition records a dependency that temporarily pins P.

The choice affects deletion latency and atomicity.

### Lane leaves, labels, and navigation targets

Current slots may name nodes in a partition selected for deletion. Policy must define whether to:

- expire/rebase the lane;
- pin its target partition;
- retain a lightweight boundary node;
- drop labels;
- return an explicit expired-target result for navigation/bookmarks.

### Compaction and copied old content

A newer compaction node may embed `retainedTail` messages from an older period, and summaries contain information derived from old history. Deleting old partitions therefore does not guarantee that all old information disappears. Retention policy must define whether copied and summarized content may outlive its source partition.

### Usage retention

Decide whether usage rows:

- share their node's partition;
- use independent calendar partitions;
- remain forever;
- collapse into aggregate adjustments when old partitions are removed.

Failed structural attempts have usage but no node, so node-only partition assignment is insufficient.

### JSONL physical cleanup

Current-slot semantics remove history logically, but JSONL keeps old bytes until rewrite. Decide when snapshot compaction runs and whether operation completion or retention requires immediate physical removal of sensitive payloads.

### Telemetry detail and privacy

If telemetry replaces durable history, define the sanitized mutation event contract. Slot namespaces and target IDs are usually safe; custom fact keys and slot payloads may not be. Durable audit, if required, belongs to the adapter rather than session storage.

### Pending-slot write amplification

A delayed payload is written once into `pending.node` and again into `nodes` at placement. This is more physical I/O than the old value/node split, though only one live copy remains and SQLite can move it with `INSERT ... SELECT`. We should measure whether this matters for unusually large queued payloads.
