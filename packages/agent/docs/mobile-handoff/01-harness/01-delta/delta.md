# Delta Tracking and the Op Vocabulary

> **Scope:** `packages/agent/src/harness/delta/`. It depends on nothing else in the
> harness — not on session storage, the runtime, or facets — and those three
> consume it. Keep that direction: a delta module that imports from `session/` or
> `runtime/` cannot later be extracted, and extracting it is the point of the
> boundary.
>
> It lives inside `packages/agent` rather than as its own package because it has
> exactly one consumer today. Split it out when a second one appears — the facet
> host is the likely trigger, since a replica in another process needs the applier
> without the harness.
>
> Nothing existing in `origin/dev` is modified by this unit alone.

One mechanism covers assistant partials, tool output, tool details, lane state,
and arbitrary facet state — on the wire and in durable storage.

**Shipped alongside this doc**, all four verified:

| file | lands as |
| --- | --- |
| `delta.ts` | `harness/delta/types.ts` — the API surface as it should be exported |
| `delta-impl.ts` | `harness/delta/index.ts` — tracker, applier, codec, safety guards |
| `delta.test.ts` | `test/harness/delta.test.ts` — 42 tests. Port these first. |
| `delta.bench.ts` | `test/harness/delta.bench.ts` — guards two performance cliffs |
| `delta.examples.ts` | not shipped — runnable illustrations of §3.2.1 and §3.2.2 |

Re-export from `harness/session/index.ts` is **not** wanted: session storage is a
consumer of this vocabulary, not its owner.

`packages/agent` already has an `exports` map with subpaths (`.`, `./node`, …).
Give delta one too, so the boundary is visible from outside the package and a
later extraction is a one-line change rather than a search for importers:

```jsonc
"./delta": {
  "types":  "./dist/harness/delta/index.d.ts",
  "import": "./dist/harness/delta/index.js"
}
```

Consumers inside the harness import relatively; anything outside it imports
`@draht/agent/delta`. If the second form starts appearing inside
`packages/agent`, the module has outgrown its home — see the scope note above.

```bash
npx vitest run delta.test.ts                        # 54 passing
npx vitest bench delta.bench.ts
node --experimental-strip-types delta.examples.ts   # the two sharp edges, printed
```

Both import `./delta-impl.ts` directly and need no harness. `delta.ts` and
`delta-impl.ts` are verified mutually assignable, so the declared API is
satisfiable by the implementation rather than merely adjacent to it.

## 1. Why not an existing library

Immer, Valtio, Mutative and Colyseus all **record effects, not intent**. A string
is a leaf, so `text += chunk` is one write of the whole new string; there is no
representation in which the library could know you appended. `unshift` is the
same story — the engine shifts every index, so each is a write.

Measured, all four:

| operation | what they emit |
| --- | --- |
| `text += "x"` on 40 KB | `replace` carrying 40 KB |
| `arr.unshift(x)` on 100 items | ~100 index writes |
| `arr.pop()` | a write to a `length` path, which is not a document location |

Immer's own pitfalls page states the guarantee: patches are correct and
**explicitly not minimal**. Colyseus documents the same array weakness — removing
the first of 20 items costs 38 extra bytes.

Diffing base against result ourselves does not fix it either. A differ sees two
values, not intent. Prefix comparison catches pure growth, but a rolling window
that drops from the front *and* appends is neither a prefix nor a suffix of the
old value; measured on 5000 elements the fallback was
`{index: 0, remove: 5000, items: 5000}` — a full replace, in exactly the case the
optimisation existed for.

So the win is not a better differ. It is **not diffing at all**.

## 2. Ops

**Tuples are the form. Everywhere. There is no keyed variant.**

```ts
export type Seg = string | number;
export type Path = readonly Seg[];
/** Non-empty: `s`/`d`/`a`/`t` cannot target the root. Enforced by the type. */
export type NonEmptyPath = readonly [Seg, ...Seg[]];

export type Op =
  | readonly ["r", JsonValue]                            // replace the value
  | readonly ["s", NonEmptyPath, JsonValue]              // set
  | readonly ["d", NonEmptyPath]                         // delete
  | readonly ["a", NonEmptyPath, string]                 // append
  | readonly ["t", NonEmptyPath, number]                 // truncate, in chars
  | readonly ["p", Path, number, number, JsonValue[]]    // splice: index, remove, items
```

