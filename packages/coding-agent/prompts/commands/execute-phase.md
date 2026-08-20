---
description: "Execute all plans in a phase with atomic commits + per-task two-stage review"
---

# /execute-phase

Execute all plans in a phase with atomic commits, parallelizing independent plans via subagents. Each task is implemented, then **spec-reviewed**, then **quality-reviewed** before the next task begins.

## Usage
```
/execute-phase [N] [--gaps-only]
```

Phase: $1
Arguments: $ARGUMENTS

## Red Flags — STOP

STOP and report to the user instead of proceeding if **any** of these is true:

- Any plan file contains placeholder text: `[TBD]`, `[files]`, `[description]`, "appropriate error handling", "similar to Task N", or empty `<test>` / `<action>` / `<verify>` / `<done>` sections
- A plan has zero `<task>` elements
- `.planning/DOMAIN.md` is absent on a non-greenfield project
- The working tree is dirty with changes unrelated to this phase
- A subagent returns `STATUS: BLOCKED` — never retry blindly; report and ask the user

## RLM Routing for Oversize Inputs (`rlm: true`)

A plan's YAML frontmatter may declare `rlm: true` (alongside `phase`, `plan`, `depends_on`, `must_haves`). This flags that one or more of the plan's tasks reference input files that can be large enough to be worth deferring instead of reading directly.

