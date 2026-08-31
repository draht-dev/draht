# 04-tool-output: update cadence and rate limiting

**Status: design, not implementation.** This unit is not built. What follows is
the problem, what three other agents do about it, and a candidate solution with
its measured behaviour and its known holes.

Depends on `01-delta` (the op vocabulary), `02-scopes` (the durable list), and
`03-execenv` (where bytes originate).

---

## 1. The invariant this unit exists to hold

> **The durable record, what the model sees, and what the UI shows are always the
> same view.**

Not a simplification — a commitment. If the UI shows output the model never
received, a user reads it, forms a belief about what the model knows, and is
wrong. Showing less is better than showing something different.

Two consequences that look like limitations and are not:

- **One byte budget, not two.** A separate "UI scrollback" budget would break the
  invariant by construction. Codex has two (see §3) and their UI can scroll
  through output the model never saw.
- **Two knobs on the tool, and only two:** how much to keep, and which end. Head
  vs tail is genuinely per-command — `grep` and `find` want the first matches,
  `npm test` wants the failure at the end — and nothing in the harness can infer
  it.

The spill file does not violate this. It is not a view; it is a file on disk the
model reaches through `read`/`grep` like any other file.

---

## 2. The problem

A tool produces output continuously. Every update must reach three consumers. How
often?

**`intervalMs` is the wrong knob**, and it is what `03-execenv` currently ships.
It was chosen for an in-process TUI where 100 ms feels live. The cost of an emit
varies by ~1000x depending on throughput, so a fixed interval is wrong at both
ends:

| | bytes per emit | at 100 emits/s |
| --- | --- | --- |
| slow build, 2 KB/s | 40 | 4 KB/s — fine |
| `cat 1gb.txt` | 51 000 | **5.1 MB/s** — untenable |

**And no purely data-intrinsic policy exists.** "Emit every N bytes changed" gives
constant bytes per emit, so the emit *rate* scales with throughput. "Emit once per
window turnover" is 20 000 emits for 1 GB at a 50 KB window. A clock is
unavoidable; the question is whose, and what it measures.

### 2.1 Where the delta encoding stops helping

Measured, 50 KB tail window, one flush per arrival:

| bytes arriving between flushes | ops | wire | vs a full replacement |
| --- | --- | --- | --- |
| 200 B | `t,a` | 232 B | 0% |
| 2 KB | `t,a` | 2 067 B | 4% |
| 25 KB | `t,a` | 25 504 B | 51% |
| 49 KB | `t,a` | 49 959 B | 100% |
| **50 KB and above** | **`s`** | **50 967 B** | **102%** |

The delta helps in exact proportion to how little the window moved, and stops
entirely once arrival >= cap. At `cat` rates every update is a full `s`. That is
correct behaviour, not a failure — but it means **the pathological case is bounded
by the cap and the cadence, never by the encoding.**

Related: at full turnover, `s`-on-the-field and `r`-on-the-root are within 0.3%
(51 833 vs 51 970 bytes). At low rates the field-level `s` is 224x smaller. So the
tracker naturally emits the narrowest op it can, exactly where narrowness pays.

---

## 3. What other agents do

Read before designing. All three differ from us and from each other.

### tmux — backpressure at the source

```c
#define READ_SIZE     1024   // max data held from a pty
#define READ_BACKOFF   512   // bytes waiting for the tty before backing off
#define READ_TIME      100   // µs to wait before the next read
```

tmux stops **reading the pty** when the client is behind, and discards output plus
a full redraw when the backlog gets large — which is our full-turnover `s`,
arrived at independently.

The symptom that justifies it: *"when the user tries to ^C the command they have
to wait for this backlog to clear"*. **The real cost of a queue is interactivity,
not bandwidth.** Their failure mode is permanent data loss — users reported
scrollback silently truncated — which our spill avoids.

### Codex — no backpressure, deliberately, and two budgets

```rust
// Continue reading to EOF to avoid back-pressure
pub const DEFAULT_OUTPUT_BYTES_CAP: usize = 1024 * 1024;   // head, silent drop
pub(crate) const MAX_EXEC_OUTPUT_DELTAS_PER_CALL: usize = 10_000;
const READ_CHUNK_SIZE: usize = 8192;
```

Model gets the first 1 MB, head-retained, silently discarded past that. The UI
gets raw 8 KB chunks it appends itself, capped at 10 000 **events** — so up to
80 MB, bounded by count rather than rate. Crude, needs no timer and no consumer
signal, and breaks our invariant: their UI can scroll through output the model
never saw.

### OpenCode — no live output at all

```ts
// TODO: Add durable/live progress metadata streaming for long-running commands
//       once V2 tool invocation progress context is wired.
```

`collectStream` folds the whole stream into a 1 MB head-retained buffer and
returns once. Their **v2 spec** states the separation we should copy:

> *"Model-output bounding is not producer memory management. Processes and
> streaming sources may need separate capture or spooling limits before a tool
> result exists. Those limits must be modeled at the producer boundary and must
> not masquerade as model-output truncation. A producer cannot claim a complete
> retained output after it has already discarded bytes."*