Interning, id references and omitted paths are **not** here — they live in
`WireOp` and exist only between `encode` and `decode` (§4).

**`r` is the only op that replaces a whole value.** It is an op rather than a
frame kind for the same reason `a` and `t` exist: they are specialisations of `s`
that are smaller and state intent.

Do not encode a replacement as a set at the root path. Base-batch detection is a
**correctness boundary** — recovery stops there (§9) — so it must be a token
comparison, `ops[0]?.[0] === "r"`, and not a path inspection. A path-inspecting
predicate has to handle the two-element arity form, where `op[1]` is a value
rather than a path, and misclassifies `["s", []]`.

**Only `p` may target the root**, and only because a tracked value can itself be
an array — `entries.push(x)` on a root array is `["p", [], 3, 0, [x]]`. A `p`
covering its entire target is normalised at record time to `r` (root) or `s`
(nested), so a root `p` is always a partial modification. The other four verbs
take a `NonEmptyPath`: `["s", [], v]` and `["d", []]` do not typecheck.

**Do not add a keyed in-memory shape with a codec at the serialization boundary.**
Two representations of one thing means two appliers, two size estimates, and a
conversion nobody needs. Ops are tuples in memory, on the wire, and on disk;
readability is what a debug formatter is for.

Five verbs. No `move`, `copy` or `test`: the first two are size optimisations for
a case we do not have, and `test` belongs to a conflict model we do not have,
since there is exactly one authoritative writer.

`chars` counts UTF-16 code units, matching `String.prototype.slice`. **Not bytes.**
Byte caps are a producer concern and never cross a boundary.

The format is JSON-Patch-*shaped*, not RFC 6902 conformant. That costs nothing:
RFC 6902 has had no successor since 2013, still has the same six ops, and nothing
anywhere adds a string splice. Immer was never conformant either.

## 3. The tracker

State is **plain TypeScript**. No containers, no handles, no schema, no
decorators. You mutate normally.

```ts
const t = track(laneView);
t.state.operation.streaming.content[0].text += delta;   // -> append
t.state.transcript.push(entry);                         // -> splice
t.state.tools[0].details.failures.push({ name, msg });  // -> splice
delete t.state.config.model;                            // -> delete
const ops = t.flush();
```

Three mechanisms, one per case:

**Objects** — ordinary `set` / `deleteProperty` traps.

**Arrays — mutator methods intercepted in the `get` trap.** `arr.push(x)` passes
through `get(arr, "push")` first, so the tracker returns its own function that
records `splice(len, 0, [x])` and then delegates. Intent is captured *before* the
engine performs its index writes, which is why `unshift` is one op rather than
O(n). This is the thing no other library does.

**Strings — overlap detection on the `set` trap.** Strings are primitives, so
there is nothing to intercept. Given `prev` and `next`, find the longest suffix of
`prev` that is a prefix of `next`:

```
overlap === prev.length  ->  append(next.slice(overlap))
overlap > 0              ->  truncate(prev.length - overlap) + append(rest)
overlap === 0            ->  set(next)
```

Always correct, because the overlap is **verified**, not guessed. The rolling
window works:

```ts
s.out = s.out.slice(4) + "!!!";
// ["truncate", ["out"], 4]
// ["append",   ["out"], "!!!"]
```

### 3.1 Overlap must not use a hand-written KMP

A KMP failure function is asymptotically right and **47x slower in practice**,
because it runs character by character in JS. Measured on 2000 window slides over
a 50 KB string: 2870 ms for KMP, 61 ms for a native probe.

The probe: `indexOf` a short head of `next` within `prev`, verify each candidate
with `endsWith`. Both are native. Verified identical to KMP across 200 window
slides.

A `startsWith` fast path runs first, so a pure append — the dominant case — skips
the probe entirely.

### 3.2 Rules the implementation must hold

**Op payloads are structured-cloned at record time.** Without this a later
mutation retroactively changes an already-emitted op, and a local replay aliases
the source object. This was an observed bug in the prototype, not a hypothetical:
producer and replica ended up sharing an object and double-appending.

**`x = undefined` normalises to `delete`.** JSON has no `undefined`, and a `set`
with a missing value is indistinguishable from a lost value after a
`JSON.stringify` round trip.

