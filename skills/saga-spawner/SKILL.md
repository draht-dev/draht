---
name: saga-spawner
description: The saga graph reconciliation loop — unattended repo advancement as a cloud routine. The saga is a repository's long-running arc of work; a beat is its smallest independently shippable quantum, and the saga graph is a DAG of beats. The spawner is a stateless controller that diffs the graph (desired state) against merged PRs (actual state) and dispatches /orchestrate-style subagent teams to advance the saga one beat at a time. Use when the user mentions the saga graph, beats, spawner, routines, unattended or autonomous repo work, "work the backlog overnight", a self-optimizing repository, reconciliation runs, or when a cloud routine session must decide what to work on next. Also consult before designing any always-on or scheduled agent workflow for a draht repo.
---

# Saga Spawner

The **saga** is a repository's whole long-running arc of advancement — episodic, spanning many sessions, no author present. A **beat** is the smallest independently shippable quantum of that saga. The **saga graph** is a DAG of beats in `.planning/saga-graph.yaml`. The **spawner** is one reconciliation iteration over that graph, designed to run as a cloud routine: fresh session, fresh clone, no memory of the last run. It advances the saga one beat at a time.

The discipline: **the spawner is a controller, not a worker.** Desired state lives in the graph file. Actual state lives on GitHub (branches, PRs, merges). Each run observes both, computes the diff, dispatches work, lands PRs, and dies. Anything not written to the graph or to GitHub did not happen — this is `loop-workflow` recoverable state at repo scope, where each routine run is one iteration of a session-based loop.

## The Saga Graph (`.planning/saga-graph.yaml`)

```yaml
version: 1
config:
  max_in_flight: 3        # concurrency cap across all runs
  lease_ttl_hours: 12     # branch with no commits this old and no open PR = stale
  max_attempts: 2         # closed-unmerged PRs for a beat before auto-block
  audit: true             # idle-mode repo audit on/off
  audit_auto_risk: low    # highest risk tier an audit beat may run without approval
  audit_max_new: 3        # new audit beats per idle run, hard cap
  declined: []            # beat ids the human rejected — never re-emit
beats:
  - id: B-014
    title: Stream chunk persistence
    kind: planned          # planned | audit
    deps: [B-012]
    risk: medium           # low | medium | high
    approved: false        # required true before spawn when risk is high
    status: ready          # ready | done | blocked  (durable states only)
    attempts: 0
    spec: |
      One-paragraph spec of the shippable increment. The PR is mergeable
      exactly when this holds. Written like a PLAN.md objective.
    check: "npm run check && npx tsx ../../node_modules/vitest/dist/cli.js --run test/stream.test.ts"
```

Rules for the graph:

- A beat is well-cut only if its `check` can pass while every other beat's check fails — `atomic-reasoning` applied at saga scale. If two beats can only be verified together, they are one beat.
- `check` is a deterministic command whose exit code proves the spec. No check, no beat — a beat without a check is a wish, and per `loop-workflow` the loop is only as good as its check.
- Only `ready | done | blocked` are ever written to the file. In-flight and in-review are **derived** from GitHub each run, never stored — stored liveness lies the moment a session dies.
- `deps` are satisfied only by `status: done` **on main**. An unmerged PR satisfies nothing.
- Planned beats map 1:1 to roadmap phases where a `.planning/ROADMAP.md` exists; the spec then references the phase and the run drives the standard GSD per-phase cycle.

## Coordination: the branch is the lease

Concurrent runs are real — a nightly trigger and a PR-merge trigger can fire minutes apart. Git is the lock server:

- **Acquire**: `git push --force-with-lease=refs/heads/beat/<id>: origin <base-sha>:refs/heads/beat/<id>` — succeeds only if the ref did not exist. Push rejected = another run (or a human in a Herdr session) holds the beat. Skip it, no retry.
- **In-flight** = branch `beat/<id>` exists or an open PR from it exists.
- **Stale** = no commits within `lease_ttl_hours` and no open PR. Delete the branch; the beat is `ready` again next selection.
- The spawner never touches a branch outside `beat/*` and `saga/*`, never pushes `main`, never merges anything — including its own PRs. Merging is a human act (or the repo's own auto-merge policy; not the spawner's call).

## The Run

One reconciliation iteration. Every step is safe to kill and safe to repeat.

1. **Orient** — read `.planning/saga-graph.yaml` and `.planning/STATE.md`. `gh pr list --state all` filtered to `beat/*` heads. Graph-first per `gsd-workflow`: if `.planning/codebase/MAP.json` exists, use `draht-tools graph-context` / `graph-impact` before grepping.
2. **Reconcile** — compute truth from GitHub:
   - merged PR for `beat/<id>` → beat is `done` (the work PR already flipped it; verify main agrees)
   - closed-unmerged PR → `attempts + 1`; at `max_attempts` → `status: blocked` (needs human)
   - stale leases → delete branch
   - durable mutations (attempts, blocked flips, new audit beats) land as one graph-file-only PR from `saga/reconcile-<YYYYMMDD-HHmm>`. No mutations, no PR.
