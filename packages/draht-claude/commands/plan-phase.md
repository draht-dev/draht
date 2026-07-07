---
description: Create atomic execution plans for a roadmap phase (parallel via architect subagents)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /plan-phase

Create atomic execution plans for a roadmap phase, using subagents for parallel plan creation.

Phase: $1

## Red Flags — STOP

A plan is only as good as the tasks inside it. STOP and revise instead of saving if **any** of these is true:

- Any task contains placeholder text: `[TBD]`, `[files]`, `[description]`, "appropriate error handling", "similar to Task N", or `...` in code positions
- A task's `<test>` section names no concrete test cases (e.g., "test the function" with no inputs/outputs)
- A task's `<files>` section lists no concrete file paths
- A task takes more than ~5 minutes of focused work — break it down further
- The plan introduces new domain terms that are NOT in `.planning/DOMAIN.md` — update DOMAIN.md first
- A plan touches more than one bounded context without explicit ACL — split per context
- The first plan is scaffolding/boilerplate while an unproven risk (new integration, unfamiliar API, untested pattern) sits in a later plan — reorder so the risk is proven first

Run `draht-tools validate-plans $1` after saving. If it reports issues, fix them before commit.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "architect"`. Dispatch multiple parallel tasks in a single assistant turn by making multiple Task tool calls at once.

## Atomic Reasoning

Before creating plans, decompose this phase goal into atomic reasoning units:

**For each observable truth (user-visible outcome):**
1. **State the logical component** — What must be true for the user? What can they do/see/verify?
2. **Validate independence** — Which artifacts (files, endpoints, schemas) prove this truth exists? Can it be built independently?
3. **Verify correctness** — What test scenarios would prove this observable truth? What are the specific inputs → expected outputs?

**Atomicity test:** a task is atomic only if its `<verify>` can fail while every other task passes. If two tasks can only be checked together, they are one task.

**Synthesize planning strategy:**
- Group related observable truths into cohesive plans (2-5 tasks each)
- Identify which plans can be created in parallel vs sequentially
- Map each plan to specific bounded contexts and domain concepts
- Ensure each plan produces testable, verifiable outcomes
- **Order risk-first**: score each truth by uncertainty (has this codebase done it before?) × blast radius (how much becomes invalid if it's wrong?). The plan proving the highest-scoring truth executes first; boilerplate goes last. Boilerplate never invalidates a phase — the risky part regularly does.
- Write every assumption a plan rests on as an explicit `Assumes:` line (with how to confirm it) in the plan header. Unwritten assumptions become the executor's bugs.

## Steps
1. Run `draht-tools load-phase-context $1` to gather all context
2. Optional: `draht-tools research-phase $1` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive observable truths (3-7 from user perspective)
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
      - GRAPH-ORIENT: read `.planning/codebase/MAP.json` (regenerate with `draht-tools map-graph` if absent), then run `draht-tools graph-context <target-files>` for pkg/layer/importers and `draht-tools graph-query <term...>` to locate the code instead of grepping.
   e. Break into plan groups of 2-5 tasks each
4. Identify which plans are independent (no shared files, no dependency edges)
   - GRAPH-IMPACT: run `draht-tools graph-impact <plan-files>` per plan; plans with disjoint impact sets (reverse-dependents, entry points, sinks) are safe to parallelize — overlapping blast radius means a dependency edge.

5. **Delegate plan creation to subagents via the Task tool:**
   - For **independent plans**: dispatch multiple `Task` tool calls in parallel (single assistant turn), each with `subagent_type: "architect"`, one per plan.
   - For **dependent plans**: dispatch sequentially — one `Task` call per plan, feeding predecessor outputs as context into the next.
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
   printf '%s' "$plan_content" | node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" create-plan $1 P [title]
   ```
   The content must contain real task details (files, actions, tests) — NOT placeholder brackets. If `create-plan` is called without stdin, it writes a useless template.

8. Validate: `draht-tools validate-plans $1` — if it exits non-zero, fix the offending plan before commit.
9. Commit: `draht-tools commit-docs "create phase $1 plans"`

## Plan Format
Plans use XML task format:
```xml
<task type="auto">
  <n>Task name</n>
  <context>Bounded context this task belongs to</context>
  <domain>Aggregates, entities, value objects, or events touched</domain>
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
    - Extract value objects, push logic into domain layer
    - Ensure naming matches ubiquitous language
    - Remove duplication across bounded contexts (or make shared kernel explicit)
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

After completing this command, tell the user to start a fresh session (`/clear`) and run `/execute-phase $1`. Do NOT suggest `/next-milestone`.

## Domain Rules for Plans
- File/module structure should mirror bounded contexts (e.g., `src/billing/`, `src/catalog/`)
- Never scatter one aggregate's logic across multiple contexts without an explicit ACL
- If a plan introduces a new domain term, update `.planning/DOMAIN.md` first
- Cross-context communication should use domain events, not direct imports
