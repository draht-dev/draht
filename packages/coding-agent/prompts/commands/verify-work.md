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
8. If all passed: mark phase complete
9. If failures: route to `execute-phase $1 --gaps-only`
