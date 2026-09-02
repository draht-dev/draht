---
description: Plan the next milestone after ALL phases in the current one are complete
allowed-tools: Bash, Read, Write, Edit
---

# /next-milestone

Plan the next milestone after ALL phases in the current one are complete.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Steps
1. Run `draht-tools verify-milestone` to ensure every phase in the current milestone is `complete`
2. If any phase is not complete, STOP and tell the user which phase needs attention
3. Read all phase reports in `.planning/phase-N-report.md` to extract lessons learned
4. Read the execution log `.planning/execution-log.jsonl` for failure patterns
4b. **Write the distilled lessons back**: append each durable lesson from steps 3-4 as a dated bullet to `.planning/STATE.md` under `## Lessons` (create the section before `## Blockers` if missing). Extraction that only informs this planning session evaporates; the `## Lessons` section is what future sessions actually reread.
5. Refresh the living map if stale: `draht-tools map-graph --quiet` (guarded — skip if the post-phase hook already refreshed), then `draht-tools graph-clusters --surprising`. Compare clusters / bounded contexts / entry points against the milestone start to surface architectural drift before planning the next milestone
6. Review `.planning/DOMAIN.md` — is it still accurate? Any terms to add/revise (esp. drift flagged in step 5)?
7. Review `.planning/TEST-STRATEGY.md` — any updates needed?
8. Questioning phase (whole frontier per round — numbered, each with a recommended answer):
   - What is the next milestone's goal?
   - What user-visible outcomes must be true by the end?
   - What is in vs out of scope?
9. Propose phases for the next milestone. Each phase must have:
   - A clear goal (outcome, not activity)
   - Mapped requirements
   - Acceptance criteria
10. Update `.planning/ROADMAP.md` with the new milestone header and phases (status: `pending`)
11. Update `.planning/REQUIREMENTS.md` with any new requirements
12. Commit: `draht-tools commit-docs "plan milestone <N>"`

## Rules
- Do not start planning phase details — that happens in `/discuss-phase` + `/plan-phase`
- Distinguish **verified-complete** (a UAT report shows observed passes) from **believed-complete** (someone said so) — only the former counts toward requirement satisfaction; the latter goes back on the list
- Respect lessons learned from the previous milestone — don't repeat mistakes
- Keep the next milestone focused — 3-6 phases is typical
- Order the new phases risk-first: the phase carrying the highest uncertainty × blast radius comes earliest, so a wrong bet invalidates the least downstream work
