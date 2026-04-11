---
description: Code review and security audit of recent changes (parallel reviewer + security-auditor subagents)
argument-hint: "[scope]"
allowed-tools: Bash, Read, Task
---

# /review

Code review and security audit of recent changes, using subagents for parallel analysis.

Scope: $ARGUMENTS

If no scope given, reviews all recent uncommitted changes.

> **Tool note**: For subagents, use the **Task tool** and dispatch multiple in parallel (single assistant turn = multiple Task tool calls).

## Atomic Reasoning

Before reviewing, decompose code changes into atomic reasoning units:

**For each changed file:**
1. **State the logical component** — What does this change do? What problem does it solve? What behavior does it add/modify?
2. **Validate independence** — Does this change have side effects? Does it affect other modules? Are there hidden dependencies?
3. **Verify correctness** — Is this change correct? Type-safe? Secure? Does it follow conventions? What could go wrong?

**Synthesize review strategy:**
- Group changes by concern (correctness, security, style)
- Prioritize findings (critical, important, minor)
- Identify patterns across multiple files
- Check domain language compliance and bounded context boundaries

## Steps
1. Identify the scope:
   - If argument given: use those files/directories/description as scope
   - If no argument: run `git diff --stat` and `git diff --cached --stat` to find changes
2. Determine the list of changed files and produce a scope summary

3. **Delegate to subagents in parallel via the Task tool** (dispatch both in the same assistant turn):

   - **Task tool** with `subagent_type: "reviewer"` and prompt:
     "Review the following code changes for correctness, type safety, conventions, and potential issues. Scope: <scope summary and file list>. Read each changed file to understand the changes. For each finding: cite the exact file and line, explain the issue, suggest the fix. Prioritize: Critical (must fix) > Important (should fix) > Minor (style/optional). Check domain language compliance against `.planning/DOMAIN.md` if it exists."

   - **Task tool** with `subagent_type: "security-auditor"` and prompt:
     "Audit the following code changes for security vulnerabilities. Scope: <scope summary and file list>. Read each changed file. Check for: injection risks, auth bypasses, secrets in code, unsafe deserialization, path traversal, prototype pollution. Report findings with severity, file, line, and recommendation."

4. Collect and merge results from both subagents
5. Produce a unified, prioritized findings report:
   - **Critical** — must fix before merge (security, data loss, crashes)
   - **Important** — should fix (bugs, type issues, missing error handling)
   - **Minor** — style, naming, or optional improvements

## Rules
- Cite file paths and line numbers precisely
- Do not restate the diff — focus on findings
- If no issues found, state that explicitly
