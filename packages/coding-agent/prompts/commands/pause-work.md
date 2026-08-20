---
description: "Create a handoff document for session continuity"
---

# /pause-work

Create a handoff document for session continuity.

## Usage
```
/pause-work
```

## Steps
1. Run `draht-tools pause` — creates CONTINUE-HERE.md
2. **Distill lessons before the context is lost**: for anything this session tried that failed, or an approach that worked against expectations, append one dated bullet to `.planning/STATE.md` under `## Lessons` (create the section before `## Blockers` if missing). Lessons name what to do differently — "runner hits TLS issue in PowerShell, use bash", not "had problems with tests".
3. Commit: `draht-tools commit-docs "pause work"`
