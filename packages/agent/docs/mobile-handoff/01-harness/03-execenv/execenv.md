# ExecutionEnv: Bounded Shell Output

Moves output capping, spilling and coalescing out of individual tools and into
`Shell`, so they happen where the bytes originate.

> **Scope:** `packages/agent/src/harness/env/`, `harness/utils/`,
> `harness/tools/bash.ts`, and the `Shell` contract in `harness/types.ts`.
>
> **Independent of `01-delta` and `02-scopes`.** `Shell`'s three update kinds are
> its own vocabulary and stop at the `ToolOutput` sink; `Shell` never emits ops
> and knows nothing about `delta.md`. This unit can land in any order.
>
> **This one has working code**, not just a specification:
>
> | file | lands as |
> | --- | --- |
> | `output-capture.ts` | `harness/utils/output-capture.ts` — new |
> | `bash.after.ts` | `harness/tools/bash.ts` — the rewritten tool |
> | `nodejs-env.diff` | the `NodeExecutionEnv.exec` change |
> | `nodejs-env.test.diff` | the test migration, 29 passing |
>
> All of it typechecked and ran: `cd packages/agent && npx vitest run --config
> vitest.harness.config.ts nodejs-env` gives 29 passed, 1 skipped.

---

## 1. The problem

Three separate faults, one root cause.

**`exec` is unbounded at its root.**

```ts
// packages/agent/src/harness/types.ts
exec(command, options, context): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>
```

```ts
// packages/agent/src/harness/env/nodejs.ts:463,474
child.stdout?.on("data", (chunk: string) => { stdout += chunk; /* … */ });
child.stderr?.on("data", (chunk: string) => { stderr += chunk; /* … */ });
```

`cat 1gb.txt` materialises 1 GB of string in the agent process. No cap exists
below the tool layer, so no tool-level truncation can prevent it — by the time
`bash.ts` sees the output it has already been accumulated in full.

**Truncation is tool-specific.** `bash.ts` owns a rolling buffer, `truncateTail`,
and a spill file. `read.ts` has its own truncation. Every future tool that
produces bulk output re-implements the same logic, differently.

**Spill has no owner.** bash writes to `createTempFile({ prefix: "bash-" })` —
`/tmp`, cleaned up whenever the OS decides. The path is handed to the model so it
can `grep` the full output, which means the file must live on the machine where
the model's other tools run.

That last point is the constraint that shapes everything: **the spill must be in
the execution environment.** Not in session storage, not on the agent machine.
If the exec env is a remote sandbox, a spill on the agent host is unreachable to
the model's own `read` and `grep`.

Which means the capping has to happen there too. Otherwise reading a 1 GB file on
a sandbox host ships 1 GB to the agent machine, caps it, and ships the spill back.

## 2. Scope

**In scope.** Bounded capture in `Shell`, spill inside the exec env, coalesced
live updates, capability reporting.

**Relationship to the rest.** The three update kinds here are `Shell`'s own
vocabulary and stop at the `ToolOutput` sink; they do not travel further.
`harness-tools.md` §4 converts them into ops against `ToolOutputState`. `Shell`
never emits ops and knows nothing about `delta.md`.

**Out of scope, deliberately.** Making a *remote* exec env work well with a local
worker. The answer there is to run the worker where the exec env is — the server
stays local, the worker relocates — and that is a separate work package. This
document assumes worker and exec env are colocated, which is the case for
`NodeExecutionEnv` today.

## 3. Types

