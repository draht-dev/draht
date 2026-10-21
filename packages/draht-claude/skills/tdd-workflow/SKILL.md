---
name: tdd-workflow
description: Apply test-driven development when requested or required by the project, including regression-first repairs and red/green/refactor commit conventions.
---

# TDD Workflow

Use TDD for behavior that benefits from a regression contract and when the task or project requires it. Do not manufacture tests for documentation, generated output, configuration-only edits, or mechanical changes already covered by suitable checks.

1. Write a behavior-focused test and run it. Confirm failure exposes the intended missing behavior or defect, rather than a setup, syntax, or import error.
2. Implement the smallest complete change and run the test again.
3. Refactor when useful, keeping the relevant behavior checks green. Run project-required checks and broaden coverage for affected boundaries or new risks.

Use the public behavior or a meaningful boundary. A test that mirrors implementation details or passes only because all behavior is mocked is weak evidence. If a test already passes, investigate whether the behavior exists or the assertion misses the defect; do not alter working code merely to satisfy a ritual.

## Commits

Testing does not authorize commits. When the user or selected workflow authorizes recording the phases, stage explicit files and use plain Git:

- `git add <test-files> && git commit -m "red: <behavior>"`
- `git add <implementation-files> && git commit -m "green: <behavior>"`
- `git add <files> && git commit -m "refactor: <change>"`

Do not use docs-only commit tooling for source or tests. Never bypass required hooks or force push.

## Project conventions

Use established domain terms and boundaries when the project has them; TDD does not require `.planning/DOMAIN.md`, XML tasks, or an architectural reorganization. Existing GSD plans may supply `<test>`, `<action>`, and `<refactor>` sections as inputs to the same cycle.

The optional GSD post-task hook inspects commit prefixes for cycle violations according to `hooks.tddMode`. That history heuristic cannot prove a test failed before implementation. Preserve actual command outcomes and use configured deterministic checks for completion evidence.
