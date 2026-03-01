# /execute-phase

Execute all plans in a phase with atomic commits.

## Usage
```
/execute-phase [N] [--gaps-only]
```

## Steps
1. Run `draht discover-plans N` to find and order plans
2. For each plan in dependency order:
   a. Load plan: `draht read-plan N P`
   b. Execute each task:
      - Implement the code
      - Verify with the `<verify>` step
      - Commit: `draht commit-task N P T "task name"`
   c. Write summary: `draht write-summary N P`
3. Phase verification: `draht verify-phase N`
4. Update state: `draht update-state`
5. Final commit: `draht commit-docs "complete phase N execution"`

## Checkpoint Handling
- `type="auto"` → execute without pausing
- `type="checkpoint:human-verify"` → pause, show user, wait for confirmation
- `type="checkpoint:decision"` → pause, present options, wait for choice

## Flags
- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