**`arr.length = n` is translated, never emitted as a path.** Shrink becomes a
splice, grow becomes a splice of nulls. `length` is a real mutation but not a
document location — this is the bug Immer ships (issue 208). Dropping it silently,
as an early prototype did, means `arr.length = 0` never reaches the replica.

**Numeric array keys are normalised to numbers.** Proxy traps deliver `"0"`;
paths carry `0`. Valtio ships the string form and it is worse for both size and
comparison.

**Proxies are cached per object and path**, so `s.a === s.a` and proxies are not
rebuilt on every access.

**Scope is `JsonValue` only, and it must be CHECKED, not assumed.**
`structuredClone` is not a JSON check — it clones `Map`, `Set`, `Date` and
`RegExp` happily, and the result then differs from what `JSON.stringify` produces,
so producer and replica diverge silently. Assert the value at record time and
reject symbol keys. See §7.4 for what leaks without it.

**Exactly two ops reach the root**, and the applier's root branch must handle
both: `r` always, and `p` when the tracked value is itself an array.
`s`/`d`/`a`/`t` cannot, by type, which makes the branch's fallthrough provably
unreachable. Handling only `r` there passes every hand-written test and fails on
the first randomised sequence that produces a root splice.

**Two writes to one address inside a transaction chain.** When several writes to
the same address are emitted in one commit, each must be recorded against the
previous one's result, not against pre-transaction state. The applier replays them
in order; anything else applies the second against a stale base. This did not fire
in the workload that surfaced it — it would have corrupted silently when it did.

### 3.2.1 Replacing the whole value

Assigning to `state` replaces it:

```ts
tracker.state = next;    // emits ["r", next]; discards ops recorded before it
```

`state` **must be a setter on the tracker**, not a plain property. Without one,
`tracker.state = next` swaps the proxy for a plain object and every later
mutation is silently untracked — no error, no ops, `target` unchanged. It is also
the first thing anyone tries.

Prior ops are discarded because they describe a value that no longer exists.

Only a *full* replacement collapses to `r`. Rewrite part of the value and the ops
survive, because they are genuinely cheaper:

```
partial rewrite        2 op(s), base=false
    ["s",["user"],{"id":"u2","name":"bob"}]
    ["s",["items"],["x"]]
```

### 3.2.2 The first flush is a base batch

`track()` opens a stream, and a consumer starts with nothing, so the first flush
always emits `["r", value]` — carrying any mutations made before it:

```ts
const t = track({ x: 0, l: [] });
t.state.x = 100;
t.state.l.push("xyz");
t.flush();      // [["r", { x: 100, l: ["xyz"] }]]
t.state.x = 101;
t.flush();      // [["s", ["x"], 101]]
```

Requiring the producer to remember a `rebase()` first would fail at runtime, in
the consumer, far from the mistake.

### 3.2.3 Forcing a base batch later

```ts
tracker.rebase();        // next flush is ["r", value]; value unchanged
```

Discarding the pending ops is correct: the proxy mutates the target directly, so
the value already carries them. `tracker.state = tracker.target` has the same
effect, but re-wraps the proxy needlessly and reads like a mistake.

**Nothing produces a base batch on its own.** `flush()` emits ops; a replacement
happens only when the producer asks for one. So a stream of appends stays a
stream of deltas indefinitely.

Recovery replays from the last base batch (§9). From `delta.examples.ts`, a
bash-shaped workload of 500 durable writes into a 50 KB rolling window:

| | batches written | to replay on recovery |
| --- | --- | --- |
| never | 500 | **499** |
| `rebase()` every 50 | 500 | 0 |

Two callers need this:

- **A durable sink.** `pendingToolOutput` accumulates one batch per checkpoint for
  as long as a command runs. A `make -j8` running for ten minutes otherwise leaves
  hundreds of batches to fold on resume. Checkpointing every N makes "at most N
  batches to replay" a policy rather than an accident.
- **A facet host on resubscribe.** `facets.md` §9.2 requires the first batch of
  every subscription to be a base batch, and a consumer that sees a gap
  resubscribes to get one. The host has to be able to produce one on demand rather
  than wait for one to happen by chance.

### 3.3 Known gaps

- `sort` / `reverse` / `fill` / `copyWithin` fall back to a whole-array `set`.
  Rare on replicated state; revisit if a real workload needs them.
- A manual index-shift loop (`for (…) a[i] = a[i+1]`) costs O(n) sets. Correct,
  not minimal, and unavoidable — you genuinely did write every element.