3. **Select** — ready set = `status: ready` ∧ all deps `done` ∧ (`risk` < high ∨ `approved`) ∧ not in-flight. Order riskiest-first — highest uncertainty × blast radius fails the graph cheapest, before effort is sunk into work it would obsolete (`/orchestrate` rule). Take up to `max_in_flight − |in-flight|`. Zero selected and zero in-flight → **Idle mode** below.
4. **Spawn** — per selected beat: acquire the lease, then drive the inner cycle on the branch with your host's subagent mechanism, `/orchestrate` discipline throughout:
   - `architect` turns the spec into an atomic plan (PLAN.md task XML where a `.planning/` project exists)
   - `implementer` fan-out per plan — TDD red → green → refactor inside each task; tasks within a plan sequential, independent plans parallel
   - two-stage review: `spec-reviewer` first, `reviewer` second — never quality-review a spec-non-compliant diff
   - `verifier` runs the beat's `check` plus the suite; the orchestrating context **re-runs the check itself** — subagent claims are inputs, not verdicts (`verification-gate`)
   - `git-committer` produces atomic conventional commits; branch on every `STATUS:` line per the protocol — `BLOCKED` stops the beat, not the run
5. **Land** — one PR per beat via `gh pr create --body-file` (never `--body` with multi-line markdown). Title `beat(B-014): <title>`. Body: spec, evidence (quoted check output, agent STATUS lines), risk notes — outcome first, evidence second, risk last. The PR's final commit flips its own beat to `status: done`, so the merge event is itself the done-signal on main.
6. **Report** — end the session with the run summary in the same outcome/evidence/risk order: beats landed, beats skipped and why, mutations recorded, what remains unverified.

## Idle mode — the repo works on itself

Only when there are zero ready and zero in-flight beats. The spawner **audits, it never free-edits** — findings become beats, and only beats become diffs. This keeps the graph the single source of truth and makes "self-optimization" reviewable instead of churn.

Bounded, read-mostly audit pass:

| Probe | Source |
|---|---|
| Structural debt, god nodes | `draht-tools graph-hotspots`, `graph-clusters --surprising` |
| Coverage gaps | `.planning/TEST-STRATEGY.md` vs actual coverage |
| Docs drift | README / `docs/` claims vs current code |
| Dependency staleness | lockfile vs upstream, majors flagged high risk |
| Flaky or slow checks | `execution-log.jsonl`, CI history |

Emit at most `audit_max_new` findings as `kind: audit` beats in the reconcile PR — each with spec, check, risk tier, deps if ordering matters. Dedupe against existing beats and the `declined` list. `risk` ≤ `audit_auto_risk` beats are spawn-eligible next run; everything above waits for a human `approved: true`. A human deleting an audit beat moves its id to `declined` — it is never re-emitted.

## Bounds

Every loop needs a bound; an unbounded spawner is a bug, not ambition (`loop-workflow`).

| Bound | Mechanism |
|---|---|
| Per-beat retries | `max_attempts` closed-unmerged PRs → `blocked`, human required |
| Stall | same failure signature twice inside a beat → `BLOCKED`, do not re-dispatch on the same input |
| Concurrency | `max_in_flight` across all runs, enforced by lease count |
| Run size | routines carry daily run caps — batch all selectable beats into one run rather than one beat per run |
| Immutable checks | a beat's `check` and its tests never weaken inside a run; violation = revert + hard stop |

## Routine setup

One routine, three triggers combined:

- **Repo**: this repository. No other connectors required; `gh` auth ships with the routine's repo access.
- **Prompt**: `Load the saga-spawner skill and execute exactly one reconciliation run over .planning/saga-graph.yaml. Advance the saga; land beat PRs; never merge.`
- **Scheduled** — nightly heartbeat: reconcile, spawn, audit when idle.
- **GitHub trigger** — on merged PRs targeting main: a merged `beat/*` PR is precisely the moment dependents unblock; the run picks them up immediately instead of waiting for the next tick. Merges of reconcile PRs activate newly approved audit beats the same way.
- **API trigger** — the per-routine endpoint for manual pokes: a Herdr session that just merged something, an n8n flow, a deploy hook.

Run this command's session on the strongest tier and let workers execute on the executor tier — the spawner is pure steering, its tokens are the ones that decide where all the volume tokens go (`model-tiering`).

## Interaction with other disciplines

- `loop-workflow` — the spawner is the session-based loop at repo scope; consult it before adding any retry behaviour here
- `atomic-reasoning` — cuts the beats; the well-cut test above is its acceptance bar
- `gsd-workflow` — supplies the inner per-beat cycle and the `.planning/` structure beats map onto
- `verification-gate` — evidence labeling for everything quoted in PR bodies and run reports
- `model-tiering` — orchestrator/executor economics for the fan-out

## Key rules

- GitHub is truth; the graph file is the plan plus a durable cache of it
- The branch is the lease; push-to-create is the lock
- Never push main, never merge, never touch branches outside `beat/*` and `saga/*`
- No check, no beat; deps satisfied only by `done` on main
- Idle mode emits beats, never diffs
- Every run must be killable and repeatable with no lost state