Also worth taking: *"if complete retention fails, settlement fails operationally
rather than publishing lossy success"* — better to fail the tool than hand the
model a silently truncated result. Both Codex and OpenCode-v1 do the lossy thing.

**We are the only one of the three that keeps the tail.** For `npm test`, where
the failure is at the end, head retention shows the successful setup and drops the
error.

---

## 4. Candidate: a byte-rate limiter owned by the sink

The constraint is bandwidth, so measure bandwidth. **Unit: bytes per second.** One
value in the sink, not per tool.

```ts
#maybeEmit(): void {
  this.#credit = min(RATE, this.#credit + RATE * secondsSince(this.#lastRefill));
  this.#lastRefill = now();
  if (this.#credit <= 0) return;               // accumulate instead

  const ops = this.#tracker.flush();
  if (ops.length === 0) return;
  const wire = this.#encoder.encode(ops);
  this.#credit -= sizeOf(wire);
  this.#publish(wire);                          // ONE emit, all three consumers
}
```

`flush()` drains, so it can only be called once per batch — which is *why* durable
and UI share it, and why they cannot diverge.

### Measured, 50 KB budget, RATE = 100 KB/s, 10 s

| producer | emits/s | wire |
| --- | --- | --- |
| slow build, 2 KB/s | 100/s | 40 KB |
| busy build, 50 KB/s | 100/s | 529 KB |
| **`cat`, 100 MB/s** | **2.2/s** | **1.1 MB** |
| `cat`, no limit (`intervalMs=100` today) | 100/s | **50.6 MB** |

**45x less wire for `cat`, and the slow case is more responsive than a 100 ms
interval, not less.** Same rule, opposite behaviour, because it measures the thing
that is actually scarce. Nobody configures a cadence.

### 4.1 This depends on D1 being fixed first

Holding back is only free if held-back writes collapse. **They currently do not**
— see `../01-delta/FINDINGS.md` D1: 1000 held-back interleaved writes produce 2001
ops and 264 KB. Until that is fixed the rate limiter converts a bandwidth problem
into a memory problem.

### 4.2 Known hole: the trailing emit

`#maybeEmit` runs only when the tool writes. A command that bursts and then goes
quiet on a held write never sends it:

```
t=0ms   sent 319B (credit -19)
t=10ms  sent 329B (credit -248)
t=20ms  HELD
        ...quiet for 30s...
        tracker still dirty — the UI shows state from t=10ms, forever
```

Needs a **one-shot** timer armed only while something is held, with the delay
computed as `deficit / RATE`. That is not the knob we deleted: it is derived from
`RATE`, not configured, and it does not poll.

### 4.3 Undecided

- **Durability cadence.** Does the durable write ride the same emit, or run
  slower? Riding it is simpler and preserves the invariant trivially. A separate
  slower clock reduces writes but needs its own trailing timer and its own
  argument for why divergence is acceptable.
- **Backpressure.** tmux stops reading the pipe; Codex explicitly does not. We
  currently do not. tmux is the only one with a human pressing Ctrl-C in the
  pane — which suggests backpressure buys *interactivity*, and we may be closer to
  Codex here. Unmeasured: whether our abort path has the Ctrl-C latency problem.
- **Pull-based instead of a rate limit.** The consumer says "ready" and gets the
  current state; no estimation at all. Measured: **1000 producer writes cost the
  same one op as 1**, so a slow consumer sees a bigger jump rather than a queue.
  Cleaner in principle, needs consumer plumbing and still needs a durability floor.

---

## 5. Consequences for `03-execenv`

**`BASH_CHECKPOINT_INTERVAL_MS` goes and nothing in `03-execenv` replaces it.**
The durable cadence is not a `Shell` concern.

`bash.after.ts` as shipped checkpoints when the update kind is `snapshot`, on the
reasoning that a snapshot is the only kind that can express eviction. **That is
wrong and should not be copied.** `nowCrossed` is sticky: once total output
exceeds the cap it never resets, so every subsequent update is a snapshot — a
durable write every `intervalMs`, the same cadence, not a lower one.

**Two knobs can also go:**

- **`maxLines`** is redundant with `maxBytes`. 2000 lines x 25 bytes is the same
  bound; 100 000 tiny lines still yields ~50 KB. Keep truncation *line-aware* —
  cut at a line boundary at or below the budget — which is what `truncateTail`
  already does, so removing the parameter does not change behaviour.
- **A byte limit does not break UTF-8.** Only slicing by *code units* does.
  Binary-searching on encoded length lands on a codepoint boundary every time, and
  `trimToLastBytes` already does this. Verified across mixed ASCII / accented /
  CJK / emoji at 10, 20 and 30-byte budgets.

**`counters` as an update kind can go too.** It exists so head mode can move a
number without resending the frozen text — but nothing needs that number *live*.
The final `ShellExecResult` carries the totals and the visible content was
complete when the cap filled. Head mode emits chunks until full, then silence.
That reduces three update kinds to two.

**`retain: "head" | "tail"` stays.** Head is correct for search-shaped output —
`grep`, `find`, `ls -R`, where results are unordered so the first N are as
informative as any N and arrive immediately. `truncateHead` is already used by
`read.ts`.

Resulting `CaptureOptions`: `{ maxBytes, retain?, spill? }` — three, from five.
