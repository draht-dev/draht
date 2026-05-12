---
description: "Acceptance testing of completed phase work (parallel verifier + security-auditor + reviewer + spec-reviewer)"
---

# /verify-work

Walk through acceptance testing of completed phase work, using subagents for parallel verification — including a spec-compliance pass against the phase's plan files.

## Usage
```
/verify-work [N]
```

Phase: $1

## Atomic Reasoning

Before verifying, decompose phase acceptance into atomic reasoning units:

**For each deliverable:**
1. **State the logical component** — What was this deliverable meant to produce? What user value does it provide?
2. **Validate independence** — Can this deliverable be tested independently? What are its dependencies?
3. **Verify correctness** — What tests prove it works? What edge cases must pass? What security concerns exist?

**Synthesize verification strategy:**
- Group parallel verification tasks (test suite, security audit, code review, spec compliance, domain compliance)
- Map each deliverable to its plan file (the spec)
- Identify critical vs optional checks
- Plan fix strategies for potential failures

## Steps
1. Run `draht-tools extract-deliverables $1` to get testable items
2. Discover the phase's plan files (`.planning/phases/<N>-*/<N>-NN-PLAN.md`). Each plan is the spec the spec-reviewer evaluates against.
3. **Run parallel verification via subagents:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `verifier` agent: "Run the full test suite for this project. Check package.json for the test command. Record pass/fail counts. Then run any available lint and typecheck commands (e.g. npm run check, npm run lint, npx tsc --noEmit). Report all results with error details. End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Do NOT run draht, draht-tools, or pi commands."
   - `security-auditor` agent: "Audit the recent code changes (use git log and git diff, scoped to this phase's commits). Check for injection risks, auth bypasses, secrets in code, unsafe patterns. Report findings by severity. End with `STATUS: ...`. Do NOT run draht, draht-tools, or pi commands."
   - `reviewer` agent: "Review the recent code changes for this phase. Check domain language compliance against `.planning/DOMAIN.md` if it exists — scan for identifiers not in the glossary and cross-context boundary violations. Report Must fix / Should fix / Consider. End with `STATUS: ...`. Do NOT run draht, draht-tools, or pi commands."
   - `spec-reviewer` agent: "Phase-level spec compliance check for phase $1. The phase has these plan files (each is a spec): <list of .planning/phases/<N>-*/<N>-NN-PLAN.md paths>. For each plan, evaluate whether the phase's commits implement exactly what the plan's <task> elements asked — no missing tasks, no over-builds. Use git log and git diff against the phase commit range. Output a per-plan compliance verdict with omissions and over-builds. End with `STATUS: ...`."

4. **Read each subagent's `STATUS:` line.** Treat the phase as failed if any of these is `BLOCKED`:
   - `verifier` (tests / lint / typecheck failed)
   - `security-auditor` (Critical or High findings)
   - `spec-reviewer` (any plan non-compliant)
   - `reviewer` (Must-fix correctness issues)

5. Collect results and walk user through each deliverable, incorporating findings.
6. Record results (pass/fail/partially/skip).
7. For failures: diagnose and create fix plans via `draht-tools create-fix-plan $1 P`
   - Fix plans MUST include a reproducing test that demonstrates the failure before any implementation
   - Spec-reviewer omissions become explicit fix-plan tasks (one task per omission)
8. Write UAT report: `draht-tools write-uat $1`
   - Report must include: test health summary (pass/fail/coverage), security audit results, **spec compliance summary per plan**, domain model status (any glossary violations), deliverable results
9. If all passed: mark phase complete.
   - If more phases remain in the milestone: tell the user to start a new session and run `/discuss-phase N+1`.
   - If ALL phases in the milestone are complete: tell the user to start a new session and run `/next-milestone`.
10. If failures: route to `execute-phase $1 --gaps-only`

## Why a phase-level spec-reviewer

`/execute-phase` already runs spec-reviewer **per task** before the next task starts. The phase-level pass here catches things the per-task loop can miss:
- A whole plan was skipped (no implementer ever ran on it)
- A task's commit was reverted or rebased away
- Out-of-scope drift that accumulated across multiple tasks

Cheap insurance — the diff and plans already exist; the agent maps one to the other.

## Workflow
This is the last step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N
```

After verify-work passes:
- More phases remaining → `/new` → `/discuss-phase N+1`
- ALL phases in milestone verified → `/new` → `/next-milestone`

`/next-milestone` is ONLY for generating new phases after every phase in the current milestone is complete.
