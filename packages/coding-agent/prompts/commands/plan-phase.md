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
5. **Delegate plan creation to subagents:**
   - For independent plans: use the `subagent` tool in **parallel mode** with `architect` agents, one per plan. Each task should include the phase context, the specific observable truths, target files, and the XML task format (below).
   - For dependent plans: create them sequentially, each via a **single** `subagent` call to `architect`, passing the outputs of predecessor plans as context.
   - Each subagent task must include:
     - The phase context summary (paste it — subagents cannot run draht-tools)
     - The specific observable truths this plan must satisfy
     - The target files/artifacts
     - The XML task format specification (below)
     - Instruction to output the plan as XML (you will save it via `draht-tools create-plan`)

6. Collect all plan outputs from subagents
7. Save each plan by piping the subagent's output into `draht-tools create-plan`:
   ```
   echo 'plan content from subagent' | draht-tools create-plan $1 P [title]
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
