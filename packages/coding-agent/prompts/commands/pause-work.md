---
description: "Create a handoff document for session continuity"
---

# /pause-work

Create a handoff document for session continuity.

## Usage
```
/pause-work
```

## Atomic Reasoning

Before pausing, decompose session state into atomic reasoning units:

1. **State the logical component** — What was accomplished this session? What is in-progress? What is the current phase/task?
2. **Validate independence** — Are there uncommitted changes? Are there blockers? What decisions were made?
3. **Verify correctness** — Is the current state stable? Can work resume cleanly? What context needs to be captured?

**Synthesize handoff document:**
- Capture current phase and status
- Document decisions and blockers
- Note next steps for resumption

## Steps
1. Run `draht-tools pause` — creates CONTINUE-HERE.md
2. Commit: `draht-tools commit-docs "pause work"`
