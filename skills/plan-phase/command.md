---
description: Create atomic execution plans for a roadmap phase (parallel via architect subagents)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /plan-phase

Create atomic execution plans for a roadmap phase, using subagents for parallel plan creation.

Phase: $1

> Invoke noninteractive Draht tooling as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`.

## Planning constraints

Use coherent tasks with concrete files, behavior, and verification. Group dependent changes that need to land together; split unrelated outcomes. Task size follows the behavior and dependency structure, not a time limit or fixed count. Resolve uncertainty that could invalidate later work early, and state material assumptions and how to check them.

The `atomic-reasoning` skill can help with difficult decomposition. Respect existing domain vocabulary and architecture; do not require new DDD layers or events solely because a plan crosses directories. Validate the saved plan with `draht-tools validate-plans $1` and resolve its errors before execution.

## Steps
1. Run `draht-tools load-phase-context $1` to gather all context
1b. Read `.planning/STATE.md` `## Lessons` — every plan this command produces must respect the recorded lessons; a plan that repeats a documented failure is invalid. Feed relevant lessons into each architect prompt.
2. Optional: `draht-tools research-phase $1` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive the observable outcomes required by the user
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
      - GRAPH-ORIENT: read `.planning/codebase/GRAPH_REPORT.md` (regenerate with `draht-tools map-graph` if absent), then run `draht-tools graph-context <target-files>` for pkg/layer/importers and `draht-tools graph-query <term...>` to locate the code. Load relevant results rather than the full MAP.json.
   e. Group tasks according to dependencies and coherent outcomes
4. Identify which plans are independent (no shared files, no dependency edges)
   - GRAPH-IMPACT: run `draht-tools graph-impact <plan-files>` per plan; use affected entry points and dependencies to assess shared risks; serialize conflicting changes. Disjoint file sets alone do not prove independence.

5. **Delegate plan creation to subagents:**
   - For **independent plans**: dispatch multiple subagent calls in parallel (single assistant turn), each using the `architect` role, one per plan.
   - For **dependent plans**: dispatch sequentially — one subagent call per plan, feeding predecessor outputs as context into the next.
   - Each architect prompt must include:
     - The phase context summary (paste it inline — subagents cannot run draht-tools)
     - The specific observable truths this plan must satisfy
     - The target files/artifacts — the orchestrator runs `draht-tools graph-context <plan-files>` and pastes the slice (pkg/layer/importers/imports) inline, since the architect subagent cannot run draht-tools
     - The XML task format specification (below)
     - The instruction below about the **delimiter convention** for output

   ### Architect Output Delimiter Convention

   The architect agent appends a `STATUS:` footer per the standard agent contract. For `/plan-phase`, the orchestrator pipes the architect's output to `create-plan` as a file — we must NOT include the `STATUS:` line in the saved plan.

   Include this instruction in every architect prompt:
   ```
   Output your plan as XML, followed by a line containing exactly `---END-PLAN---`, followed by your final `STATUS: ...` line.

   The orchestrator will split your output on `---END-PLAN---` and save only the plan content. The STATUS line is read for control flow but not saved.
   ```

6. **Collect and split outputs.** For each architect's output:
   - Split on the literal `---END-PLAN---` line
   - Plan content = everything BEFORE the delimiter (trimmed)
   - Status line = everything AFTER the delimiter (the `STATUS:` line)
   - Read the status:
     - `DONE` / `DONE_WITH_CONCERNS` → save the plan
     - `NEEDS_CONTEXT` → provide missing info and re-dispatch this architect
     - `BLOCKED` → STOP, report blocker; do not save a partial plan

7. Save each plan by piping the split plan content into `draht-tools create-plan`:
   ```bash
   printf '%s' "$plan_content" | node "<PLUGIN_ROOT>/bin/draht-tools.cjs" create-plan $1 P [title]
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
This is one step in the per-phase cycle:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N
```

After completing this command, identify `/execute-phase $1` as the next step; a fresh session is optional. Do NOT suggest `/next-milestone`.

## Domain context

Use established project terms and boundaries. Update an existing domain document when the plan changes the model; do not introduce DDD ceremony for unrelated work.
