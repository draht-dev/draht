---
description: "Audit test value or gate new tests at the owning behavior boundary"
argument-hint: "[scope]"
---

# /test-audit

Audit the value of tests in a scope, or gate a proposed new test before it lands.
This prompt is self-contained; no additional test-audit skill is required.

Scope: $ARGUMENTS

When no scope is supplied, inspect the current diff and the tests changed by it.
Do not expand that into a repository-wide campaign.

## Authoring gate

Before adding or changing a test, identify:

1. The observable behavior, invariant, or independent contract it protects.
2. A credible regression that makes it fail.
3. The owning behavior boundary and why existing coverage cannot catch the failure.
4. Any production seam needed solely for testing. Move the test to a real boundary
   rather than adding a test-only export, flag, wrapper, or injection hook.

Missing answers block authoring. Prefer extending an existing table or fixture
rather than duplicating proof across layers. A bug regression must fail on the
pre-fix code for the intended reason and pass after the owner-boundary repair.

## Audit rules

- Read root and scoped `AGENTS.md` files and follow their approval and test rules.
- Read each candidate test in full, its production owner, entry point, callers,
  callees, sibling implementations, overlapping coverage, CI routing, and history.
  Inspect dependency source or types when the claim depends on that dependency.
- Hunt for assertion-free probes, self-comparisons, copied inventories, exact
  source greps, private-call assertions, duplicated contracts, mock-only behavior,
  expected values computed by the code under test, and negative controls that
  pass for an unrelated reason.
- Keep independently meaningful API, protocol, configuration, migration, storage,
  security, platform, default, prompt-byte, generated-code, package, release, and
  architecture contracts. Observable call ordering and credible regressions count.
  Source inspection can be an independent contract guard; static or slow is not
  a deletion reason.
- A retained test failing on the baseline may expose a product bug. Report and
  reproduce it rather than deleting it. Uncertain candidates remain findings.

## Candidate evidence

Keep discovery read-only. Before proposing an edit, record every field:

- Exact test name and location, and the failure it can detect.
- Non-test callers of the covered production or support seam.
- Stronger remaining owner-boundary proof, or why no proof is needed.
- Relevant history and the reason the test or seam exists.
- Production or test-support deletion unlocked.
- Risk and the focused validation command.

A missing field blocks the edit. Select one coherent owner-boundary batch;
remove obsolete test-only seams only when evidence proves they have no production
caller and repository rules permit removal. Preserve meaningful contracts at
canonical owners. Optimize for confidence, not deletion count.

## Broad campaigns

Only when explicitly requested: pin a baseline revision and record every in-scope
test's result; assign every test to an owner-boundary lane; mark each declaration
retain, repair, consolidate, or delete with evidence. Name the keeper for each
contract before editing. Serialize shared harness edits. Review deleted coverage
against keepers, independently when available and permitted. Prove restored
contracts with deliberate mutations, restoring source afterward. Keep product
fixes separate and prove them with failing controls. Reconcile base-branch
changes using repository conventions without losing newly added contracts.

## Validation and handoff

Run the smallest owner and sibling checks, then the repository's required gate.
Do not edit source or tests while their runner is active. For removed source
greps, run the executable or dry-run that owns the real contract. Run
`git diff --check` and inspect `git diff --numstat`.

Report removed categories, production simplifications, retained false positives,
proof actually run, separate production versus test/support LOC, review gaps,
and named follow-ups. Commit, push, or land only when authorized.
