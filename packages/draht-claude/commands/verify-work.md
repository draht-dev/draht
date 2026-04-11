---
description: Acceptance testing of completed phase work (parallel verifier, security-auditor, and reviewer subagents)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /verify-work

Walk through acceptance testing of completed phase work, using subagents for parallel verification.

Phase: $1

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** and dispatch multiple in parallel (single assistant turn = multiple Task tool calls).

## Atomic Reasoning

Before verifying, decompose phase acceptance into atomic reasoning units:

**For each deliverable:**
1. **State the logical component** — What was this deliverable meant to produce? What user value does it provide?
2. **Validate independence** — Can this deliverable be tested independently? What are its dependencies?
3. **Verify correctness** — What tests prove it works? What edge cases must pass? What security concerns exist?

**Synthesize verification strategy:**
- Group parallel verification tasks (test suite, security audit, code review, domain compliance)
- Map each deliverable to specific test scenarios and acceptance criteria
- Identify critical vs optional checks
- Plan fix strategies for potential failures

## Steps
1. Run `draht-tools extract-deliverables $1` to get testable items

2. **Run parallel verification via the Task tool**:
   Dispatch these three subagents in parallel (single assistant turn, three Task tool calls):

   - **Task tool** with `subagent_type: "verifier"` and prompt:
     "Run the full test suite for this project. Check package.json for the test command. Record pass/fail counts. Then run any available lint and typecheck commands (e.g. npm run check, npm run lint, npx tsc --noEmit). Report all results with error details."

   - **Task tool** with `subagent_type: "security-auditor"` and prompt:
     "Audit the recent code changes (use git log and git diff to find them). Check for injection risks, auth bypasses, secrets in code, unsafe patterns. Report findings by severity."

   - **Task tool** with `subagent_type: "reviewer"` and prompt:
     "Review the recent code changes (use git log and git diff). Check domain language compliance against `.planning/DOMAIN.md` if it exists — scan for identifiers not in the glossary and cross-context boundary violations. Report findings."

3. Run the quality gate check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd-quality-gate.cjs"
   ```
4. Collect results from all subagents and the quality gate
5. Walk the user through each deliverable one at a time, incorporating findings from the parallel checks
6. Record results (pass/fail/partially/skip)
7. For failures: diagnose and create fix plans via `draht-tools create-fix-plan $1 P`
   - Fix plans MUST include a reproducing test that demonstrates the failure before any implementation
8. Write UAT report: `draht-tools write-uat $1`
   - Report must include: test health summary (pass/fail/coverage), security audit results, domain model status (any glossary violations), deliverable results
9. If all passed: mark phase complete.
   - If more phases remain in the milestone: tell the user to start a fresh session and run `/discuss-phase N+1`.
   - If ALL phases in the milestone are complete: tell the user to start a fresh session and run `/next-milestone`.
10. If failures: route to `/execute-phase $1 --gaps-only`

## Workflow
This is the last step in the per-phase cycle:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N
```

After verify-work passes:
- More phases remaining → `/discuss-phase N+1`
- ALL phases in milestone verified → `/next-milestone`

`/next-milestone` is ONLY for generating new phases after every phase in the current milestone is complete.
