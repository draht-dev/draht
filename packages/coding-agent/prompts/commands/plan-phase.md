---
description: "Create atomic execution plans for a roadmap phase"
---

# /plan-phase

Create atomic execution plans for a roadmap phase, using subagents for parallel plan creation.

## Usage
```
/plan-phase [N]
```

Phase: $1

## Planning constraints

Use coherent tasks with concrete files, behavior, and verification. Group dependent changes that need to land together; split unrelated outcomes. Task size follows the behavior and dependency structure, not a time limit or fixed count. Resolve uncertainty that could invalidate later work early, and state material assumptions and how to check them.

The `atomic-reasoning` skill can help with difficult decomposition. Respect existing domain vocabulary and architecture; do not require new DDD layers or events solely because a plan crosses directories. Validate the saved plan with `draht-tools validate-plans $1` and resolve its errors before execution.

## Steps
1. Run `draht-tools load-phase-context $1` to gather all context
1b. Read `.planning/STATE.md` `## Lessons` — every plan must respect the recorded lessons; a plan that repeats a documented failure is invalid. Feed relevant lessons into each architect prompt.
2. Optional: `draht-tools research-phase $1` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive the observable outcomes required by the user
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
   e. Group tasks according to dependencies and coherent outcomes
4. Identify which plans are independent (no shared files, no dependency edges)
5. **Delegate plan creation to subagents:**
   - For independent plans: use the `subagent` tool in **parallel mode** with `architect` agents, one per plan.
   - For dependent plans: create them sequentially, each via a **single** `subagent` call to `architect`, passing the outputs of predecessor plans as context.
   - Each subagent task must include:
     - The phase context summary (paste it — subagents cannot run draht-tools)
     - The specific observable truths this plan must satisfy
     - The target files/artifacts
     - The XML task format specification (below)
     - The **delimiter convention** (below) so the orchestrator can split plan content from the `STATUS:` footer

   ### Architect Output Delimiter Convention

   The architect agent appends a `STATUS:` footer per the standard agent contract. For `/plan-phase`, we pipe the architect's plan output to `create-plan` as a file — we must NOT include the `STATUS:` line in the saved plan.

   Include this in every architect prompt:
   ```
   Output your plan as XML, followed by a line containing exactly `---END-PLAN---`, followed by your final `STATUS: ...` line.

   The orchestrator splits your output on `---END-PLAN---` and saves only the plan content. The STATUS line is read for control flow but not saved.
   ```

6. **Collect and split outputs.** For each architect's output:
   - Split on `---END-PLAN---`
   - Plan content = everything BEFORE the delimiter (trimmed)
   - Status line = everything AFTER (the `STATUS:` line)
   - Branch on status:
     - `DONE` / `DONE_WITH_CONCERNS` → save the plan
     - `NEEDS_CONTEXT` → provide missing info and re-dispatch
     - `BLOCKED` → STOP, report; do not save a partial plan

7. Save each plan by piping the split plan content into `draht-tools create-plan`:
   ```
   printf '%s' "$plan_content" | draht-tools create-plan $1 P [title]
   ```
   The content must contain real task details (files, actions, tests) — NOT placeholder brackets. If `create-plan` is called without stdin, it writes a useless template.

8. Validate: `draht-tools validate-plans $1` — if it exits non-zero, fix the offending plan before commit.
9. If committing is authorized: `draht-tools commit-docs "create phase $1 plans"`
10. Show the user the execution order as a Mermaid `flowchart TD` per the `explainers` skill: one `subgraph` per wave, one node per plan, edges for the dependencies the saved plans declare. Draw it from the saved plan files, not from memory. It goes in your reply, not into the plan files.

## Plan Format
Plans use XML task format:
```xml
<task type="auto">
  <n>Task name</n>
  <context>Relevant project context or module boundary</context>
  <domain>Existing domain concepts affected, if applicable</domain>
  <files>affected files</files>
  <test>
    RED phase: Write failing tests FIRST.
    - List specific test cases with expected behavior
    - Test domain invariants and business rules
    - Test at the right level: unit for domain logic, integration for context boundaries
    - Tests MUST fail before implementation
  </test>
  <action>
    GREEN phase: Minimal implementation to make tests pass.
    - No gold-plating — just make the red tests green
    - Respect aggregate boundaries
    - Use domain language in code (class names, method names, variable names)
  </action>
  <refactor>
    REFACTOR phase: Improve structure while keeping tests green.
    - Apply useful structural improvements within scope; preserve behavior
  </refactor>
  <verify>How to verify (tests pass + manual check if needed)</verify>
  <done>What "done" looks like — expressed as passing test assertions</done>
</task>
```

Task types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`

## Workflow
This is one step in the per-phase cycle. Start a fresh session when context limits make it useful:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N → /discuss-phase N+1 → ...
```

After completing this command, identify `/execute-phase $1` as the next step; a fresh session is optional.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Domain context

Use established project terms and boundaries. Update an existing domain document when the plan changes the model; do not introduce DDD ceremony for unrelated work.
