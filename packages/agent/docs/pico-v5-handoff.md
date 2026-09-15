# Pico5 handoff and decision register

> Working coordination document. `pico-v5.md` is the compact design. This file
> records accepted choices, unresolved decisions, examples, and layer sign-offs so
> work survives conversation compaction. No unresolved item may be decided silently
> during implementation.

## Current status

- `packages/agent/src/harness/pico/` and its tests were removed.
- The untracked `pico4` source/tests were removed.
- `pico3` remains as a reference, not an implementation base.
- Storage benchmark artifacts are in `/tmp/pi-pico5-storage-bench/`.
- Astra approved starting the memory + SQLite storage/conformance slice after the
  storage decisions below are signed off.

## Accepted direction

1. Entries are immutable and paged; the Session is not one materialized DOM.
2. Authors mutate ordinary JSON documents; Chord produces nested/list/string ops.
3. History policy is per document: `latest` or `rewindable`.
4. Built-ins use three conversation documents:
   - `rewindable`: historical configuration;
   - `sticky`: present state such as queues and retry policy;
   - `live`: high-churn turn, generation, tool, and compaction presentation state.
5. Typed document definitions and dynamic families are required. Family instances
   may be task-owned and retire automatically.
6. Task recovery state is a complete replacement, separate from presentation and
   application documents.
7. There is no visible-but-undurable publication. Every Chord-visible update follows
   a successful durable commit.
8. Interrupted assistant/tool partials are converted into durable aborted/interrupted
   entries by their recovering task kind, then removed from `live`.
9. A built-in needs cross-task document observation, so `watchDoc` is initial scope.
10. UI status is state, not an event protocol. There is no public event channel
    initially; clients observe document paths. A bounded `live` notice field may be
    designed with the built-in view if concrete transient facts require it.
11. Third-party documents initially use their own Chord services. Automatic mounting
    into the agent view is deferred.
12. SQLite is the long-running/cloud backend. JSONL remains local and readable.
13. Implementation proceeds layer by layer and stops for user sign-off after each.

## Decisions required before storage implementation

### S1. Document identity and families — accepted

A definition carries type, logical ID, scope, history, initializer, and optional
family ownership rules:

```ts
const live = defineDoc<LiveState>({
  id: "pi.live",
  scope: "conversation",
  history: "latest",
  initial: () => ({ tools: [] }),
});

const jobOutput = defineDocFamily<JobState, JobInput>({
  id: "pi.job",
  scope: "conversation",
  history: "latest",
  owner: "task",
  initial: input => ({ command: input.command, stdout: "" }),
});
```

A persisted instance has a unique, never-reused storage identity plus definition ID,
scope owner, family instance ID, creation sequence, history policy, and retirement
sequence. Reusing one logical family key creates a new incarnation.

### S2. Historical document membership — accepted

A rewindable document retired today still exists in an as-of query from yesterday.
A latest document can be deleted after retirement.

Example:

```text
10 create rewindable review A
20 append entry E
30 retire A
40 fork at E
```

The fork enumerates A at commit 20 and copies its as-of value into a new child-owned
instance. Current enumeration at commit 40 omits A.

### S3. Storage ownership and copying — proposed recommendation

Simplest safe contract:

- Commit inputs are borrowed until `Storage.commit()` settles.
- A backend retaining anything after settlement detaches it first.
- Memory uses a small recursive `copyJson`; JSONL/SQLite detach through serialization.
- Every storage read returns a fresh owned JSON copy. Mutating it cannot corrupt the
  backend or another caller. Public types remain readonly, but correctness does not
  rely on TypeScript at runtime.
- Large strings are immutable and may share their string value during an in-memory
  copy; object/array containers never share mutably.

Example failure this prevents:

```ts
const task = { phase: "running" };
await storage.commit([{ type: "task", task }]);
task.phase = "done"; // must not mutate MemoryStorage behind its back
```

Decision: approve this contract, or replace it with explicit ownership transfer and
state which caller may still use document ops for Chord publication.

### S4. Table reads and writes inside `Tx` — proposed recommendation

Adopt the other design's simple rule:

```text
table reads first -> first table write -> later table reads throw ReadAfterWrite
document reads/mutations always read their transaction draft
```

Example:

```ts
const inputs = await tx.inputs(ids);          // read
const head = await tx.newestEntry(c);         // read
const entry = tx.appendEntry(c, assistant);   // first table write
tx.doc(live, c).message = undefined;          // document draft is allowed
// await tx.entry(other) now throws ReadAfterWrite
```