```ts
// ─── Policy ──────────────────────────────────────────────────────

/** Which retained portion survives when output exceeds the limits. */
export type OutputRetention = "head" | "tail";

/** How much output the caller can accept, and what to keep on overflow. */
export interface OutputLimits {
  maxBytes: number;
  maxLines: number;
  /** Defaults to "tail". */
  retain?: OutputRetention;
}

/** Requests bounded capture. Absent means unbounded. */
export interface CaptureOptions {
  limits: OutputLimits;
  /**
   * Minimum interval between onUpdate calls, in ms. Output arriving inside a
   * window is coalesced, never dropped. 0 emits per chunk. Defaults to 0.
   */
  intervalMs?: number;
  /**
   * Archive the full output to a file inside this environment, created lazily
   * when the limits are first exceeded. The path is meaningful on the machine
   * the command ran on.
   */
  spill?: boolean;
}

// ─── Captured output ─────────────────────────────────────────────

export type ShellStream = "stdout" | "stderr";

/** Bounded view of a command's output, aggregated in arrival order. */
export interface CapturedOutput {
  /** The retained portion, already truncated per OutputLimits. */
  text: string;
  /** Totals over everything produced, plus what was kept. */
  truncation: TruncationResult;
  /** Present only if spill was requested and the limits were exceeded. */
  spillPath?: string;
  /**
   * Size of the final line when it alone exceeded the byte cap
   * (`truncation.lastLinePartial`). Only the env holds the raw buffer, so only
   * the env can measure it — a tool cannot recover it from the retained view.
   */
  lastLineBytes?: number;
}

export type ShellOutputUpdate =
  | { kind: "chunk";    stream: ShellStream; text: string }
  | { kind: "snapshot"; output: CapturedOutput }
  | { kind: "counters"; truncation: TruncationResult };

// ─── Exec ────────────────────────────────────────────────────────

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeout?: number;

  /** Bounded capture. Absent means unbounded. */
  capture?: CaptureOptions;
  /** Live output. Replaces onStdout / onStderr. */
  onUpdate?: (update: ShellOutputUpdate, context: Context) => void;
}

export interface ShellExecResult {
  output: CapturedOutput;
  exitCode: number;
}

/** What this implementation can actually do. Tiers differ in fidelity. */
export interface ShellCapabilities {
  /** false for a backend that can only stream raw bytes. */
  capture: boolean;
  spill: boolean;
  /** false when the backend cannot emit incrementally. */
  liveUpdates: boolean;
}

export interface Shell {
  capabilities(): ShellCapabilities;
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>>;
  cleanup(context: Context): Promise<void>;
}

export interface ExecutionEnv extends FileSystem, Shell {}
```

`TruncationResult` is the existing type from
`packages/agent/src/harness/utils/truncate.ts`. It already carries `totalBytes`,
`totalLines`, `truncated`, `truncatedBy`, `outputBytes`, `outputLines`, which is
exactly what a UI needs to render "showing last 50 KB of 1.2 GB". No new type.

`Shell` deliberately has **no tool vocabulary**. It emits text. Images, details,
usage, added tool names and terminate are `ToolOutput`'s concern and are produced
on the agent side. That is why `ShellOutputUpdate` has three variants and not six.

## 4. Why three update kinds

They are the three states a bounded buffer can be in: text grows, text slides,
text stops.

| kind | when | why nothing else works |
|---|---|---|
| `chunk` | below the cap | append-only and complete; the common case, since most commands never reach the cap |
| `snapshot` | retained view changed by eviction | an append cannot express "and 20 bytes fell off the front" |
| `counters` | `head` mode past the cap | text is frozen forever; without this you resend `maxBytes` to move a number |

Reader:

```ts
switch (u.kind) {
  case "chunk":    view.text += u.text;              break;
  case "snapshot": view = u.output;                  break;
  case "counters": view.truncation = u.truncation;   break;
}
```

### 4.1 Ordering invariant

> Once the cap is crossed, a `chunk` must never follow without an intervening
> `snapshot`.

The first flush that evicts is a `snapshot` regardless of size. Violating this
leaves the reader appending to a view whose front has been discarded — it grows
without bound and silently disagrees with `truncation`.

A `head` producer never evicts, so it emits chunks up to the cap and only
`counters` afterwards, and never needs a snapshot.

### 4.2 Per-mode behaviour

Worked example: `maxBytes = 100`, `intervalMs = 500`.

**`retain: "tail"`**

| flush | produced | total | evicted | emitted |
|---|---|---|---|---|
| 1 | 30 B | 30 | — | `chunk` 30 B |
| 2 | 40 B | 70 | — | `chunk` 40 B |
| 3 | 50 B | 120 | 20 B | **`snapshot`** 100 B |
| 4 | 10 B | 130 | 10 B | `snapshot` 100 B |
| 5 | 0 B | 130 | — | *(nothing)* |
| 6 | 5 B | 135 | 5 B | `snapshot` 100 B |

Flush 3 is the crossing. Note flushes 4 and 6: **once the buffer is full, every
byte in evicts a byte out**, so there is no cheap-trickle regime past the cap.
Tail collapses to: chunks until full, snapshots at the interval thereafter.

**`retain: "head"`**

