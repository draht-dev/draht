# @draht/rlm

Recursive Language Models (RLM) — the inference-time scaffold from Zhang,
Kraska, Khattab (2026), *Recursive Language Models* (arXiv:2512.24601):
root-LLM-produces-code → REPL-executes → truncated-stdout → history-append →
FINAL-check. Lets a root model answer questions about inputs far larger than
its own context window by writing Python that inspects, chunks, and searches
the content from inside a sandboxed REPL, optionally recursing into
sub-`llm_query` calls, instead of the caller ever loading the raw content
into a single prompt.

## When to prefer RLM over a normal agent read

Reach for RLM when the input genuinely doesn't fit the model's context
window, or fits only by truncating away content that might matter:

- A log file, dataset dump, or exported knowledge base that's tens or
  hundreds of megabytes — orders of magnitude past any model's window.
- A directory/glob of source files too large to read whole without evicting
  earlier conversation context.
- Any case where you'd otherwise have to guess which prefix/suffix/sample of
  the input to truncate to, and a wrong guess means missing the answer.

Don't reach for RLM when the input already fits comfortably in the model's
context window — a normal read is faster, cheaper, and easier to debug. RLM
trades one direct read for several extra model round trips (see below); that
trade only pays off when the alternative is truncation-induced information
loss, not just "this file is somewhat long."

## Cost envelope

A normal read is one call: the whole input goes into the prompt, the model
answers once. RLM is **not** universally cheaper than that — it's a
different trade:

- The root model makes one call per REPL step (a handful to a few dozen
  steps for a typical run), and each step's Python may itself call
  `llm_query(...)`, which is a *second* model call (typically to a smaller
  "rlm-sub" role — see `router-session.ts`'s `RlmRole`) that also costs
  money.
- So RLM's total cost is `sum(root-step costs) + sum(sub-call costs)` versus
  a baseline's single call. RLM wins when the baseline's single call would
  otherwise require either failing outright (input doesn't fit at all) or
  paying for a much larger context window / re-reading the input multiple
  times across a conversation to compensate for truncation — not in the
  general case.
- **Don't guess — measure.** `src/cost-comparison.ts`'s `compareCost()`
  computes both numbers for one trajectory: `rlmCostUsd` from the trajectory's
  own logged cost entries (`readCostLog`/`getSessionCosts` from
  `@draht/router`, filtered by `trajectoryId`), and `baselineCostUsd` as the
  estimated cost (via `@draht/router`'s `estimateCost`) of a single call that
  truncates the same content down to the target model's context window
  (first-N-characters-that-fit — a simple, named strategy, not a claim that
  it's the smartest possible truncation). Run it against a real trajectory ID
  before assuming RLM is the cheaper (or more expensive) option for your
  specific input/model pair; `.draht/rlm/cost-comparison-report.json` is
  where a comparison run writes its report.

## Observability: trajectory logs & replay

Every `createRouterBackedSession` run writes a newline-delimited JSON
trajectory log to `.draht/rlm/<trajectoryId>.jsonl` (`src/trajectory.ts`) —
one `TrajectoryStepEntry` per REPL step (its code, truncated stdout, error if
any, the sub-calls it triggered, and that step's own cost) plus one terminal
`TrajectoryFinalEntry` once the session resolves. `trajectoryId` is the same
ID already used to tag the session's `@draht/router` cost-log entries, so a
trajectory's logs and its cost accounting always correlate by the same key.

Because the whole run is on disk, it can be reconstructed with **zero LLM
calls**:

```bash
draht rlm replay <trajectory-id>
```

reads the JSONL log via `readTrajectory()` and prints the final answer (add a
verbose flag for the full step-by-step trace) — no router, no model, no
network access on that code path at all. Useful for auditing what a session
actually did, debugging a run that didn't reach `FINAL`, or reviewing cost
without re-running anything.

The `test/s-niah.test.ts` regression suite exercises recall at 10x and 100x a
mocked root model's context window (synthetic needle-in-haystack at ~4M and
~40M characters, against a scripted mock `rootLlm` — no real model calls) as
a standing check that the scaffold still finds a planted needle at scale.

## Worked example

Say `deploy.log` is a 40 MB deployment log and you need to know what caused
an outage buried somewhere in it — too large to paste into a normal prompt.
The same question, three ways:

**Interactive `/rlm` command** (inside a `draht` session):

```
/rlm deploy.log What caused the outage around the 03:00 UTC deploy?
```

**`draht rlm` CLI** (scriptable, one-shot):

```bash
draht rlm --input ./deploy.log --query "What caused the outage around the 03:00 UTC deploy?"
```

**`rlm_query` tool** (an agent defers the read itself, mid-session, instead
of loading the log into its own context):

```json
{
  "tool": "rlm_query",
  "input": {
    "input": "deploy.log",
    "query": "What caused the outage around the 03:00 UTC deploy?"
  }
}
```

All three share the same path under the hood: `parseInputArg`/`loadInput`
resolve `deploy.log` into content, `createRouterBackedSession` wraps it as
the REPL's `context` with the question prepended as a header, and the root
model writes Python to grep/chunk/search `context` — recursing into
`llm_query` sub-calls for individual chunks as needed — until it calls
`FINAL(...)`/`FINAL_VAR(...)` with the answer. `--input`/`input` also accepts
a glob (`"src/**/*.ts"`), an `http(s)://` URL, or `knowledge:<client-slug>`
for a named client knowledge base.

To check whether that particular run was worth it cost-wise, take the
`trajectoryId` of its `.draht/rlm/<trajectoryId>.jsonl` log (or the matching
`trajectoryId` field in `.draht/cost-log.jsonl`) and feed it into
`compareCost()` (see Cost envelope, above) rather than assuming either
direction.

## Development

```bash
npm install          # from repo root, resolves this workspace package
cd packages/rlm
npx tsc --noEmit     # typecheck
npm test             # vitest
```

## Package layout

- `src/session.ts` — `RlmSession` root loop (step/run, `FINAL`/`FINAL_VAR`
  sentinels, constant-size history).
- `src/router-session.ts` — `createRouterBackedSession`, the production
  `@draht/router`-backed factory (prompt-tier selection, cost logging,
  trajectory logging).
- `src/trajectory.ts` — trajectory JSONL append/read (this phase).
- `src/cost-comparison.ts` — RLM-vs-baseline cost harness (this phase).
- `src/loaders.ts` — `--input`/`/rlm <input>` source loaders (file, glob,
  URL, `knowledge:<slug>`).
- `src/prompts.ts` — tiered system-prompt templates, selected by the root
  model's context window.
- `python/repl_driver.py` — the sandboxed Python REPL driver.
- `packages/coding-agent/src/rlm-cli.ts` — `draht rlm` CLI subcommand.
- `packages/rlm-agent/` — `/rlm` command + `rlm_query` tool extension for
  normal agent sessions.

## AGENTS.md

RLM is a cross-cutting coding-agent capability, not a property of any single
generated project's stack — none of `packages/templates/src/*.md`'s
per-stack templates (Astro, Go/gRPC, SST TypeScript) is the right home for a
"when to use RLM" note, and this repo's own root `AGENTS.md` is a
contributor-workflow doc, not a feature reference. This README is the
primary documentation surface for RLM; no template changes were made.