- Cross-realm identity. The interning table in §7 keys by id within one process;
  a replica in another process or language needs the same table built from the
  wire, which is not specified here.

### 3.4 Constraints the string algorithm must hold

Each of these is cheap to get wrong in a way that passes hand-written tests.

**A fixed-length probe cannot find an overlap shorter than the probe.** The head
must actually occur in `a`: `"abcdefgh"` -> `"defghxyz"` overlaps by 5, and a
64-character head cannot occur in an 8-character string. Try a long head first,
then fall back to a one-character head. A test using only 50 KB strings, where
overlaps are huge, will pass against a broken implementation.

**Bound the candidate scan.** Repetitive output — a build log, or a run of one
character — makes a long head match at thousands of positions, each costing a full
`endsWith`. Unbounded, 2000 slides over a 50 KB window take 4.7 s against 93 ms
bounded. Exceeding the bound returns 0, which emits a set: larger, never wrong.

**Property tests before anything depends on this.** 3000 random mutation
round-trips find the root-splice hole in §3.2 on the first run; the hand-written
cases do not. `delta.test.ts` is the suite to port.

## 4. The codec

Two vocabularies, not one.

`Op` is what the tracker produces and `apply` consumes. **Paths are always
inline.** It knows nothing about a dictionary.

`WireOp` is what crosses a boundary. It adds exactly two compressions:

```
["#", id, path]     defines an id, emitted on a path's SECOND use
a numeric PathRef   references a previously defined id
a shortened tuple   reuses the previous op's path; arity disambiguates
```

`encode(ops): WireOp[]` and `decode(wire): Op[]` are the only places either
exists. Keeping them out of `Op` means `apply` has no id resolution, no `#`
case, and no previous-path state — three branches removed from the hot path —
and the dead-op pass gets a total `opPath`, where before it silently skipped
interned refs.

`["r", value]` carries no path, so it encodes to itself. That is why `isBase`
works unchanged on either vocabulary.

### 4.1 Two rules that are easy to get wrong

**One encoder/decoder pair per stream.** The id table spans a whole subscription
or file: a path interned in batch 3 is referenced in batch 40. A second consumer
that subscribes at batch 40 has never seen the definition, so it needs its own
encoder. Sharing one across consumers hands the late subscriber ids it cannot
resolve, and a base batch does not rescue it — `["r", value]` carries no refs and
leaves the table empty.

**Reset the table on a base batch.** A reader replays from the *last* base batch
with a fresh decoder, so everything after one must be self-contained. Carrying
ids across a replacement emits references to definitions the reader never saw:

```
  4    : [["a",0,"x4"],["a",1,"y4"]]
  5 BASE: [["r",{…}]]
  6    : [["a",0,"x6"]]        <- id 0 was defined in batch 1
  -> RECOVERY FAILED: PathError - unresolvable path: 0
```

**Arity omission is scoped to a batch.** Letting it span batches makes a batch's
first op depend on the previous batch's last one, so a reader that skips or
reorders a batch decodes into the wrong path. Ids are the only cross-batch state,
and the dictionary makes those explicit.

### 4.2 Intern on second use, not first

A definition costs more than the path it replaces, so interning on first use
loses on every path written exactly once — and most are. Measured on a bulk
workload: **255.5 KB first-use versus 179.6 KB with no interning at all.**

### 4.3 Measured

Wire bytes against inline paths, round-trip verified:

| stream | inline | wire | saved |
| --- | --- | --- | --- |
| one hot path (a rolling tool-output window) | 11,290 B | 7,538 B | **33.2%** |
| four alternating paths (lane state) | 14,160 B | 11,032 B | **22.1%** |
| 200 distinct paths | 16,455 B | 16,035 B | 2.6% |

Omission does the work in the first case, interning in the second. In the third
neither helps and the definitions cost a little — which is the case second-use
interning exists to bound.

## 5. Flush emits ops, and drops the dead ones

`flush()` returns the recorded ops. There is no size comparison and no
replacement heuristic: a replacement is something the producer asks for, by
assigning `state` or calling `rebase()`.

