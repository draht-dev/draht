# /plan-phase

Create atomic execution plans for a roadmap phase.

## Usage
```
/plan-phase [N]
```

## Steps
1. Run `draht load-phase-context N` to gather all context
2. Optional: `draht research-phase N` for domain research
3. Goal-backward planning:
   a. State the goal (outcome, not activity)
   b. Derive observable truths (3-7 from user perspective)
   c. From each observable truth, derive the test scenarios that would prove it (specific inputs → expected outputs or state changes)
   d. Map to required artifacts (files, endpoints, schemas)
   e. Break into atomic tasks (2-5 per plan)
4. Write plans: `draht create-plan N P`
5. Validate: `draht validate-plans N`
6. Commit: `draht commit-docs "create phase N plans"`

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

## Domain Rules for Plans
- File/module structure should mirror bounded contexts (e.g., `src/billing/`, `src/catalog/`)
- Never scatter one aggregate's logic across multiple contexts without an explicit ACL
- If a plan introduces a new domain term, update `.planning/DOMAIN.md` first
- Cross-context communication should use domain events, not direct imports