- **Threshold: 200KB.** When a plan has `rlm: true` and a task's `<action>`/`<test>` references an input file at or above ~200KB on disk, the executing agent (implementer subagent) should call the `rlm_query` tool — `{ input: "<path|glob|http(s) URL|knowledge:<client-slug>>", query: "..." }` — instead of reading the file directly with the read tool. 200KB is roughly 50k tokens of plain text, a large enough bite out of the subagent's context budget to justify offloading it to a Recursive Language Model sub-session rather than reading it inline; files below the threshold should still be read directly as normal — don't reach for `rlm_query` on ordinary source files.
- This only applies to reading large *input* files referenced by the plan (fixtures, datasets, logs, generated artifacts, client knowledge bases). It never applies to the plan file itself, to code files being edited, or to test output — those are always read directly.
- If `rlm_query` is unavailable in the session (the `@draht/rlm-agent` extension isn't installed for this project), fall back to reading the file directly and note this in the task's `STATUS` report rather than failing the task.
- When dispatching Stage 1 (Implementer) below for a plan with `rlm: true`, carry this instruction into the subagent's prompt so it actually reaches the agent doing the reading — the orchestrator itself does not read task input files.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

Within each group of independent plans, dispatch the riskiest plan first (highest uncertainty × blast radius) — its failure invalidates the rest of the phase most cheaply, before effort has been sunk into work it would obsolete.

## Steps
1. Run `draht-tools discover-plans $1` to find and order plans
2. Run `draht-tools validate-plans $1` — if any plan has placeholders or missing sections, STOP and fix the plan first
3. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential
4. **Per-plan execution loop.** For each plan (parallel where independent, sequential where dependent), iterate over its `<task>` elements with a **three-stage** dispatch:

   ### Stage 1 — Implementer
   Use the `subagent` tool in **single mode** with the `implementer` agent. Prompt includes the full plan content + the TDD cycle instructions (template below). Read the final `STATUS:` line:
   - `DONE` → **re-derive before trusting**: a `DONE` that does not quote its verification output (test counts, command output) is treated as `DONE_WITH_CONCERNS` — run the task's `<verify>` step yourself and read the result before Stage 2. Subagent claims are inputs, not verdicts.
   - `DONE_WITH_CONCERNS` → if concerns are correctness-related, re-dispatch with a fix instruction; otherwise note and proceed.
   - `NEEDS_CONTEXT` → provide the missing info and re-dispatch.
   - `BLOCKED` → STOP, report to the user.

   ### Stage 2 — Spec-reviewer
   Use the `subagent` tool with the `spec-reviewer` agent. ONLY checks "does the diff cover exactly what the spec asked for". Prompt includes the task XML and the diff range.
   - `DONE` → go to Stage 3.
   - `DONE_WITH_CONCERNS` → note and proceed.
   - `BLOCKED` → re-dispatch implementer with the "Required Fixes" list; repeat Stage 1+2 until `DONE`. Never proceed to Stage 3 with a non-compliant diff. **Hard cap: 3 implementer re-dispatches per task (across Stage 2 and Stage 3 combined)** — at the cap, record the task as failed and STOP; report the disagreement to the user.

   ### Stage 3 — Reviewer (code quality)
   Use the `subagent` tool with the `reviewer` agent for code-quality review. Spec compliance is already ✅.
   - `DONE` → task complete; move to next task.
   - `DONE_WITH_CONCERNS` → log `Should fix` items; if any are correctness-critical, re-dispatch implementer.
   - `BLOCKED` → `Must fix` issues exist; re-dispatch implementer with the issue list. Repeat until `DONE` — subject to the same **hard cap of 3 re-dispatches per task**; at the cap, record the task as failed and STOP.

5. After all plans complete, run `draht-tools verify-phase $1` yourself (not the subagent)
6. Run `draht-tools update-state` yourself
7. Final commit: `draht-tools commit-docs "complete phase $1 execution"`
8. After execution, tell the user to start a new session and run `/verify-work $1`.

## Subagent Task Template (Stage 1: implementer)

Each implementer subagent receives a task like:

```
Execute this plan. Here is the full plan content:

<paste full plan XML here>

For each <task> in the plan, follow this TDD cycle:
1. RED — Write failing tests from <test>. Run the test runner, confirm they FAIL. Commit with: git add <test-files> && git commit -m "red: <description>"
2. GREEN — Write minimal implementation from <action> to make tests pass. Run tests, confirm PASS. Commit with: git add <files> && git commit -m "green: <task name>"
3. REFACTOR — Apply <refactor> improvements if any. Tests must stay green after each change. Commit with: git add <files> && git commit -m "refactor: <description>"
4. VERIFY — Run the <verify> step, confirm <done> criteria are met.

Domain rules: Use ubiquitous language from .planning/DOMAIN.md (read it). Do not import across bounded context boundaries.
Checkpoint handling: type="auto" → execute silently. type="checkpoint:human-verify" → stop and report back what was built. type="checkpoint:decision" → stop and report the options.
RLM routing: if this plan's frontmatter has `rlm: true`, use the `rlm_query` tool instead of reading directly any task input file at or above ~200KB (see "RLM Routing for Oversize Inputs" above for the full rule and fallback behavior).

Evidence rule: quote the decisive output of every test run and <verify> step in your report (pass/fail counts, exit codes, error text). Unquoted claims will be re-run by the orchestrator. If a plan instruction contradicts what you find in the code, stop and report NEEDS_CONTEXT — do not silently obey either side.

End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` per the agent contract.

Important: Do NOT run draht, draht-tools, draht help, or pi commands. Use only standard tools (read, bash, edit, write, grep, find, ls).
```

## Two-Stage Review Rationale

- **Spec compliance prevents over/under-building.** The spec-reviewer catches drift before quality review masks it.
- **Code quality runs only after spec ✅.** Never accept "close enough" on spec compliance.
- **Tasks within a plan are sequential** — review loop completes before next task starts.

## Parallelization Rules
- Plans sharing no files and having no dependency edges can run in parallel
- Inside a plan, tasks run sequentially with the three-stage loop
- Maximum parallel subagents: follow the subagent tool limits (max 8 tasks, 4 concurrent)
- If a parallel subagent fails, report which plan failed and continue with independent plans

## TDD Rules
- Never write implementation before a failing test exists
- If a test passes immediately after being written, it is not testing the right thing — fix it
- Red → Green → Refactor is not optional; skipping steps invalidates the safety net
- Each TDD phase gets its own commit so the history is auditable

## Domain Rules
- All identifiers (class names, method names, variables) must use the ubiquitous language from `.planning/DOMAIN.md`
- Do not import across bounded context boundaries directly — use domain events or ACL adapters
- If implementation reveals a missing domain term, stop and update DOMAIN.md before continuing

## Workflow
This is one step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N → /new → /discuss-phase N+1 → ...
```

After completing this command, tell the user to start a new session and run `/verify-work $1`.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Flags
- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
