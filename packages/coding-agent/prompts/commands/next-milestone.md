---
description: "Plan the next milestone after current one completes"
---

# /next-milestone

Plan the next milestone after the current one is complete.

## Usage
```
/next-milestone
```

## Prerequisites
- `.planning/ROADMAP.md` must exist
- Current milestone should be complete or nearly complete

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
