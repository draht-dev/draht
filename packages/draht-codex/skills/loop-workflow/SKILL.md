---
name: loop-workflow
description: Design bounded agent loops with explicit stopping conditions, deterministic checks, and recoverable progress.
---

# Loop Workflow

Use a loop when repeated work has an observable stopping condition. A small task can finish in one pass; GSD phases and fresh sessions are optional coordination choices.

Define the check, iteration/time budget, and stall condition before starting. Completion depends on the check's actual outcome, not the worker's status text. A check proves only the property it tests; review its adequacy for the goal.

Track commands, outcomes, and the input state they verified. Reuse current evidence when unchanged; invalidate it after relevant changes. Run completion checks outside the worker when the loop runtime supports it. A fresh-context review is useful for long or high-risk work, not mandatory on every iteration.

Make each iteration a coherent increment and record enough progress to resume. Commits require authorization; a progress log or checkpoint can preserve state without committing. At startup inspect the current state and existing evidence before deciding what to rerun.

Do not weaken the agreed check to declare success. If the check itself is wrong, report the defect and resolve its contract explicitly. Stop at the configured budget or when repeated attempts yield no new evidence; summarize the failures and missing input instead of retrying unchanged.

Choose models from the available catalog according to task difficulty and measured results. The `model-tiering` skill describes options; a loop does not require a cheap worker or separate advisor.
