---
name: tdd-workflow
description: Test-driven development discipline — red→green→refactor cycle, commit conventions (red:, green:, refactor:), TDD cycle violations, reproducing tests before fixes, and how to write tests that actually drive design. Use whenever the user is writing code that has testable behaviour, fixing bugs, or asks about TDD.
---

# TDD Workflow

Draht enforces strict test-driven development through commit conventions, post-task hooks, and the plan task format.

## The Cycle

### RED — Write a failing test
1. Write a test that describes the behaviour you want
2. Run the test runner — it MUST fail for the right reason (not a syntax error, not a missing import)
3. Commit with prefix `red:`
   ```
   git add <test-files>
   git commit -m "red: <what the test proves>"
   ```

### GREEN — Make it pass with the smallest possible change
1. Write the minimum implementation that makes the failing test pass
2. Run the test — confirm it passes
3. Run the full test suite — confirm no regressions
4. Commit with prefix `green:`
   ```
   git add <impl-files>
   git commit -m "green: <task name>"
   ```

### REFACTOR — Improve structure while staying green
1. Tests must stay green after every change — run them often
2. Extract value objects, push logic into domain layer, remove duplication
3. Keep to the ubiquitous language from `.planning/DOMAIN.md`
4. Commit with prefix `refactor:`
   ```
   git add <files>
   git commit -m "refactor: <what was improved>"
   ```

## Rules

1. **Never write implementation before a failing test.** If you find yourself writing code that doesn't have a failing test waiting for it, stop and write the test first.

2. **A test that passes on first run is suspect.** It means you're not testing what you think. Make it fail by breaking the implementation temporarily — does it fail? If not, the test is useless.

3. **One red → one green → optional refactor.** Keep cycles small. A red commit with 20 failing tests is too big.

4. **Test behaviour, not implementation.** Write tests against the public API. Tests that mock everything are tests of the mocks.

5. **Domain tests use domain language.** Class names, test names, fixture names must match `.planning/DOMAIN.md` if it exists. Domain tests read like specs.

6. **Fix bugs with a reproducing test first.** No exceptions. The test must fail before the fix, pass after.

## TDD Cycle Violations

The post-task hook (`gsd-post-task.cjs`) checks commit history for cycle violations:

- A `green:` commit with no preceding `red:` commit for the same task → violation
- In `strict` mode: the hook aborts execution
- In `advisory` mode: the hook logs a warning to `.planning/execution-log.jsonl`

Set the mode in `.planning/config.json`:
```json
{ "hooks": { "tddMode": "strict" } }
```

## When to Skip the Cycle

Only skip TDD for:
- Pure configuration (tsconfig, biome, prettier)
- Documentation-only changes
- Generated code (auto-generated clients, schema bindings)
- Mechanical refactors with no behaviour change (e.g., rename)

Never skip for:
- Bug fixes
- New features
- Changes to domain logic
- Changes to APIs

## The Plan Task Format Drives TDD

Plan tasks use `<test>`, `<action>`, `<refactor>` sections precisely to force the cycle:

```xml
<task type="auto">
  <n>Add user authentication</n>
  <test>
    RED phase: Write failing tests FIRST.
    - test/auth.test.ts: valid credentials → returns session token
    - test/auth.test.ts: invalid password → throws UnauthorizedError
    - test/auth.test.ts: expired token → returns null
  </test>
  <action>
    GREEN phase: Minimal implementation.
    - src/auth/login.ts: verify password hash, return token
    - src/auth/session.ts: read/write session store
  </action>
  <refactor>
    Extract password verification into domain layer. Keep session IO at the boundary.
  </refactor>
</task>
```

When executing, the implementer subagent follows this order strictly. Commits get the `red:` / `green:` / `refactor:` prefixes automatically.

## Coverage Goals

`.planning/config.json` sets the threshold:
```json
{ "hooks": { "coverageThreshold": 80 } }
```

The `gsd-quality-gate.cjs` script enforces this at verification time. Coverage is a floor, not a target — aim for the meaningful paths.

Target coverage by layer, not by line count: run `draht-tools graph-hotspots` / `draht-tools graph-clusters` against `.planning/codebase/MAP.json` and cover the domain/application layers (and god nodes) first. A task's `<files>` should sit in one bounded context — confirm with `draht-tools graph-context <files>` before writing tests; files spanning contexts mean the task is too broad to test cleanly.
