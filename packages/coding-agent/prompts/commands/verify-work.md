# /verify-work

Walk through acceptance testing of completed phase work.

## Usage
```
/verify-work [N]
```

## Steps
1. Run `draht extract-deliverables N` to get testable items
2. Walk user through each deliverable one at a time
3. Record results (pass/fail/partially/skip)
4. For failures: diagnose and create fix plans via `draht create-fix-plan N P`
5. Write UAT report: `draht write-uat N`
6. If all passed: mark phase complete
7. If failures: route to `execute-phase N --gaps-only`
