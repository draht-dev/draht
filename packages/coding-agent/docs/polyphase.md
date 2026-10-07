# Orchestrate agents with polyphase

Polyphase gives you live oversight of every agent draht fans out: `subagent` calls (single,
parallel, or chain) and model-written `workflow` scripts. In the TUI you get a live line per agent
in the tool row, a one-line dock above the editor, and a popup inspector (`alt+a`). Outside the
TUI, you get the same final text and bounded structured results, without the live views. Duet
triage (`duet_delegate`) shares the dock, the inspector, and the concurrency limiter, but keeps its
own, unrelated tool row.

## Overview

A `subagent` call, a duet triage batch, or a `workflow` script all spawn one child `draht` process
per agent, each running `--mode json -p --no-session`. Polyphase parses that child's JSON event
stream into live state (model, activity, transcript, usage, tool calls), coalesces updates through
one timer per session, and renders them into the dock and the inspector; `subagent` and `workflow`
calls additionally render into the tool row. All of this state is session-scoped: it is created on
first use and disposed when the session shuts down, so attached or multiplexed sessions never
share it.

The `subagent` tool, `duet_delegate` triage, and the `workflow` tool share one child-process
runner, one per-session concurrency limiter, and one live-view store feeding the dock and the
inspector. `duet_delegate` keeps its own tool-row renderer and result format — see
[Tool rows](#tool-rows).

## Tool rows

Each subagent or workflow tool call renders as a block in the transcript, one line per agent.
`duet_delegate` is not covered by this section: it renders its own, unchanged tool-row block (a
partial result shows only a `N/M teammates active` status; the finished result is plain text).

```
subagent parallel · 3 agents
◐ 1 running · ✓ 1 done · ◌ 1 queued (4/4 slots busy)  0:42 · 12.3k tok · $0.08
✓ investigator claude-sonnet-5 high   0:31  STATUS: DONE — 3 candidate files
◐ reviewer#1   claude-sonnet-5 high   0:12  thinking · The refresh path calls…
◌ reviewer#2   claude-sonnet-5 high         queued
alt+a inspect agents · ctrl+o expand
```

- **Glyphs:** `◐`/`◓`/`◑`/`◒` spinner or `●` (running), `◌` (queued), `·` (pending), `✓` (done),
  `✗` (failed), `⊘` (cancelled), `–` (skipped), `⚠` (blocked tool call).
- **Only the focus row animates.** The focus row is the newest running tool-origin `subagent` or
  `workflow` run. Every other row shows a static `●` glyph with no elapsed time, no live tokens,
  and no "what it's doing now" text, so scrolling past a background run never forces a full
  terminal redraw.
- **Expand/collapse** with `app.tools.expand` (`ctrl+o`, the existing key). The expanded view adds
  per-agent task text, tool-call counts, and either the live transcript tail (thinking/text/tool
  items) or, once finished, a head+tail preview of the output (up to 10 lines; longer output shows
  the first 3 lines, an `… N lines omitted …` marker, and the last 6).
- **Chain** rows show one line per step with step numbers; not-yet-reached steps read
  `waits for step N` and skipped steps read `not run`.
- **Workflow** rows show a phase tree instead of a flat agent list: one line per phase with a
  `done/total` tally and elapsed time, the active phase's agents indented, the last `log(...)` line
  prefixed `»`, and, once finished, the returned value prefixed `→`.
- **Resumed sessions** (after `/resume`, a crash, or a fork) render the final block from the
  persisted `details` only — see [Non-TUI behavior and the details schema](#non-tui-behavior-and-the-details-schema).
  Old sessions recorded before polyphase existed fall back to a legacy renderer.

## The dock

While any run is active, a one-line widget appears above the editor (`polyphase.dock`, default
on):

```
◐ polyphase · 2 runs · 3 running · 1 queued · 6 done · 1 failed · $0.69 · alt+a inspect
```

A running workflow started from a slash command (`/<name>` or `/workflow <name>`) additionally
shows its compact phase tree under the summary line, capped at 10 lines total for the whole dock.
The dock disappears again once nothing is running, and is skipped entirely when
`polyphase.dock` is `false` or there is no TUI (print, JSON, RPC).

## The agent inspector

Press `app.polyphase.inspector` (default `alt+a`) to open a full-screen overlay listing runs and
agents, and to follow any agent's live thinking, text, and tool calls. A second press — or
`escape` — closes it; `escape` from a detail or run view instead steps back one level.

### Views

- **Runs** — live runs, runs finished earlier in this session (recovered from the transcript),
  and saved workflows; `enter` on a saved workflow inserts its run command (`/<name> ` or
  `/workflow <name> `) into the editor and closes the inspector. Opens automatically when there
  is no exactly-one live run, or on `/workflows`.
- **Run** — phase-grouped for workflows, a flat numbered list of steps for chains, a flat list of
  agents otherwise. Opens automatically when exactly one run is live, with its first running
  agent selected.
- **Agent detail** — the live transcript tail for one agent: tool calls with status and duration,
  thinking and text, and a footer showing `◆ following` or `‖ paused · f to follow`.
- **Split view** — at 120 columns or more, the run view's agent list (left, 40 columns) and the
  selected agent's detail (right) render side by side; `enter` switches to the full-width detail.

Archived (no-longer-live) runs render from their persisted summary only, with the note
"Live transcript is only kept while the run is in memory."

### Keys

All keys are configurable bindings (see [Keybindings Reference](keybindings.md)); none are
hardcoded.

| Action | Binding id | Default |
|---|---|---|
| Open / close the inspector | `app.polyphase.inspector` | `alt+a` |
| Move selection | `tui.select.up` / `tui.select.down` | up / down |
| Page | `tui.select.pageUp` / `tui.select.pageDown` | pageUp / pageDown |
| Open / drill in | `tui.select.confirm` | enter |
| Back / close | `tui.select.cancel` | escape, ctrl+c |
| Next / previous agent | `app.polyphase.nextAgent` / `app.polyphase.previousAgent` | tab / shift+tab |
| Toggle follow (detail view) | `app.polyphase.follow` | f |
| Cancel the selected agent | `app.polyphase.cancelAgent` | x |
| Cancel the selected run | `app.polyphase.cancelRun` | shift+x |
| Show / hide thinking | `app.thinking.toggle` (reused) | ctrl+t |
| Show / hide tool-result previews | `app.tools.expand` (reused) | ctrl+o |

Opening the inspector over an active permission or confirmation dialog is suppressed, so `alt+a`
never hides a prompt you still need to answer; conversely, the inspector closes itself right
before such a dialog opens, so it is never left covering one.

### Cancel semantics

Cancelling takes two presses of the same key, with no timer: the first press arms it and the
footer shows a `press the same key again to cancel <label>` (or `... to cancel the run`) prompt;
any other key disarms it; a second press of the same key confirms. Pressing cancel on an agent
that has already finished shows `already finished` and does not arm.

Cancelling an agent inside a running `workflow` script makes its `agent()` call return `null` to
the script (the script sees it exactly like a failed or budget-exhausted call — check for `null`).
Cancelling a run cancels every unfinished agent in it and stops the run.

## Model inheritance and per-task overrides

Model and thinking level for a child agent are resolved in this order, first match wins:

1. An explicit `model` (and `thinking`/`effort`) on the call itself — the `subagent` tool's
   per-task `model`/`thinking` fields, or `agent(prompt, { model, effort })` in a workflow script.
2. A workflow phase's `model` from `meta.phases[n].model`.
3. The agent type's frontmatter `model:`, passed through to the child verbatim (so an invalid
   pattern is still diagnosed by the child, as before).
4. The parent session's current model and thinking level ("inherited"). Subagents without an
   explicit or frontmatter model now inherit the parent's model and thinking level, instead of
   falling back to the child's own default.
5. The child's own default model, when nothing above resolved to a usable model.

When an inherited model turns out to be one the child process cannot resolve on its own (an
extension-registered or virtual model that only exists in the parent), the runner retries once
without `--model`/`--thinking` and the row shows `default model` instead. This fallback only
applies to inherited models; an invalid explicit override or frontmatter model is reported as a
failure, not silently swapped.

Model labels: collapsed rows show `id thinking` (e.g. `claude-sonnet-5 high`); expanded rows show
`provider/id thinking (source)`, with `(source)` shown only for `inherited` and `child-default`.

## Parent-model results

When a `subagent` or `workflow` tool call finishes, the text returned to the parent model is
capped and shaped so it stays informative without flooding context:

- **Single mode:** the full output, head+tail capped at 50,000 characters, keeping the last
  `STATUS:` line even when the tail cut would otherwise drop it. A failure instead shows
  `FAILED (exit 1, model <provider/id>)` with an 8,000-character output cap and the last 2,000
  characters of stderr. A cancellation shows `CANCELLED by <reason> after <elapsed>` plus any
  partial output.
- **Parallel mode:** a summary line (`Parallel: 2/3 succeeded, 1 failed`), then one block per
  agent with its status, model, and elapsed time, and a per-agent output cap that divides a
  shared budget (`polyphase.resultChars`, default 64,000) across all agents (2,000-16,000
  characters per agent). Failed agents' blocks include a stderr tail.
- **Chain mode:** one status line per step, then the last step's output (50,000-character cap),
  or — on failure or cancellation — `Chain failed|cancelled at step k (<label>)` with that step's
  output and stderr.
- **Workflow:** a header line (status, agent counts, elapsed, tokens, cost), a `Phases:` tally,
  the returned value as pretty JSON (or text) capped at 32,000 characters, the last 30 `log(...)`
  lines, up to 8,000 characters of console output, and up to 100 per-agent summary lines, followed
  by any budget notice, script error (with its source line), and blocked-call note.

Every mode appends, when applicable, a note about tool calls blocked inside subagents — see
[Permissions](#permissions) below.

Tokens and cost shown anywhere in polyphase (rows, dock, inspector, result text) are *billable*
tokens: input + output + cache-write tokens, excluding cache reads. The same measure drives token
budgets. Cost is shown in USD (`usage.cost.total`) but is never itself budgeted.

## Workflows

A workflow is a script the model writes (or you save to a file) that orchestrates one or more
subagents through a multi-phase task, with the same live oversight as a `subagent` call.

### The keyword

The `workflow` tool is not registered by default. Saying the configured keyword (default
`polyphase`, `polyphase.keyword`) anywhere in a prompt enables it for that prompt: draht registers
the tool, activates it, and — whenever the authoring guide is not already in context (the first
time, and again after each compaction) — sends the model a one-line visible message
(`◆ polyphase · workflow tool enabled · authoring guide sent to the model`, expandable to the full
script-authoring guide) so the model knows the API without a system-prompt change. The tool
deactivates again once the agent settles, unless it was activated some other way. An input
starting with `/` or `!` never triggers the keyword. Set `polyphase.workflowTool` to `"always"` to
keep it active for the whole session, or `"off"` to disable the keyword entirely (saved-workflow
commands still work either way).

### The script API

A workflow script is plain JavaScript with no imports, no filesystem access, and no network access
of its own — all real work happens inside the subagents it starts with `agent()`. It must start
with a `meta` block written as a pure literal (no identifiers, function calls, spreads, computed
keys, template interpolation, or regex literals):

```js
export const meta = {
  name: "review-pr",            // ^[a-z][a-z0-9-]{0,47}$, used for /review-pr if saved
  description: "Review a change in parallel and synthesize findings", // 1-300 chars
  whenToUse: "...",             // optional, <= 300 chars
  phases: [                     // 1-20 entries
    { title: "Scan" },
    { title: "Review" },
    { title: "Synthesize", model: "anthropic/claude-opus-5-5" }, // optional per-phase model
  ],
};
```

Unknown keys in `meta` are ignored, not errors. Validation errors report the exact field path
(e.g. `meta.phases[2].title`) and a 1-based line and column.

The async body after `meta` uses:

- `agent(prompt, opts)` — starts one subagent and returns its final text, or (with `opts.schema`
  set) the schema-validated object. Returns `null` when the agent failed, was cancelled (by the
  user or the token budget), the budget was already exhausted, or produced no valid structured
  output when a schema was requested — always check for `null`. Throws for invalid options, an
  unknown `agentType`/model, an invalid `effort`, or the per-run agent cap.
  `opts`: `{ label, phase, schema, model, effort, isolation: "worktree", agentType }`.
- `parallel(thunks)` — runs an array of zero-argument thunks (each should call `agent()`) and
  waits for all of them (a barrier). A throwing thunk becomes `null` in the result array, with a
  warning logged. `parallel()` itself throws for invalid arguments: a non-array, a non-function
  item, or more items than `polyphase.maxItemsPerCall`.
- `pipeline(items, ...stages)` — runs every item through the same stages in sequence, with **no**
  barrier between stages: each stage `(prev, item, index)` receives the previous stage's result
  (or the item itself for the first stage). A throwing stage makes that item `null` and skips its
  later stages for that item only — other items keep advancing.
- `phase(title)` — groups the agents started after it under that phase for the live view. A title
  not declared in `meta.phases` becomes a dynamic phase (logged once).
- `log(...parts)` — writes a narrator line visible in the dock and inspector.
- `args` — the verbatim string passed to this call (or to `/<name> ...`).
- `meta` — the frozen meta object, readable in the body.
- `budget` — `{ total, spent(), remaining() }`; `spent()` is this run's total billable tokens as
  of the latest `agent()` reply.

Reserved names that a script must never redeclare: `agent`, `parallel`, `pipeline`, `phase`,
`log`, `args`, `budget`, `meta`.

### Determinism

The orchestrating script itself must be deterministic: `Math.random`, `Date.now()`, `Date()`,
`new Date()`, and `performance.now` all throw. `new Date(value)` still works. Non-determinism
inside an `agent()` call is fine — only the script around it is restricted.

### Caps and budget

- Up to `polyphase.maxAgentsPerRun` (default 200) `agent()` calls per run.
- Up to `polyphase.maxItemsPerCall` (default 1,024) items per `parallel()`/`pipeline()` call.
- Up to `polyphase.maxConcurrency` (default `clamp(cpuCount - 2, 2, 8)`) child processes running
  at once across the whole session — shared with `subagent` and duet triage, so a workflow and a
  concurrent `subagent` call compete for the same slots.
- A token budget (`budgetTokens` on the tool call, or `polyphase.defaultBudgetTokens`) is counted
  in billable tokens. Once spent tokens reach the budget, every unfinished agent in the run is
  cancelled and `agent()` starts returning `null`; a warning is logged once. Because output tokens
  for an in-flight response often only arrive at that response's end, the actual spend can
  overshoot the budget by up to one response per agent that was running at the moment the budget
  was reached — this is a bound, not a guarantee of an exact stop.
- A workflow cannot start another workflow, and a workflow's agents are excluded from the
  `duet_delegate` tool. See [Nesting depth](#nesting-depth).
- `polyphase.workflowTimeoutMs` (default `0`, no deadline) is a wall-clock deadline over the
  whole run, including time spent waiting on `agent()` calls. On expiry the script fails with a
  timeout and every agent still in flight is cancelled.

### Structured output

Set `opts.schema` on an `agent()` call to get a schema-validated object back instead of raw text.
Under the hood, the child process is told to call the `polyphase_result` tool (registered only in
that child, only for that call) with arguments matching the schema; its arguments are validated
against the schema back in the parent, and the validated value — unwrapped from a `{ value: ... }`
wrapper when the schema's root type isn't `object` — becomes `agent()`'s return value. The child
is instructed to call `polyphase_result` exactly once, as its last action; anything it says
afterward is not seen by the script. An agent that never calls it, or calls it with arguments that
fail validation, makes `agent()` return `null` and logs a notice.

## Saved workflows

A workflow saved as a `.js` file can be run directly with `/<name> [args]` or
`/workflow <name> [args]`, without the model writing it first.

- **Locations:** project workflows live in `.draht/workflows/*.js` (nearest ancestor directory,
  only when the project is trusted — see [Permissions](#permissions)); user workflows live in
  `<agent-dir>/workflows/*.js` (`~/.draht/agent/workflows` by default). A project workflow with the
  same name overrides a user workflow of that name.
- **Naming:** the file's basename (without `.js`) must match the same pattern as `meta.name`
  (`^[a-z][a-z0-9-]{0,47}$`); a file that doesn't is skipped with a warning. If `meta.name` doesn't
  match the basename, the basename still wins, with an informational note.
- **Size:** files over 256 KiB are skipped.
- **Collisions.** `/<name>` is not registered when `<name>` collides with a built-in command, an
  extension command or prompt template, a skill (`skill:<name>`), or a reserved polyphase name
  (`workflow`, `workflows`, `polyphase`); the workflow is still runnable through
  `/workflow <name>`, and one aggregated warning names every skipped workflow and its conflict.
- **`/workflow [name] [args]`** with no name opens a picker (TUI) or lists saved workflows and
  diagnostics (non-TUI); choosing "Describe a new workflow…" fills the editor with the keyword so
  the model can write one.
- **`/workflows [list]`** opens the inspector's runs view (TUI, no `list` argument) or lists live
  and archived runs plus saved workflows as plain text.

### Command-run results

A workflow started from `/<name>` or `/workflow` is **host-side**: it runs independently of any
agent turn, is cancelled only from the inspector or on session shutdown, and never blocks on the
model. When it finishes, its result is appended to the conversation as a custom message (visible
in the transcript and to the model on its next turn) **without triggering a new model turn or
spending a paid request** — the model only sees it if and when it is prompted again.

In print mode, the same custom message is recorded, but nothing from it is written to the
process's stdout output: the final text a `draht -p` invocation prints is the model's own last
response, not a background command-run result that may finish after (or without) a model turn.

Command-run token and dollar cost are shown in the dock, the inspector, and the result message,
but are **not** added to the session footer's running totals (the footer has no API for an
extension to append usage outside a model turn).

## Permissions

Each `workflow` tool call and each `/<name>`/`/workflow` command run goes through the same
permission gate as every other tool call: an explicit `allow`/`deny` rule in `.draht/permissions.yml`
applies as written; otherwise the call needs approval, shown with the workflow's name, phases
(with any per-phase model), source, truncated args, and limits (concurrency, max agents, budget).
A `workflow` tool call with an invalid `meta` block still needs approval, but is described as such
and fails immediately once approved; a `/<name>`/`/workflow` command run instead rejects an
invalid `meta` block up front, before the gate. With no UI available (print or JSON, or any other
headless caller) and no matching rule, the call is blocked rather than left waiting; RPC mode has
a UI context, so it forwards the approval to the client as a `confirm` request instead.

Saved workflows under `.draht/workflows` require project trust, the same as `.draht/agents`: a
project that only contains a `workflows` directory under `.draht` still triggers the trust prompt,
because a saved workflow can start subagents just like a saved agent definition can.

**Blocked tool calls inside subagents.** A subagent process cannot show an approval prompt of its
own (there is no UI in a non-interactive child), so by default any of its tool calls that would
otherwise need approval are blocked instead, and surfaced with a warning line, a `⚠` glyph in the
row, and a note in the parent-model result text listing a few blocked samples. The note's own hint
names `/permissions auto` and `/yolo` as remedies, but typing either into the parent session only
changes that session's own permission mode — it never reaches an already-running or future
subagent, which reads its mode from the `DRAHT_PERMISSION_MODE` environment variable at startup
(inherited from whatever started the parent draht process; unset means `default`, the most
restrictive mode). The remedies that actually work are an explicit `allow` rule in
`permissions.yml`, or setting `DRAHT_PERMISSION_MODE` before launching draht.

## Nesting depth

`polyphase.maxDepth` (default 2) limits how many levels of subagent-starts-a-subagent are
possible: a child at that depth is spawned without the `subagent` tool at all, so it cannot start
grandchildren. Independently of depth, the `workflow` and `duet_delegate` tools are always
excluded from every child process — a subagent (or a workflow's agent) can never start a workflow
or a duet triage batch of its own, regardless of `maxDepth`.

## Non-TUI behavior and the details schema

Outside the TUI (print, JSON, RPC), there is no dock, no inspector, and no terminal-input
listener — polyphase's UI installer is inert in those modes. What still works:

- the keyword and `/workflow name` (and saved `/<name>` commands);
- `/workflows` as plain text instead of the inspector;
- the final parent-model result text (see [Parent-model results](#parent-model-results));
- in `json`/RPC-style streaming, `tool_execution_update` partial results carrying a short status
  text (at most 20 lines of 120 characters) and the same bounded details object described below,
  throttled to about once per second per run, with state transitions (an agent finishing, a tool
  call getting blocked) emitted promptly instead of waiting out that interval.

**The persisted `details` schema.** Every `subagent` and `workflow` tool result, and every
command-run custom message, carries a `details` object with `v: 1`: a run summary (kind, status,
timing, phases for workflows), one entry per agent (model, status, token/cost totals, a bounded
output preview), and run totals. Final details are capped at 16 KiB; partial (in-progress)
details are capped at 8 KiB and additionally carry a `now` line per agent that final details omit.
When a run has far more agents or output than fits, successive levels of detail are dropped (long
agent output, then per-agent tool-call breakdowns, then low-priority agents entirely) rather than
truncating in a way that would hide a failure — failed, running, and queued agents are kept
preferentially over agents that finished cleanly. Resuming a session (`/resume`, a fork, or a
restart after a crash) rebuilds the final tool-row block from this persisted object only, so a
resumed row renders identically to how it looked when the run finished; sessions recorded before
polyphase existed have no (or an empty) `details` object and fall back to a legacy renderer.

## Settings and environment variables

All settings live under the `polyphase` key — see [Settings Reference](settings.md). The two
internal environment variables children use to coordinate with their parent
(`DRAHT_POLYPHASE_DEPTH`, `DRAHT_POLYPHASE_SCHEMA_FILE`) are listed in
[Environment Variables](environment-variables.md); you should not need to set either by hand.
