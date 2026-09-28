---
description: "Audit test value or gate new tests at the owning behavior boundary"
---

# /test-audit

Audit the value of tests in a scope, or gate a proposed new test before it lands. Follow the evidence, retention, candidate-evidence, campaign, and handoff rules below.

## Usage
```
/test-audit [scope]
```

Scope: $ARGUMENTS

When no scope is supplied, inspect the current diff and the tests changed by it. Do not expand that into a repository-wide campaign.

## Rules

- New tests need one observable behavior or independent contract, a credible regression, an identified owner boundary, and a reason existing coverage does not already catch it.
- A bug regression must fail on the pre-fix code for the intended reason and pass after the owner-boundary repair.
- Never retain a production export, flag, wrapper, or dead path solely for testing. Move the test to a real boundary instead.
- Do not delete a test from a name, a grep, or a shallow read. Read its production owner, entry point, callers, overlapping coverage, history, and repository instructions first.
- Keep independently meaningful public API, protocol, configuration, migration, storage, security, platform, package, release, and architecture contracts. Static or slow is not a deletion reason.
- Uncertain candidates are findings, not cleanup work. Leave them in place and report the missing evidence.

## Steps

1. Read root and scoped `AGENTS.md` files, then load the `test-audit` skill.
2. Establish scope:
   - With `$ARGUMENTS`, resolve it to exact files, tests, or a subsystem.
   - Without arguments, run `git diff --stat`, `git diff --cached --stat`, and inspect only the changed tests and their owners.
3. For a proposed or changed test, apply the authoring gate from `test-audit` before editing it. If any answer is missing, stop and name the missing behavior, regression, owner, or coverage analysis.
4. For an audit, keep discovery read-only. For each candidate, record every required evidence field from the skill before changing anything.
5. Select at most one coherent owner-boundary batch. Remove obsolete test-only seams with the low-value test only when the evidence proves they have no production caller.
6. Run the smallest owner and sibling checks required by the repository, then its changed-file or release gate. Run `git diff --check` and inspect `git diff --numstat` before reporting.
7. Report the root cause, removed categories, production simplifications, retained false positives, actual proof run, separate production versus test/support LOC, and named follow-ups.

## Stop Conditions

Stop and report rather than editing when:

- a candidate lacks any required evidence;
- a retained test exposes a possible product bug;
- a broad subsystem campaign is requested but its `CAMPAIGN.md` procedure has not been read;
- the only proposed proof is implementation-coupled or duplicates a stronger owner-boundary test.
