---
description: "Show current project status"
---

# /progress

Show current project status.

## Usage
```
/progress
```

## Atomic Reasoning

Before checking progress, decompose project state into atomic reasoning units:

1. **State the logical component** — What milestone are we in? What phase is active? What work is complete vs in-progress?
2. **Validate independence** — Are there blockers? Are phases in the correct sequence? Is anything waiting on external input?
3. **Verify correctness** — Does the reported state match reality? Are all verified phases truly complete? Are there unreported issues?

**Synthesize status understanding:**
- Identify where we are in the roadmap
- Assess momentum and blockers
- Determine next action

## Steps
1. Run `draht-tools progress` — outputs formatted status
2. Display the result as-is
