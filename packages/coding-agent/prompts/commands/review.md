---
description: "Code review and security audit of recent changes (parallel reviewer + security-auditor + optional spec-reviewer)"
---

# /review

Code review and security audit of recent changes, using subagents for parallel analysis.

## Usage
```
/review [scope]
```

Scope: $ARGUMENTS

If no scope given, reviews all recent uncommitted changes.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

Check domain language compliance and bounded context boundaries.

## Steps
1. Identify the scope:
   - If argument given: use those files/directories/description as scope
   - If no argument: run `git diff --stat` and `git diff --cached --stat` to find changes
2. Determine the list of changed files and produce a scope summary
3. **Detect spec context.** Look for a relevant plan:
   - If `$ARGUMENTS` mentions a phase/task/plan number → load that PLAN.md
   - If `.planning/STATE.md` references an in-progress phase → check its plans for tasks matching the diff
   - If no plan applies → spec-reviewer is skipped
4. **Delegate to subagents in parallel:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `reviewer` agent: "Review the following code changes for correctness, type safety, conventions, and potential issues. Scope: <scope summary and file list>. Read each changed file. For each finding: cite the exact file and line, explain the issue, suggest the fix. Prioritize: Critical / Important / Minor. Treat comment-heavy new code as a design defect, not a style nit: comments exist only for constraints the code cannot express — if new code needed narration to be understood (step-by-step comments, diff restatements, 'removed X' / 'this handles Y' breadcrumbs), report the finding as 'code needed narration' at Important or higher; the fix is rewriting the code until the comments are unnecessary, not deleting the comments. End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Do NOT run draht, draht-tools, or pi commands."
   - `security-auditor` agent: "Audit the following code changes for security vulnerabilities. Scope: <scope summary and file list>. Check injection, auth bypass, secrets, unsafe deserialization, path traversal, prototype pollution. Report severity / file / line / fix. End with `STATUS: ...`. Do NOT run draht, draht-tools, or pi commands."
   - **(If spec context exists)** `spec-reviewer` agent: "Review the diff against plan at <plan file path>. ONLY spec compliance — does the diff implement exactly what the <test>/<action>/<done> sections asked? Flag omissions and over-builds. End with `STATUS: ...`."

5. Read each subagent's final `STATUS:` line.
6. Collect and merge results.
7. **Refute before reporting.** For each Critical or Important finding, attempt to kill it yourself before it reaches the report: read the code path that would make it a false positive — an upstream guard clause, a type constraint, an existing test that covers the case. A finding that survives an honest refutation attempt is **confirmed** (you traced the failing path); one you couldn't confirm is downgraded and labeled **suspected**. Reporting unattacked findings trains readers to ignore the report.
8. Produce a unified, prioritized findings report. Verdict first: one line — mergeable or not, and why. Then findings:
   - **Critical** — must fix before merge (security `BLOCKED`, spec gaps for required deliverables, correctness issues that cause data loss / crashes)
   - **Important** — should fix (bugs, type issues, spec over-builds, missing error handling)
   - **Minor** — style, naming, optional improvements

   Each finding carries its label (confirmed/suspected). End with residual risk: what the review did NOT cover (files skipped, paths not traced) — a review that claims total coverage it doesn't have is worse than a scoped one.

## Reading STATUS
- Any `STATUS: BLOCKED` → its findings escalate to Critical in the merged report
- `STATUS: NEEDS_CONTEXT` → provide missing info and re-dispatch that one agent
- `STATUS: DONE` / `DONE_WITH_CONCERNS` are normal terminal states

## Rules
- Cite file paths and line numbers precisely
- Do not restate the diff — focus on findings
- If no issues found, state that explicitly
- spec-reviewer only runs when a spec exists — ad-hoc reviews skip it