| flush | produced | total | emitted |
|---|---|---|---|
| 1 | 30 B | 30 | `chunk` 30 B |
| 2 | 40 B | 70 | `chunk` 40 B |
| 3 | 50 B | 120 | `chunk` 30 B *(the part that fit)* |
| 4 | 10 B | 130 | `counters` |

Head never evicts. After the cap only totals move.

**Head+tail is not offered.** `harness-tools.md` §3.1 rejected it and that stands:
`truncate.ts` exports `truncateHead` and `truncateTail`, neither combines them, and
none is being added. OpenCode's `preview` shape — half the budget from each end —
is a reasonable future addition for failed builds, where you want the invocation
and the error but not the middle, but it is out of scope here.

### 4.3 Idle

No output in a window emits nothing. `counters` should use a slower cadence than
`intervalMs` (2 s is reasonable) since it exists only to keep a total live.

### 4.3.1 Coalescing is a size lever, not only a rate lever

`intervalMs` sets how large a chunk the sink receives, and chunk size decides both
throughput and wire size downstream (`delta.md` §4.2).

Measured against a 50 KB window: at 100-byte chunks the op encoding puts **135% of
the input on the wire** — past the cap each write emits `truncate` + `append`, and
two op envelopes exceed a 100-byte payload. At 8 KB chunks it is 31%.

So an `intervalMs` of 0 is correct only for a tool that produces little output. For
anything streaming, coalescing is what keeps the encoding on the right side of that
curve, and the interval should be chosen with size in mind rather than only
"how often should the UI redraw".

### 4.4 Traffic bound

Worst case is `maxBytes / intervalMs`, independent of how much the command
produces. At 50 KB and 500 ms that is 100 KB/s whether the command emits 1 MB or
1 GB. This is the property that makes the pathological case safe, and it is why
snapshots are the safe path rather than a fallback.

## 5. Implementation tiers

**Tier 1 — Node (`NodeExecutionEnv`).** Mostly a move, not new code. The logic in
`packages/agent/src/harness/utils/shell-output.ts` already implements all of it:
a rolling buffer held at `DEFAULT_MAX_BYTES * 2` (`trimToLastUtf8Bytes`),
`truncateTail` applied at snapshot time, and lazy spill via `ensureFullOutputFile`
/ `appendFullOutput`. Relocate it into the env, generalise `truncateTail` to the
three retention modes, add coalescing.

Note the existing two-stage structure and keep it: the raw buffer is trimmed to
`maxBytes * 2` as a memory guard, and the retained view is computed from it per
snapshot. `truncateTail` is line-aware — it walks backwards line by line and takes
a partial only when a single line alone exceeds `maxBytes` — so eviction is not
byte arithmetic.

**Tier 2 — pi helper.** Same TypeScript on the far side of the connection.
Nothing to design.

**Tier 3 — dumb SSH, shell script.** Implementable:

```sh
cmd 2>&1 | tee "$SPILL" &
pid=$!
while kill -0 $pid 2>/dev/null; do
  printf '\0SNAP\0'; tail -c "$MAXB" "$SPILL"
  sleep "$INTERVAL"
done
```

Spill via `tee`, bounded snapshots via `tail -c` against the spill file.
`retain: "head"` is `head -c` and can stop reading early. Needs a framing
sentinel and a writable remote path.

This tier can emit `snapshot` and `counters` but the chunk path is degraded,
because a `tail -c` pipeline buffers. That is acceptable: `snapshot` is
self-contained, so a snapshot-only stream is correct, just less live. It reports
`liveUpdates: false`.

`capabilities()` exists so this degradation is declared rather than silent. A
backend reporting `capture: false` forces the caller to apply limits locally,
accepting that the bytes crossed the wire.

## 6. Migration

**Breaking.** `exec` no longer returns `{ stdout, stderr }`. Verified that no
caller consumes them separately — only `nodejs.ts` internals touch
`child.stdout` / `child.stderr` — so aggregating in arrival order costs nothing.
`chunk` carries `stream` so a renderer can still colour stderr.

**`onStdout` / `onStderr` → `onUpdate`.** The callback-error path
(`callback_error`, abort on throw) carries over unchanged.

**`shell-output.ts` collapses.** `executeShellWithCapture`, `createProgress`,
`tailOutput`, `ensureFullOutputFile` all move into the env.

