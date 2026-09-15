# Pico5: durable documents and views

> Design direction, not a complete harness specification. This fixes the state,
> view, and storage foundation. Implement and validate it before tasks or policy.

## 1. Model

Pico has four durable primitives:

| primitive | purpose | storage semantics |
|---|---|---|
| entry | immutable transcript/history | append-only, paged |
| document | current JSON application/presentation state | Chord ops plus bases |
| task state | private recovery bookmark | complete replacement, retireable |
| memo | invocation idempotency receipt | small, first-writer-wins, retireable |

Facet and task authors mutate ordinary tracked JSON objects. They do not define
delta formats, repositories, checkpoints, or restart reconstruction.

Entries hold unbounded history. A document holds current state; it may be large,
but should not double as an unbounded event archive. Sessions and inactive
documents must be loadable and evictable independently.

## 2. Documents

A document has persisted metadata:

```ts
interface DocumentMetadata {
  id: DocumentId; // unique incarnation; never reused
  key: string;
  scope: "session" | { conversationId: Id };
  history: "latest" | "rewindable";
}
```

History policy is immutable and applies to the whole document:

- `latest`: only current state is observable; records before a committed base may
  be reclaimed.
- `rewindable`: state and document membership are queryable at a historical
  Session commit; history remains while forks may address it.

Creation records metadata and a mandatory initial base, including `{}`. Retirement
hides a document from current enumeration. A latest document may then be deleted.
A rewindable document remains historically enumerable, including if retired later.
Recreating a logical key creates a new ID/incarnation.

A Session facet may create its own Session or conversation documents, such as a
canvas or diff review.

## 3. Commits and task state

A Session has one serialized mutation line. One logical commit may atomically:

- create, mutate, or retire multiple documents;
- create, replace, or retire task state and memos;
- append entries.

Document mutation uses transaction-owned drafts. The document manager produces
Chord ops and the candidate current value. Storage commits everything or nothing.
Only after success does the manager adopt drafts and notify views/subscribers.
Failure leaves authoritative values and replicas unchanged.

> If a state change is visible through Chord, it has already committed durably.

There is no volatile `publish()`. Generation and tool progress use throttled durable
commits. A crash may lose the current throttle window, but never state a client saw.

Each task kind defines private JSON recovery state. Phase transitions replace it in
full. The runtime separately owns the task envelope: kind, input, conversation,
ownership/dependencies, memos, and outstanding effect identities. Bulk output lives
in a document, not task state. On reopen, generation and tool kinds convert persisted
partials into aborted/interrupted entries and clear their live presentation state.
The effect sandwich remains:

```text
durable intent -> external effect -> durable outcome
```

Before retirement removes an outcome needed by a waiter, the same commit transfers
it to that waiter, an entry, or another durable receipt. Post-commit publication,
cleanup, or listener failures cannot roll back persistence or suppress later
listeners; they are isolated and reported separately.

## 4. Conversation view

Pico initially owns three documents per conversation:

```text
pi.rewindable   history: rewindable; historical configuration
pi.sticky       history: latest; queues and long-lived present policy
pi.live         history: latest; high-churn turn, generation, tool and collapse state
```

Tasks write presentation state directly. Generation writes `live.message`; tools
write `live.tools`; historically inherited configuration lives in `rewindable`.
Private task state is not projected into view. Returning `live` to its initial state
may trigger a tiny base so streamed history can be reclaimed immediately.

The initial view is a fixed mount:

```ts
interface ConversationView<R, S, L> {
  conversation: ConversationInfo;
  entries: Entry[]; // bounded active transcript; older entries are paged
  rewindable: R;
  sticky: S;
  live: L;
}
```

The mount consumes a complete Session commit and emits one Chord update. It prefixes
document paths and combines them with entry changes:

```text
["s", ["model"], value]       -> ["s", ["rewindable", "model"], value]
["a", ["message"], delta]      -> ["a", ["live", "message"], delta]
["r", value]                   -> ["s", ["live"], value]
```

Thus appending a final entry and clearing its preview is one publication. This is a
structural mount, not semantic projection, and owns no second tracker.

Third-party documents are not mounted initially. Facets expose them through their
own Chord services. Generic plugin mounting is deferred.

Before view implementation, define a durable bounded active-transcript/head rule and
how it changes atomically with appends. A years-long conversation must not hydrate
its entire transcript.

## 5. Chord integration

`DurableDocument` belongs to the harness and need not implement `ReplicatedState`.
A small Chord adapter, provisionally `replicatedState.own(source)`, exposes a durable
document as read-only replicated state without another tracker or re-diff.

The source provides its immutable committed value, a contiguous revision, and
committed ops. Session commit sequence is not a Chord sequence: unrelated commits
create gaps. Each document source and each conversation mount therefore has its own
contiguous publication revision.

Hydration must atomically capture matching value/revision and subscribe without a
gap or duplicate. The durable source's internal `publish()` is a no-op because no
visible mutation is pending. Test reentrant subscriptions and isolate listener
failures after persistence. The ConversationView mount consumes Session commits
directly, not independent document notifications.

A facet can expose a typed durable application document directly. `CanvasDoc` is
the declaration token, `canvasDocument` is the committed source, and `tx.doc(...)`
is a transaction-local draft:

```ts
const CanvasDoc = defineDoc<CanvasState>({
  id: "@app/canvas", scope: "session", history: "latest",
  initial: () => ({ strokes: [] }),
});

const canvasDocument = session.document(CanvasDoc);
const state = replicatedState.own(canvasDocument);

async function addStroke(stroke: Stroke, context: Context) {
  await session.commit(tx => tx.doc(CanvasDoc).strokes.push(stroke), context);
}
```

