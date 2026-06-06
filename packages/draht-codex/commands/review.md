---
description: Code review and security audit of recent changes (parallel reviewer + security-auditor + optional spec-reviewer)
argument-hint: "[scope]"
allowed-tools: Bash, Read, Task
---

# /review

Code review and security audit of recent changes, using subagents for parallel analysis.

Scope: $ARGUMENTS

If no scope given, reviews all recent uncommitted changes.

> **Tool note**: For subagents, spawn Codex subagents and dispatch multiple in parallel (single assistant turn = multiple Codex subagent calls).

## Atomic Reasoning

Before reviewing, decompose code changes into atomic reasoning units:

**For each changed file:**
1. **State the logical component** — What does this change do? What problem does it solve? What behavior does it add/modify?
2. **Validate independence** — Does this change have side effects? Does it affect other modules? Are there hidden dependencies?
3. **Verify correctness** — Is this change correct? Type-safe? Secure? Does it follow conventions? What could go wrong?

**Synthesize review strategy:**
- Group changes by concern (correctness, security, style, spec compliance)
- Prioritize findings (critical, important, minor)
- Identify patterns across multiple files
- Check domain language compliance and bounded context boundaries

## Steps
1. Identify the scope:
   - If argument given: use those files/directories/description as scope
   - If no argument: run `git diff --stat` and `git diff --cached --stat` to find changes
2. Determine the list of changed files and produce a scope summary.
   - Before reviewing, run `draht-tools graph-context <changed-files>` and `draht-tools graph-impact <changed-files>` for affected contexts + boundary/layer violations (if `.planning/codebase/MAP.json` is absent, run `draht-tools map-graph` first).
   - Codex subagents cannot run draht-tools: paste the affected-contexts / boundary-violation summary into the reviewer and security-auditor prompts below.

3. **Detect spec context.** Look for a relevant plan in scope:
   - If `$ARGUMENTS` mentions a phase/task/plan number → load that PLAN.md
   - If `.planning/STATE.md` references an in-progress phase → check its plans for tasks matching the diff
   - If no plan applies → spec-reviewer is skipped (ad-hoc review only)

4. **Delegate to subagents in parallel via Codex subagents** (dispatch all in the same assistant turn):

   - **Codex subagent** with ``reviewer` agent prompt` and prompt:
     ```
     Review the following code changes for correctness, type safety, conventions, and potential issues. Scope: <scope summary and file list>. Read each changed file to understand the changes. For each finding: cite the exact file and line, explain the issue, suggest the fix. Prioritize: Critical (must fix) > Important (should fix) > Minor (style/optional). Check domain language compliance against `.planning/DOMAIN.md` if it exists.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

   - **Codex subagent** with ``security-auditor` agent prompt` and prompt:
     ```
     Audit the following code changes for security vulnerabilities. Scope: <scope summary and file list>. Read each changed file. Check for: injection risks, auth bypasses, secrets in code, unsafe deserialization, path traversal, prototype pollution. Report findings with severity, file, line, and recommendation.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

   - **(If spec context exists)** Codex subagent using the `spec-reviewer` agent prompt and prompt:
     ```
     Review the diff against the plan at <plan file path>. ONLY check spec compliance — does the diff implement exactly what the plan's <test>/<action>/<done> sections asked, no more, no less? Flag omissions and over-builds.

     Diff: <git diff range>

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
     ```

5. Read each subagent's final `STATUS:` line.
6. Collect and merge results from all dispatched subagents.
7. Produce a unified, prioritized findings report:
   - **Critical** — must fix before merge (security `BLOCKED`, spec gaps for required deliverables, correctness issues that cause data loss / crashes)
   - **Important** — should fix (bugs, type issues, spec over-builds, missing error handling)
   - **Minor** — style, naming, or optional improvements

## Reading STATUS

- Any subagent returning `STATUS: BLOCKED` → its findings escalate to Critical in the merged report
- `STATUS: NEEDS_CONTEXT` → provide missing info and re-dispatch that one agent; don't re-run the whole fan-out
- `STATUS: DONE` and `STATUS: DONE_WITH_CONCERNS` are normal terminal states; map their `Must fix` / `Should fix` / `Consider` outputs to Critical / Important / Minor in the merged report

## Rules
- Cite file paths and line numbers precisely
- Do not restate the diff — focus on findings
- If no issues found, state that explicitly
- spec-reviewer only runs when a spec exists — ad-hoc reviews skip it