Benefit: no shadow indexes for newly created entries/tasks/inputs. Cost: helpers must
load everything before their first table write. Validate all built-in settlement
traces before accepting.

Decision: adopt this rule, or support read-your-writes for tables and pay for overlays.

### S5. Escaped document draft — open

A callback can retain a document proxy:

```ts
let escaped: LiveState;
await session.commit(tx => { escaped = tx.doc(live, c); });
escaped.message = partial;
```

Options:

- **Detached stale draft:** mutation succeeds locally but has no effect. Simplest,
  but silently hides a bug.
- **Revoked draft:** every later read/write throws. Clearest, but requires tracker
  proxies to share an active guard or another membrane.
- **Debug assertion:** stale mutation is detected at the next transaction. Cheaper,
  but delayed.

Recommendation: first determine whether Chord tracker proxies can cheaply share one
revocation guard. Do not let an escaped proxy mutate committed state or contaminate a
later commit.

### S6. Base policy — partly accepted

Every document may receive bases. Storage gets both incremental ops and a borrowed
candidate value, serializing only one:

```ts
persist(shouldBase(id, ops) ? [["r", value]] : ops);
```

- `latest`: a committed base permits reclaiming older records.
- `rewindable`: bases bound as-of replay; historical segments remain.
- Trigger on both encoded bytes and record count.

Open values:

- byte threshold;
- record-count threshold;
- whether document definitions may request `rebaseWhenInitial`.

`pi.live` benefits from `rebaseWhenInitial`: when a turn ends at `{ tools: [] }`, a
tiny base allows immediate reclamation of streamed output. The definition/document
manager can recognize its initial state; storage still owns physical reclamation.

### S7. Task rows — accepted

Task records are full replacements. SQLite uses one live row and `DELETE` on terminal.
JSONL uses one task sidecar and unlinks it only after terminal publication.

The runtime envelope owns kind/input/dependencies/memos/effect IDs. Kind-defined
recovery state cannot overwrite memos. A terminal transaction transfers any needed
outcome and retires every task-owned document family instance atomically.

This atomic retirement removes the need for an application-level orphan sweep:

- crash before terminal: task and owned docs remain live and recover;
- crash after terminal marker: logical retirement is known, and storage may clean
  leftover files during open.

### S8. SQLite representation — accepted direction

Use one SQL transaction per Session commit:

```text
conversations / entries / inputs
document metadata
document base+delta records indexed by document and commit
a current live-task row
```

Do not translate Chord ops into SQLite JSON functions initially. The benchmark found
full JSONB replacement slower than TEXT and generic SQL patching slower with more WAL
writes. Current/as-of reads select a base and indexed tail; they do not scan unrelated
documents.

Still choose schema details, WAL checkpoint cadence, and `synchronous` default during
the SQLite layer.

### S9. JSONL physical layout — current lean: uniform sidecars

Simplest layout from the other design:

```text
main.jsonl                  tables + one publication marker per commit
doc-<storage-id>.jsonl      one file per document instance
task-<storage-id>.jsonl     one file per live task
```

Every sidecar record is prepared. Sidecars append first; one main marker is always
last. This deliberately permits records such as:

```json
{"seq":14,"refs":["task-9"]}
{"seq":15,"refs":["task-9"]}
{"seq":16,"refs":["pi.live-1"]}
```

The markers are cosmetic overhead but make every commit use one protocol. They can be
compact; fields such as `writes:[]` and repeated `maxId` are unnecessary if high-water
is represented elsewhere. Without `fsync`, the second append is unlikely to be the
performance bottleneck; the benchmark's no-fsync sidecar backend still handled about
9.5k–30k commits/s depending on workload while opening/closing each sidecar.

Alternative: standalone one-file commits avoid markers but introduce two record modes,
distributed commit discovery, and more recovery cases.

Decision: approve uniform marker publication or select the standalone optimization.

### S10. JSONL process-crash contract — accepted direction

No `fsync` by default. Awaited/full sidecar writes precede the awaited/full main
marker. For an ordinary process crash with the OS/filesystem alive:

- torn final lines are removed;
- sidecar records without a marker are uncommitted and removed;
- a complete marker publishes the transaction.

Power loss, host/kernel failure, or weak filesystem ordering may lose acknowledged
commits. Optional durable mode may fsync sidecars before the marker.

Any uncertain write error poisons the open backend until reopen. Reclamation occurs
only after its base/retirement commits and uses temp + rename; cached descriptors are
then reopened.