## 6. Forks

Every Session commit has a global sequence; each entry records its containing commit.
Forking at entry `E`:

1. validates `E` through every ancestor cutoff;
2. enumerates rewindable documents existing at `E`'s commit, including ones retired
   later;
3. loads each from the newest base at or before that commit plus later deltas;
4. creates a child-owned document ID and initial base for each;
5. copies no live task state.

A later state-only commit is excluded. Child documents then evolve independently.
Sticky/live documents have no historical lookup. Their simplest initial fork rule is
fresh defaults, never copied queues or running previews.

Before the fork API ships, decide whether selecting one of several entries appended
in the same commit inherits only that entry prefix or treats the commit as an
indivisible transcript boundary. Document state is the final state of the containing
commit either way.

## 7. Storage contract and bases

Storage receives logical metadata and writes, never filenames or table instructions:

```ts
type DocumentWrite =
  | { type: "create"; metadata: DocumentMetadata; value: JsonValue }
  | { type: "change"; id: DocumentId; ops: readonly Op[]; value: JsonValue }
  | { type: "retire"; id: DocumentId };
```

For a change, `value` is a borrowed candidate snapshot. Storage normally persists
`ops`, but may persist a complete base when tail bytes or record count exceed its
policy:

```ts
persist(shouldBase(id, ops) ? [["r", value]] : ops);
```

It serializes only the chosen representation. Chord still publishes the incremental
ops. A committed base permits reclaiming older latest records; rewindable bases bound
replay but do not authorize deleting addressable history.

Storage supports current and as-of document enumeration/value lookup and distinguishes
not-yet-created, live, retired, and unavailable history.

## 8. Backends

### SQLite

One SQL transaction is one Session commit. Store immutable entries with commit
sequence, document metadata, indexed base/delta records by document and commit, and
one complete JSON row per live task. Current/as-of loads select the newest applicable
base and an indexed tail; they never scan unrelated documents. Retiring a task deletes
its row. Retired rewindable document history remains queryable.

Initially store Chord ops/bases directly. Benchmarks found full JSONB replacement
10-18% slower than TEXT and SQL JSON patching 2-4x more CPU with more DB+WAL writes
for a large canvas. SQLite also cannot faithfully map generic middle-array splices or
Chord's UTF-16 truncation. WAL checkpoint, synchronous mode, migrations, backup, and
vacuum are backend concerns.

### JSONL

JSONL prioritizes reclaimable task and latest-document storage. It privately chooses
sidecars; the harness does not know they exist:

```text
main.jsonl                 entries, lifecycle records, coordinated commits
task-<id>.jsonl            live task state
doc-<id>.jsonl             independently loadable document records
```

Every sidecar record is prepared. A commit appends all affected sidecars first and
one compact main marker listing their references last. Main-only commits are their
own marker. This uniform protocol intentionally accepts one small main record for an
isolated task/document update instead of introducing standalone and coordinated
record modes.

Recovery applies only records confirmed by a main marker. It removes torn and
unconfirmed tails before reopening for writes. Uncommitted sequences may be reused
only after all records carrying them are removed; committed sequences and document
IDs are never reused. Missing confirmed data is corruption unless a later committed
base or retirement proves it unnecessary.

An uncertain append error poisons the backend until close/reopen recovery. Appends
loop through the complete newline. After a main marker is complete, cleanup failure
cannot roll back the commit. Reclamation runs only after its base/retirement commits,
using serialized temp-file replacement and rename, then invalidates/reopens any
cached descriptor so later appends target the replacement inode.

Without per-commit `fsync`, ordered writes target ordinary process-crash consistency;
power/host/filesystem failure may lose or reorder acknowledged commits. Durable mode
flushes sidecars before the main marker. File descriptors are bounded by per-write
open or an LRU.

## 9. Deferred

Do not initially add per-subtree history, volatile publication, a public semantic
event channel, generic plugin mounting, SQL JSON patch translation, CRDT/offline
writes, whole-Session DOM materialization, arbitrary atomic presentation across
third-party services, sticky copy options, history-policy changes/pruning, or pico3's
config/plugin projections. UI status is durable document state; if transient history
is needed, add a bounded field to `live` with explicit retention.

## 10. Implementation order

1. **Storage semantics: memory + SQLite.** Create two initial-base documents;
   atomically change both, replace a task, and append an entry; force latest and
   rewindable bases; test current/as-of membership and values, retirement/recreation,
   entry-to-commit mapping, reopen, and rollback.
2. **JSONL.** Implement uniform sidecar preparation/main-marker publication,
   poisoned writes, committed-only reclamation, and fault injection at every physical
   boundary.
3. **Document manager + narrow Chord proof.** Prove draft rollback without
   per-success full cloning, one tracker per loaded doc, eviction/forks, contiguous
   revisions, hydration fencing, listener isolation, and `watchDoc` snapshot/update/
   retirement behavior.
4. **Tasks.** Add runtime envelopes, full-replacement kind state, phases, memos,
   effect sandwich, dependency handoff, abort, retirement, durable built-in progress,
   and reopen conversion of persisted partials.
5. **Conversation view.** First settle active-transcript and multi-entry fork
   boundaries; then mount rewindable, sticky, and live with one publication per
   Session commit.
6. **The rest.** Inputs, hooks, tools, system sections, dynamic tools, notices if
   required, and product wiring.

Storage is accepted before task implementation. All backends share one semantic
conformance suite; JSONL additionally has a physical crash/failure matrix.
