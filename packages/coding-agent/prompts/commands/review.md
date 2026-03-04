# /review

Ad-hoc code review and security audit of recent changes or a specific scope.

## Usage
```
/review [scope]
```

If no scope given, reviews all recent uncommitted changes.

## Steps
1. Identify the scope:
   - If argument given: review those files/directories/description
   - If no argument: run `git diff --stat` and `git diff --cached --stat` to find changes
2. For each changed file, examine:
   - Correctness: logic errors, off-by-one, null handling, error paths
   - Type safety: any `as` casts, `any` types, missing null checks
   - Conventions: naming, file organization, import style
   - Security: injection risks, auth bypasses, secrets in code, unsafe deserialization
   - Performance: unnecessary allocations, missing indexes, N+1 queries
3. Produce a prioritized findings report:
   - **Critical** — must fix before merge (security, data loss, crashes)
   - **Important** — should fix (bugs, type issues, missing error handling)
   - **Minor** — style, naming, or optional improvements
4. For each finding: cite the exact file and line, explain the issue, suggest the fix