An earlier design compared op bytes against the value's serialised size and
replaced when ops were larger. It was removed. Measured against emitting ops
unconditionally, on six workloads, it changed the output in two — both requiring
hundreds of distinct paths to change in a single flush. Neither the harness nor
the replication path does that: `LaneSnapshot` is folded one event at a time, and
the widest case (`run_end`) touches four fields. The rule cost a per-flush
comparison, a running size estimate, and an invalidation rule for the ops that
could not maintain it.

### 5.1 Dead-op elimination

Ops apply in order, so an op is dead if a later one overwrites the whole subtree
it lives in. Only `s`, `d` and `r` do that — `a`, `t` and `p` modify what is
already there, so they never dominate.

| written | emitted |
| --- | --- |
| same field three times | one `s` |
| `x`, then `y`, then `x` again | two ops, first `x` dropped |
| child, then parent replaced | one `s` on the parent |
| set, then delete | one `d` |
| parent replaced, then child | **both** — the child write survives |

Walk backwards keeping a map of overwritten paths and test each op's own
prefixes against it: **O(n · d)** for n ops at path depth d. Comparing each op
against every dominator instead is O(n² · d), which degrades on precisely the
wide flush this pass exists to clean up.

Measured: 12–14 µs per op, flat from 100 to 5000 ops, depth 8 barely costlier
than depth 3. A pathological producer writing the same two fields 5000 times
emits **2 ops from 10 001 recorded**.

> **Object key order is not preserved.** A producer that does
> `set c; set a; delete c; set c` leaves `c` last, because deleting and
> reinserting moves it. The replica receives only the surviving `set c`, applies
> it to a base where `c` never existed, and `c` lands first.
>
> Values are identical — 1823 randomised sequences, zero value mismatches — but
> the serialised forms can differ. This is acceptable because nothing compares a
> replica against its producer: the consumer holds the state and nobody diffs it
> back. The one visible case is a consumer that iterates keys for display, where
> two views could order rows differently, and it needs a delete-and-recreate of
> the same key within one flush. **Do not hash or content-address a replicated
> value.**

Adjacent ops on the same path are then merged: `a` + `a` becomes one append,
`s` + `s` keeps the later, `s` + `a` folds into the set. Non-adjacent append
merging is a future optimisation, not done.

## 6. There is no frame type

What travels is `Op[]`. Do not wrap it.

**`seq` does not belong in the payload.** It would defend against a lossy
transport we do not have: a durable list element already carries `seq` from
storage, an in-process callback cannot skip, and SSE either delivers in order or
breaks — and a break means resubscribe, which means a base batch. A second copy of
storage's `seq` could only disagree with the first. The SSE binding stamps `id:`,
which is where transport metadata belongs.

**Nothing else needs wrapping either.** A `kind` discriminator is redundant once a
replacement is an op (§2), and the address already says which value a batch
belongs to. What would remain is a struct around an array.

So a batch of ops is just `Op[]`. A **base batch** is one whose first op is `r`;
`isBase(ops)` is `ops[0]?.[0] === "r"`, exact rather than heuristic because flush
guarantees `r` appears at index 0 or not at all (§5).

Everything a frame used to do is now done by something that already existed:

| was on the frame | now |
| --- | --- |
| `seq` | the list element's `seq`, or the SSE `id:` |
| `kind: "replace"` | the `r` op |
| which value it belongs to | the address |
| "this is a snapshot" | the `"base"` storage tag |

**Resubscription is a base batch plus buffered batches** — the same thing the lane
adapter already does for the harness: snapshot first, then whatever accumulated
while the client caught up. There is no `Last-Event-ID` and no cross-subscription
resume; that would need a retained op log, which §5 deliberately does not keep.

A consumer that sees a gap, fails to resolve a path, or connects cold takes one
path: ask for a base batch. That is why there is no `Rebase` type.

The cost, stated plainly: **a consumer cannot detect staleness from the payload
alone.** It relies on the transport reporting a break. For SSE and in-process that
is sound. If a lossy or multiplexed transport ever appears, sequencing goes on that
transport's envelope — not back into the ops.

## 7. Safety

Ops arrive from a facet, a plugin compartment, or a tool whose details may echo
model output. **None of it is trusted input**, and the boundary where untrusted
data meets trusted machinery is where this design has to hold.

The reference point is CVE-2025-55182 — RCE in React Server Components, CVSS 10.0,
exploited in the wild. Their Flight protocol is a compact tagged wire format that
reconstructs structure, so the resemblance is real. The failure was *"fails to
validate the structure correctly... treats the fake object as genuine"*: a forged
Chunk resolved as a Promise and exposed internal state containing gadgets to reach
`Function`.

