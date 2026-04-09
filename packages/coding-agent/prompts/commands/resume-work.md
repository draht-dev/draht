---
description: "Resume from last session state"
---

# /resume-work

Resume from last session state.

## Usage
```
/resume-work
```

## Atomic Reasoning

Before resuming, decompose handoff context into atomic reasoning units:

1. **State the logical component** — What phase/task was active? What was the last accomplishment? What decisions were made?
2. **Validate independence** — Are there blockers? What changed since the pause? Is the codebase in the expected state?
3. **Verify correctness** — Is the handoff document complete? Does the current state match what was documented? Can work continue safely?

**Synthesize resumption plan:**
- Understand current context
- Identify next action
- Confirm no conflicts or state drift

## Steps
1. Run `draht-tools resume` — loads CONTINUE-HERE.md or STATE.md
2. Display context and ask to continue
3. Delete CONTINUE-HERE.md after confirmation
