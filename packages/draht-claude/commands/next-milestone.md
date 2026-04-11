---
description: Plan the next milestone after ALL phases in the current one are complete
allowed-tools: Bash, Read, Write, Edit
---

# /next-milestone

Plan the next milestone after ALL phases in the current one are complete.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Atomic Reasoning

Before planning the next milestone, decompose progress into atomic reasoning units:

**For each completed phase:**
1. **State the logical component** — What was built? What user value was delivered? What requirements were satisfied?
2. **Validate independence** — What worked well? What had issues? What assumptions proved wrong?
3. **Verify correctness** — Is every phase truly complete? Are there lingering fix plans? Is the codebase healthy?

**Synthesize milestone strategy:**
- Identify gaps from the current milestone
- Derive new requirements from lessons learned
- Group into a coherent next milestone with testable phase goals
- Ensure domain model and test strategy still reflect reality

## Steps
1. Run `draht-tools verify-milestone` to ensure every phase in the current milestone is `complete`
2. If any phase is not complete, STOP and tell the user which phase needs attention
3. Read all phase reports in `.planning/phase-N-report.md` to extract lessons learned
4. Read the execution log `.planning/execution-log.jsonl` for failure patterns
5. Review `.planning/DOMAIN.md` — is it still accurate? Any terms to add/revise?
6. Review `.planning/TEST-STRATEGY.md` — any updates needed?
7. Questioning phase (1-2 questions at a time):
   - What is the next milestone's goal?
   - What user-visible outcomes must be true by the end?
   - What is in vs out of scope?
8. Propose phases for the next milestone. Each phase must have:
   - A clear goal (outcome, not activity)
   - Mapped requirements
   - Acceptance criteria
9. Update `.planning/ROADMAP.md` with the new milestone header and phases (status: `pending`)
10. Update `.planning/REQUIREMENTS.md` with any new requirements
11. Commit: `draht-tools commit-docs "plan milestone <N>"`

## Rules
- Do not start planning phase details — that happens in `/discuss-phase` + `/plan-phase`
- Respect lessons learned from the previous milestone — don't repeat mistakes
- Keep the next milestone focused — 3-6 phases is typical