**We are structurally safer, and not because of diligence:**

| | Flight | ops |
| --- | --- | --- |
| can describe runtime objects | yes — Chunks resolve as Promises | no |
| can reference code or modules | yes — client components | no |
| values | arbitrary object graphs | `JsonValue` |
| worst case from a forged payload | RCE | corrupted replica state |

Flight *must* reference code; that is its job. An op can only put a `JsonValue` at
a path, so there is no first link in a gadget chain. This is why an attacker cannot
plant a non-resolving `then` on `Object.prototype`: a data-only `then` is not
callable, and `await` resolves normally when `then` is not callable.

> **Rule: no op may name something the host resolves.** Not a mutation name, not a
> component id, not a module reference. Mutation names were removed for an
> unrelated reason (§8); this is the second and better reason never to reintroduce
> them, because it is the ingredient that made Flight exploitable.

### 7.1 Paths are the dangerous part

`JSON.parse` is safe on its own — `{"__proto__":{}}` becomes an *own* property.
The hazard is `parent[key]`, which is exactly what applying a path does.

A single key is not enough. `x["__proto__"] = v` swaps *x's own* parent, which is
local. It takes a **walk** — `x["__proto__"]["polluted"] = v` — to reach the shared
prototype, and a path is precisely a walk.

`constructor` is worse than `__proto__`, because `({}).constructor.constructor` is
`Function`. That ladder is closed here only because op values cannot be functions;
it is closed properly by rejecting the segment.

**Reserved path segments: `__proto__`, `constructor`, `prototype`.** Rejected at
record time *and* at apply time, including through an interned path id.

They are reserved as *segments*, not as values. An object with a literal
`"__proto__"` key replicates fine as a whole value; only a path walking *through*
it is refused. This is a genuine restriction on what is mutable — document it, do
not pretend it away.

Two further measures on the same hazard:

- **Write with `Object.defineProperty`**, never assignment, so an inherited setter
  cannot run.
- **Resolve own properties only** (`Object.hasOwn`), so a walk cannot escape into
  the prototype chain and an inherited getter cannot fire. This blocks
  `constructor` a second time, since it is inherited.

What prototype pollution actually buys an attacker here is narrower than it first
appears: **it flips defaults, it does not overwrite explicit values.** An own
property shadows. So `{name:"bob", isAdmin:false}` is unaffected; an option bag read
as `opts.skipSandbox` is not. Our own `ShellExecOptions`, `CaptureOptions`,
`ListReadOptions` and `TrackerOptions` are exactly that shape. Note also that
`"x" in {}` and `const {x = false} = {}` both lie under pollution — which is why
the applier uses `Object.hasOwn`.

### 7.2 Array indices

An index may address an existing element or append exactly one past the end.

This is not an arbitrary cap; it is what keeps the value a `JsonValue`. A sparse
array does not survive a JSON round trip — holes serialise to `null` and return as
real properties — so `arr[7] = x` on a length-3 array already produces state a
replica cannot match. Rejecting the write is more honest than diverging.

It removes a denial of service as a side effect rather than as its purpose:
`["s",["xs",4294967290],1]` would otherwise allocate a 4.29-billion-entry array
from one op. Growth stays available and stays proportional, because
`arr.length = n` is emitted as a splice of explicit nulls whose op size grows with
the gap.

### 7.3 Validate op structure on decode

This is the RSC lesson applied to us. A decoder must not trust tuple shape.
Measured against an unvalidated applier:

| malformed op | result |
| --- | --- |
| `["p",["xs"],0,0,"not-an-array"]` | string spread into the array: `["n","o","t",…]` |
| `["s","a",9]` — path is a string | accepted; `"a".slice(0,-1)` is `""`, so it wrote at the root |
| `["ZZZ",["a"],9]` | silently ignored, replica diverges with no error |

Validate: verb is known, arity matches the verb, a path is an array of strings and
non-negative integers, `p` carries integer index and count plus an array of items,
`#` defines an array path. An unknown verb is an **error**, not a no-op — silently
skipping it is how a newer producer's op disappears and a replica drifts.

