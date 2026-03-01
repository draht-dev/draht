# /verify-work

Walk through acceptance testing of completed phase work.

## Usage
```
/verify-work [N]
```

## Steps
1. Run full test suite and capture results:
   - Execute all tests (`bun test` or project-specific runner)
   - Record pass/fail counts — verification cannot proceed if tests are failing
2. Check domain language violations:
   - Load `.planning/DOMAIN.md` and extract all defined terms
   - Scan source files for PascalCase identifiers not present in the glossary
   - Flag any bounded context boundary violations (cross-context direct imports)
3. Run quality gate: `draht quality-gate --strict`
4. Run `draht extract-deliverables N` to get testable items
5. Walk user through each deliverable one at a time
6. Record results (pass/fail/partially/skip)
7. For failures: diagnose and create fix plans via `draht create-fix-plan N P`
   - Fix plans MUST include a reproducing test that demonstrates the failure before any implementation
8. Write UAT report: `draht write-uat N`
   - Report must include: test health summary (pass/fail/coverage), domain model status (any glossary violations), deliverable results
9. If all passed: mark phase complete
10. If failures: route to `execute-phase N --gaps-only`
