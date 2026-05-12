---
description: Acceptance testing of completed phase work (parallel verifier + security-auditor + reviewer + spec-reviewer)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /verify-work

Walk through acceptance testing of completed phase work, using subagents for parallel verification — including a spec-compliance pass against the phase's plan files.

Phase: $1

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** and dispatch multiple in parallel (single assistant turn = multiple Task tool calls).

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
2. Discover the phase's plan files (`.planning/phases/<N>-*/<N>-NN-PLAN.md`). Each plan is the spec a spec-reviewer evaluates the diff against.

3. **Run parallel verification via the Task tool.** Dispatch four subagents in parallel (single assistant turn, four Task tool calls):

   - **Task tool** with `subagent_type: "verifier"` and prompt:
     ```
     Run the full test suite for this project. Check package.json for the test command. Record pass/fail counts. Then run any available lint and typecheck commands (e.g. npm run check, npm run lint, npx tsc --noEmit). Report all results with error details.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

   - **Task tool** with `subagent_type: "security-auditor"` and prompt:
     ```
     Audit the recent code changes (use git log and git diff to find them, limited to this phase's commit range). Check for injection risks, auth bypasses, secrets in code, unsafe patterns. Report findings by severity.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

   - **Task tool** with `subagent_type: "reviewer"` and prompt:
     ```
     Review the recent code changes for this phase (use git log and git diff to find them). Check domain language compliance against `.planning/DOMAIN.md` if it exists — scan for identifiers not in the glossary and cross-context boundary violations. Report findings as Must fix / Should fix / Consider.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

   - **Task tool** with `subagent_type: "spec-reviewer"` and prompt:
     ```
     Phase-level spec compliance check for phase $1. The phase has these plan files (each is a spec):
     <list of .planning/phases/<N>-*/<N>-NN-PLAN.md paths>

     For each plan, evaluate whether the phase's commits implement exactly what the plan's <task> elements asked — no missing tasks, no over-builds beyond what the spec called for. Use `git log --oneline <phase commit range>` and `git diff` to gather the implementation.

     Output a per-plan compliance verdict (✅ COMPLIANT / ❌ NON-COMPLIANT) with omissions and over-builds listed for each.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

4. Run the quality gate check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd-quality-gate.cjs"
   ```

5. **Read each subagent's `STATUS:` line and the quality gate exit code.** Treat the phase as failed if **any** of these is true:
   - `verifier` returns `STATUS: BLOCKED` (tests / lint / typecheck failed)
   - `security-auditor` returns `STATUS: BLOCKED` (Critical or High findings)
   - `spec-reviewer` returns `STATUS: BLOCKED` (any plan is non-compliant)
   - `reviewer` returns `STATUS: BLOCKED` (Must-fix correctness issues)
   - Quality gate exits non-zero

6. Walk the user through each deliverable one at a time, incorporating findings from all four subagents.

7. Record results (pass/fail/partially/skip).

8. For failures: diagnose and create fix plans via `draht-tools create-fix-plan $1 P`
   - Fix plans MUST include a reproducing test that demonstrates the failure before any implementation
   - Spec-reviewer omissions become explicit fix-plan tasks (one task per omission)

9. Write UAT report: `draht-tools write-uat $1`
   - Report must include: test health summary (pass/fail/coverage), security audit results, **spec compliance summary per plan**, domain model status (any glossary violations), deliverable results

10. If all passed: mark phase complete.
    - If more phases remain in the milestone: tell the user to start a fresh session and run `/discuss-phase N+1`.
    - If ALL phases in the milestone are complete: tell the user to start a fresh session and run `/next-milestone`.

11. If failures: route to `/execute-phase $1 --gaps-only`

## Why a phase-level spec-reviewer

`/execute-phase` already runs spec-reviewer **per task** before the next task starts. The phase-level pass here catches things the per-task loop can miss:

- A whole plan was skipped (no implementer ever ran on it)
- A task's commit was reverted or rebased away
- An out-of-scope drift that accumulated across multiple tasks

Cheap insurance — the diff already exists and the plans already exist; the agent just maps one to the other.

## Workflow
This is the last step in the per-phase cycle:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N
```

After verify-work passes:
- More phases remaining → `/discuss-phase N+1`
- ALL phases in milestone verified → `/next-milestone`

`/next-milestone` is ONLY for generating new phases after every phase in the current milestone is complete.