**One validator per vocabulary.** `assertValidOp` guards `apply` and rejects ids,
short forms and `#`; `assertValidWireOp` guards `decode` and permits them.
Validating a decoded op against the wire grammar is laxer than its own type: a
two-element `["s", value]` would pass, and `apply` would then read the value as a
path.

### 7.4 The tracker's cage leaks on types, not shape

A facet cannot forge an op: it mutates plain objects and the tracker builds the
tuples, so shape is well-formed by construction. Values and keys are another
matter, and `structuredClone` is **not** a JSON check.

| what a facet writes | what happens |
| --- | --- |
| a function | throws (`DataCloneError`) |
| a BigInt, a cycle | throws |
| `new Map([[1,2]])` | op carries `{}`, producer keeps a real Map — **silent divergence** |
| `new Date(0)` | op carries an ISO string, producer keeps a Date |
| `state[Symbol("s")] = 1` | emits `["s",[null],1]` — **a malformed op from our own tracker** |

So the tracker must check what it is given, at record time, where the mistake is:

- **Reject symbol keys.** They are not path segments.
- **Assert `JsonValue` on every recorded value.** Reject `Map`, `Set`, `Date`,
  `RegExp`, typed arrays and class instances explicitly. The scope restriction in
  §3.2 was a comment; it has to be a check.

A getter on state is safe — the trap records the computed result — and a facet
value that *looks* like an op is nested inside `["s", path, value]` and can never
be read as a top-level op, because nothing flattens.

### 7.5 Applier

```ts
export function apply<T>(target: T, ops: readonly Op[]): T;
```

Six verbs, no domain knowledge, no library, no tool code, no registry lookup, and
**no path table** — ids and omitted paths are resolved by `decode` before `apply`
sees anything (§4).

It returns the value rather than mutating in place, because `r` replaces it
outright.
Runs against a **plain mutable object the consumer owns**. It must not be pointed
at a value produced by Immer, which deep-freezes and would throw.

A page of code in any language, which is the property that keeps non-JS consumers
viable. Colyseus ships decoders for C#, Lua and Haxe on the same basis.

## 8. What this removes from the codebase

Concrete deletions, not simplifications in principle:

- **Immer**, from the harness and from the facet layer. See §1 for why a
  patch-producing library cannot serve this purpose.
- **Per-type reducers.** There is one applier, `apply(target, ops)`, with no
  domain knowledge and no registry. Nobody writes a fold for `ToolOutputState` or
  for a plugin's shape.
- **`detailMutations` and `initialDetails`**, and with them the argument that
  `details: unknown` forces special handling. A structural tracker never needs
  the type.
- **`Rebase` as a reducer return value.** A fold that cannot apply leaves state
  alone and the host sends a base batch.
- **Mutation names on the wire**, and therefore mutation-name version skew. Names
  never cross a boundary, so adding or renaming one is not a breaking change.

And three things not to build, each of which looks reasonable until §1:

- **A differ.** Nothing here diffs two values; every path records intent.
- **A keyed op shape plus a codec.** Tuples are the form everywhere (§2).
- **A frame wrapper.** What travels is `Op[]` (§6).

## 9. Durable form

A tracked value is stored as a **list of frames**, one appended per flush. Base
frames carry the storage tag `"base"`.

Recovery reads backwards to the last base batch and applies forward:

```ts
readList(address, { order: "desc", stopAtTag: "base", limit: 100 })
```

`stopAtTag` is a stop condition *within a page*: if no base batch is in the page,
the consumer pages again with the cursor. The tag lives on the storage record
beside `seq`, never inside the value, so storage never parses ops. See
`session-scopes.md` §11.

This is what makes "a replacement truncates recovery" (§5) real rather than
aspirational — a reader stops at the last base batch instead of replaying from
the beginning.

## 10. Open questions

- Prefix interning (a trie over path heads) if a workload emerges with many
  distinct paths sharing long prefixes. Second-use interning (§4) removes the
  pathological case; this would go further.
- Non-adjacent append merging in `coalesce`. Dead-op elimination (§5.1) handles
  redundancy; this would handle interleaving.
- Whether `sort` / `reverse` deserve real ops.
- Cross-language replicas: the applier is a page of code in any language, but the
  interning tables and the wire framing are not specified for a non-JS consumer.

Address interning in the JSONL log is the same trick as path interning, applied
one layer up over `namespace` + `key`. It is **not** an open question — it is
specified in `session-scopes.md` §12 and is a separate dictionary from this one.
