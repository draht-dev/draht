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

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

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
   - **Write the distilled lessons back**: append each durable lesson as a dated bullet to `.planning/STATE.md` under `## Lessons` (create the section before `## Blockers` if missing) — extraction that only informs this session evaporates; the `## Lessons` section is what future sessions reread
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
- Distinguish **verified-complete** (a UAT report shows observed passes) from **believed-complete** (someone said so) — only the former counts toward requirement satisfaction; the latter goes back on the list
- Be honest about requirements that slipped or changed scope
- Each phase goal must be testable — "user can X" not "implement Y"
- Order the new phases risk-first: the phase carrying the highest uncertainty × blast radius comes earliest, so a wrong bet invalidates the least downstream work
