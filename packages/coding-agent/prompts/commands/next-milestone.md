---
description: "Plan the next milestone after ALL phases in the current milestone are complete"
---

# /next-milestone

Plan the next milestone after ALL phases in the current one are complete.

## Usage
```
/next-milestone
```

## Atomic Reasoning

Before planning the next milestone, decompose progress into atomic reasoning units:

**For each completed phase:**
1. **State the logical component** — What was built? What user value was delivered? What requirements were satisfied?
2. **Validate independence** — What worked well? What had issues? What assumptions proved wrong?
3. **Verify correctness** — What tests passed? What domain model evolved? What new knowledge emerged?

**Synthesize next milestone:**
- Assess which v1 requirements remain vs are complete
- Identify requirements that should be promoted or descoped based on learning
- Define 3-5 new phases with clear, testable goals
- Order phases by dependency and risk
- Map each phase to specific requirements and domain contexts

## Prerequisites
- `.planning/ROADMAP.md` must exist
- ALL phases in the current milestone must be complete (verified via /verify-work)
- This command is ONLY for milestone transitions — NOT for moving between phases within a milestone
- Between phases, use `/discuss-phase`, `/plan-phase`, `/execute-phase`, `/verify-work` — never `/next-milestone`

## Steps
1. Load project context:
   - Read `.planning/ROADMAP.md` — identify the completed milestone and its phases
   - Read `.planning/STATE.md` — understand current status
   - Read `.planning/REQUIREMENTS.md` — check which requirements are satisfied
   - Read `.planning/DOMAIN.md` (if exists) — review domain model for evolution needs
2. Review completed work:
   - Scan `.planning/phases/` for all UAT reports (`*-UAT.md`) and summaries (`*-SUMMARY.md`)
   - Note what was built, what worked well, what had issues
3. Assess requirements:
   - Which v1 requirements are now satisfied?
   - Which v1 requirements remain?
   - Should any v2 requirements be promoted based on what we learned?
   - Are there new requirements discovered during implementation?
4. Propose next milestone:
   - Define 3-5 phases, each with a clear goal (outcome, not activity)
   - Order phases by dependency
   - Map each phase to specific requirements
   - Estimate relative complexity
5. Present the proposed milestone for user approval before writing files
6. After approval:
   - Update `ROADMAP.md` with the new milestone and phases
   - Update `STATE.md` to reflect milestone transition
   - Update `REQUIREMENTS.md` if requirements changed
   - Update `DOMAIN.md` if domain model needs evolution
   - Commit: `draht-tools commit-docs "plan next milestone"`

## Rules
- Always review what was actually built, not just what was planned
- Be honest about requirements that slipped or changed scope
- Each phase goal must be testable — "user can X" not "implement Y"
