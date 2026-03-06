---
description: "Acceptance testing of completed phase work"
---

# /verify-work

Walk through acceptance testing of completed phase work, using subagents for parallel verification.

## Usage
```
/verify-work [N]
```

Phase: $1

## Steps
1. Run `draht-tools extract-deliverables $1` to get testable items
2. **Run parallel verification via subagents:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `verifier` agent: "Run the full test suite for this project. Check package.json for the test command. Record pass/fail counts. Then run any available lint and typecheck commands (e.g. npm run check, npm run lint, npx tsc --noEmit). Report all results with error details. Do NOT run draht, draht-tools, or pi commands."
   - `security-auditor` agent: "Audit the recent code changes (use git log and git diff to find them). Check for injection risks, auth bypasses, secrets in code, unsafe patterns. Report findings by severity. Do NOT run draht, draht-tools, or pi commands."
   - `reviewer` agent: "Review the recent code changes (use git log and git diff). Check domain language compliance against `.planning/DOMAIN.md` if it exists — scan for identifiers not in the glossary and cross-context boundary violations. Report findings. Do NOT run draht, draht-tools, or pi commands."

3. Collect results from all subagents
4. Walk user through each deliverable one at a time, incorporating findings from the parallel checks
5. Record results (pass/fail/partially/skip)
6. For failures: diagnose and create fix plans via `draht-tools create-fix-plan $1 P`
   - Fix plans MUST include a reproducing test that demonstrates the failure before any implementation
7. Write UAT report: `draht-tools write-uat $1`
   - Report must include: test health summary (pass/fail/coverage), security audit results, domain model status (any glossary violations), deliverable results
8. If all passed: mark phase complete.
   - If more phases remain in the milestone: tell the user to start a new session and run `/discuss-phase N+1`.
   - If ALL phases in the milestone are complete: tell the user to start a new session and run `/next-milestone`.
9. If failures: route to `execute-phase $1 --gaps-only`

## Workflow
This is the last step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N
```

After verify-work passes:
- More phases remaining → `/new` → `/discuss-phase N+1`
- ALL phases in milestone verified → `/new` → `/next-milestone`

`/next-milestone` is ONLY for generating new phases after every phase in the current milestone is complete.