**`bash.ts` loses its truncation entirely.** No rolling buffer, no `truncateTail`,
no `createTempFile`, no `BASH_UPDATE_THROTTLE_MS`. `fullOutputPath` becomes
`spillPath` returned in `CapturedOutput`. Its `details` reduce to whatever remains
tool-specific.

**`BASH_CHECKPOINT_INTERVAL_MS` goes, and nothing here replaces it.** The durable
cadence is not a `Shell` concern.

The shipped `bash.after.ts` checkpoints when the update kind is `snapshot`, on the
reasoning that a snapshot is the only kind that can express eviction. **That is
wrong and should not be copied.** `nowCrossed` is sticky: once total output
exceeds the cap it never goes back, so every subsequent update is a snapshot. At
`intervalMs = 100` that is a durable write every 100 ms — the same cadence, not a
lower one.

Two rates genuinely exist. The UI wants roughly 100 ms; durability wants roughly
two seconds. But a *tool* has no basis for choosing the second: it does not know
what a durable write costs, whether there is a sidecar, or what recovery is worth.
That belongs to the sink, and it is settled in `04-tool-output` — where the
`checkpoint` flag comes off the tool-facing API entirely.

**`read.ts`** keeps its own truncation for now — it reads files rather than
running commands, so it does not go through `Shell`. Unifying that is a separate
question (§8).

### 6.1 Three things that only surface when you run it

Each of these passes typecheck and fails at runtime.

**Await the spill chain before the final snapshot.** The spill file is created
lazily, on the first chunk, so its path does not exist yet when `exec` settles.
Snapshotting before that promise resolves reports `spillPath: undefined` for
output that *was* archived — the file is on disk, the caller just never learns
where. Await the chain, then `capture.flush()`, then snapshot.

**Counting newlines is not counting lines.** A command emitting one 60 KB line
with no trailing newline has produced **one** line, not zero. The off-by-one
surfaces as a user-visible message reading `line 0`, and only for the
single-oversized-line case. Count newlines, plus one if the buffer does not end
with one.

**`lastLineBytes` can only come from the env.** When one line alone exceeds the
byte cap, the footer reports that line's own size — and only the env holds the
raw buffer, so a tool cannot recover it from the retained view.
`CapturedOutput.lastLineBytes` carries it.

There is also a portability trap in the shipped code: **no TypeScript parameter
properties.** `constructor(readonly x: T)` is rejected outright by Node's
`--experimental-strip-types`, which is the mode these files are meant to run
under.

## 7. Spill lifetime

The spill exists so the **model** can read it. That fixes its location: inside the
exec env, on the machine where the model's other tools run.

It must **not** be deleted when the tool settles — the model may `grep` a spill
from an earlier turn in the same session. So spill lifetime is session-scoped, not
invocation-scoped, and something has to sweep it.

Current behaviour is `createTempFile` into `/tmp` with OS-dependent cleanup, which
is the complaint that started this. Proposed: a session-scoped directory the env
owns, swept on session end, with a retention floor for crash cases. OpenCode uses
7-day retention on its `tool-output/` directory as precedent.

## 8. Open questions

- **Session-scoped spill directory.** Who creates it, who sweeps it, and what the
  path looks like to the model. Needs an env-level concept that does not exist yet.
- **`read.ts` and other non-shell bulk output.** Should `FileSystem` grow the same
  capture policy, or does `ToolOutput` handle those on the agent side because the
  bytes already crossed? Leaning to the latter, since a file read is a single call
  rather than a stream.
- **UTF-8 chunk boundaries.** A chunk boundary landing mid-codepoint bakes in a
  replacement character. `setEncoding("utf8")` on the Node streams handles this
  today; a tier-3 shell script does not. Codex spends real effort here
  (`bytes_to_string_smart`, `chardetng`) — we should at minimum not corrupt UTF-8.
- **`counters` cadence.** Fixed 2 s, or derived from `intervalMs`.
- Whether head+tail retention is worth adding later, and if so whether the two
  halves need separate budgets.
- **Serving spill to a UI.** When the worker is remote, the server cannot read the
  spill file, so a "view full output" affordance must go through the worker. Out of
  scope here, but it constrains the UI design.
- **Binary output.** A command emitting binary to stdout currently becomes lossy
  UTF-8. Whether `Shell` should detect and refuse, or spill raw bytes and retain a
  marker, is undecided.
