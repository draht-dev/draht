---
description: Create atomic execution plans for a roadmap phase (parallel via architect subagents)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /plan-phase

Create atomic execution plans for a roadmap phase, using subagents for parallel plan creation.

Phase: $1

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "architect"`. Dispatch multiple parallel tasks in a single assistant turn by making multiple Task tool calls at once.

## Atomic Reasoning

Before creating plans, decompose this phase goal into atomic reasoning units:

**For each observable truth (user-visible outcome):**
1. **State the logical component** — What must be true for the user? What can they do/see/verify?
2. **Validate independence** — Which artifacts (files, endpoints, schemas) prove this truth exists? Can it be built independently?
3. **Verify correctness** — What test scenarios would prove this observable truth? What are the specific inputs → expected outputs?

**Synthesize planning strategy:**
- Group related observable truths into cohesive plans (2-5 tasks each)
- Identify which plans can be created in parallel vs sequentially
- Map each plan to specific bounded contexts and domain concepts
- Ensure each plan produces testable, verifiable outcomes

## Steps
1. Run `draht-tools load-phase-context $1` to gather all context
2. Optional: `draht-tools research-phase $1` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive observable truths (3-7 from user perspective)
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
   e. Break into plan groups of 2-5 tasks each
4. Identify which plans are independent (no shared files, no dependency edges)

5. **Delegate plan creation to subagents via the Task tool:**
   - For **independent plans**: dispatch multiple `Task` tool calls in parallel (single assistant turn), each with `subagent_type: "architect"`, one per plan.
   - For **dependent plans**: dispatch sequentially — one `Task` call per plan, feeding predecessor outputs as context into the next.
   - Each architect prompt must include:
     - The phase context summary (paste it inline — subagents cannot run draht-tools)
     - The specific observable truths this plan must satisfy
     - The target files/artifacts
     - The XML task format specification (below)
     - Instruction to output the plan as XML text, which the main assistant will save via `draht-tools create-plan`

6. Collect all plan outputs from subagents
7. Save each plan by piping the subagent's output into `draht-tools create-plan`:
   ```bash
   echo 'plan content from subagent' | node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" create-plan $1 P [title]
   ```
   The content must contain real task details (files, actions, tests) — NOT placeholder brackets. If `create-plan` is called without stdin, it writes a useless template.
8. Validate: `draht-tools validate-plans $1`
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
