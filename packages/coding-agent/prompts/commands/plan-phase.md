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

## Red Flags — STOP

A plan is only as good as the tasks inside it. STOP and revise instead of saving if **any** of these is true:

- Any task contains placeholder text: `[TBD]`, `[files]`, `[description]`, "appropriate error handling", "similar to Task N", `...` in code positions
- A task's `<test>` section names no concrete test cases (e.g., "test the function" with no inputs/outputs)
- A task's `<files>` section lists no concrete file paths
- A task takes more than ~5 minutes — break it down further
- The plan introduces new domain terms that are NOT in `.planning/DOMAIN.md` — update DOMAIN.md first
- A plan touches more than one bounded context without explicit ACL — split per context
- The first plan is scaffolding/boilerplate while an unproven risk (new integration, unfamiliar API, untested pattern) sits in a later plan — reorder so the risk is proven first

Run `draht-tools validate-plans $1` after saving. Fix any issues it reports before commit.

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
1b. Read `.planning/STATE.md` `## Lessons` — every plan must respect the recorded lessons; a plan that repeats a documented failure is invalid. Feed relevant lessons into each architect prompt.
2. Optional: `draht-tools research-phase $1` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive observable truths (3-7 from user perspective)
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
   e. Break into plan groups of 2-5 tasks each
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
This is one step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N → /new → /discuss-phase N+1 → ...
```

After completing this command, tell the user to start a new session and run `/execute-phase $1`.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Domain Rules for Plans
- File/module structure should mirror bounded contexts (e.g., `src/billing/`, `src/catalog/`)
- Never scatter one aggregate's logic across multiple contexts without an explicit ACL
- If a plan introduces a new domain term, update `.planning/DOMAIN.md` first
- Cross-context communication should use domain events, not direct imports