### S11. Missing confirmed sidecar — open

Example:

```text
sidecar record 20 was reported written
main marker 20 survives
sidecar record 20 is absent after machine failure
```

This should not arise from the stated ordinary process-crash contract. Options:

- **Fail open:** report corruption and preserve all bytes for diagnosis/repair.
  Simplest and never invents state.
- **Roll back globally:** truncate every file to the latest complete global prefix.
  Recovers availability but may discard acknowledged later commits and must interact
  correctly with reclaimed prefixes and standalone records if those exist.
- **Best-effort skip:** invalid because it exposes a partial atomic commit.

Recommendation: fail open initially. Add a separate repair tool only after physical
fault tests establish a safe prefix algorithm.

### S12. Main JSONL growth — accepted limitation

Document/task sidecars reclaim high-churn data; `main.jsonl` still grows by entries,
lifecycle records, and commit markers. JSONL may scan it on open. It is the local
backend. Years-long products use SQLite. Do not add global JSONL compaction initially.

### S13. Storage query surface — needs exact signatures

The first storage contract must support:

- create/current/retired conversation records;
- paged immutable entries and entry -> commit mapping;
- current task lookup/scan;
- current and as-of document enumeration;
- current and as-of document value;
- family-instance enumeration by definition/scope/owner;
- one atomic mixed commit;
- close/reopen.

As-of results distinguish not-yet-created, retired after target, and unavailable
history. Concrete TypeScript signatures are the first layer's first sign-off.

## Decisions required before document/task implementation

### D1. Three built-in documents — accepted

```ts
rewindable // model/tool/config choices inherited by historical fork
sticky     // inbox, queue modes, retry policy
live       // current message/tools/generation/collapse and maybe notices
```

`live` is durable because recovery converts its partial output into transcript entries.
Its high churn is independently reclaimable when it returns to initial state.

### D2. Document adapter to Chord — accepted direction

A thin adapter such as `replicatedState.own(documentSource)` exposes committed value
and ops. It owns no second tracker. Each document and mounted view has a contiguous
publication revision separate from sparse global Session commit sequence.

Hydration captures value/revision and subscribes atomically. Listener errors after
persistence are isolated. Current Chord needs a small public source adapter; it does
not need harness knowledge.

### D3. Cross-task `watchDoc` — accepted, exact scope open

Required semantics:

```ts
const watch = await api.watchDoc(jobOutput, job.id, context);
consume(watch.value); // snapshot first
watch.start((ops, value) => consume(value));
```

- capture + subscription are one Session-line operation;
- callbacks run off the line and cannot re-enter a commit synchronously;
- watch is volatile and invocation-owned;
- recovery re-enters the handler, captures a fresh snapshot, and subscribes again;
- retirement appears as document absence;
- `stop()` is idempotent.

Open scope: same conversation only, or any conversation owned by the observing task's
subtree. Initial built-in use must provide the concrete required edge.

### D4. Reopen conversion — accepted

Generation recovery reads `live.message`, appends an assistant entry with
`stopReason: "aborted"`, clears the preview, and retries/fails atomically. Tool
recovery turns persisted output into its interrupted result before clearing the slot.
The entry uses the normal model/render shape while model projection excludes aborted
content.

Conversion runs before retiring any task-owned family document it needs.

### D5. Document versioning/migration — open

Document paths and persisted values are public/durable schema. A plugin upgrade may
change `{ comments: [...] }` to `{ threads: [...] }`.

Options:

- definition has an integer version and migration from complete current value;
- task/document kind owns migration during open;
- reject mismatched versions initially.

Recommendation: persist definition version now even if initial implementation only
rejects mismatches. Retrofitting identity/version after stored products ship is harder.

## Decisions required before view implementation

### V1. Public view shape — open

Fixed top-level fields:

```ts
{ conversation, entries, rewindable, sticky, live }
```

Typed and direct, but every added built-in document changes the protocol.

Document map:

```ts
{
  conversation,
  entries,
  docs: {
    "pi.rewindable": RewindableState,
    "pi.sticky": StickyState,
    "pi.live": LiveState,
  },
}
```

Makes document identity/lifetime explicit and can add selected documents later, but
paths and IDs become public protocol. It can remain typed for the three built-ins.

Recommendation: decide before writing any UI adapter. In either shape, mount only the
three built-ins initially and treat every visible path as versioned public API.

### V2. Public events — accepted: none initially

A compaction-start event cannot describe current state to a late joiner. Instead:

```ts
live.collapse = { through, stage: "summarizing" }; // running
live.collapse = undefined;                         // finished
```

Clients react to state ops by path and always hydrate the current truth. Hooks remain
pre-decision interception. Internal commit subscribers may exist mechanically, but
there is no separate public semantic event protocol initially.

Whether failed attempts need a bounded `live.notices` list is deferred until the UI
is implemented. It remains state with explicit retention, not fire-and-forget events.

### V3. Atomic publication — accepted

The built-in mount consumes the complete Session commit, prefixes every changed
built-in document path, combines entry changes, and publishes one Chord batch. It has
no tracker or semantic projection. Independent third-party Chord services may publish
separately.

### V4. Active transcript bound — open

A Slack conversation cannot hydrate every entry ever written. Options include:

- durable `head` entry: active transcript is the range beginning at its target;
- fixed recent entry/count/byte window;
- product-selected window with a stable cursor.

Example requirement:

```text
10 years / 500,000 entries
late UI attach -> bounded snapshot
older history  -> explicit paged query
model context  -> independently derived bounded projection
```

Choose before view implementation, not before storage. Entry paging and indexes are
required now regardless.

### V5. Multi-entry fork boundary — open

One commit may append entries E and F and leave one final rewindable state. Fork at E:

- **entry prefix:** child transcript includes E but not F, while document state is the
  final state of the containing commit;
- **commit boundary:** selecting E means inherit all entries from its indivisible
  commit, including F;
- **restriction:** only designated forkable entries/commits may be targets.

Choose before fork/view API. Storage records entry -> commit either way.

### V6. Sticky fork initialization — current lean: defaults

A historical fork inherits rewindable documents as-of its target and no live tasks.
Copying current sticky/live state can copy queued inputs or running previews from the
future. Simplest initial rule:

```text
rewindable -> historical copy
sticky     -> fresh defaults
live       -> fresh defaults
```

Explicit sticky-copy options remain deferred.

### V7. Third-party mounting — accepted defer

Third-party documents initially expose application-specific Chord services. Do not add
`inView`, privacy flags, dynamic mount registries, or client-selected arbitrary docs.
A document is not a security boundary; services deliberately choose what crosses a
process boundary.

## Layer plan and sign-off gates

### Layer 0 — cleanup

- Remove `pico` source/tests: done.
- Remove `pico4` source/tests: done.
- Keep `pico3`: done.
- Run repository check after deletions and document additions: pending.

### Layer 1 — logical storage + memory reference

Before code: sign off S3 and S6, retain accepted S1/S2/S7, and approve the exact S13 interfaces.

Acceptance:

- atomic mixed commits;
- document creation, bases, current/as-of membership and values;
- family instances and task ownership;
- full task replacement/retirement;
- entry paging and entry -> commit;
- ownership isolation and failure rollback.

Stop for user review.

### Layer 2 — SQLite

Before code: approve concrete schema and durability defaults.

Acceptance: Layer 1 conformance plus reopen, indexed query plans, latest reclamation,
retired rewindable history, WAL checkpoint behavior, and realistic storage benchmark.

Stop for user review.

### Layer 3 — JSONL

Before code: decide S9 and S11.

Acceptance: semantic conformance plus physical fault injection at every sidecar,
marker, rewrite, rename, retirement, and reopen boundary.

Stop for user review.

### Layer 4 — document manager + Chord source

Before code: decide S4, S5, D3 scope, and D5.

Acceptance: ordinary mutations, no duplicate tracker, failed-commit rollback,
contiguous publication, hydration fencing, listener isolation, eviction, and
`watchDoc` snapshot/update/retirement behavior.

Stop for user review.

### Layer 5 — tasks

Acceptance: phase-narrowed full replacements, effect sandwich, runtime-owned memos,
abortable ownership tree, atomic family retirement/outcome handoff, generation/tool
reopen conversion, and no visible-undurable state.

Stop for user review.

### Layer 6 — built-in documents and conversation view

Before code: decide V1, V4, V5, and V6.

Acceptance: direct built-in writes, fixed structural mount, one publication per commit,
bounded late hydration, crash-visible progress, and no public event dependency.

Stop for user review.

### Layer 7 — remaining harness

Inputs, hooks, tools, system sections, dynamic tools, deferred providers, and product
wiring. Preserve accepted APIs from earlier design work rather than redesigning them
inside the state implementation.
