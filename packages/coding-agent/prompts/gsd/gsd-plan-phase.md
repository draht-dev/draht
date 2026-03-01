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
   c. Map to required artifacts (files, endpoints, schemas)
   d. Break into atomic tasks (2-5 per plan)
4. Write plans: `draht create-plan N P`
5. Validate: `draht validate-plans N`
6. Commit: `draht commit-docs "create phase N plans"`

## Plan Format
Plans use XML task format:
```xml
<task type="auto">
  <n>Task name</n>
  <files>affected files</files>
  <test>Write tests first — what should pass when done (TDD: Red)</test>
  <action>Implementation to make tests pass (TDD: Green)</action>
  <refactor>Optional cleanup while keeping tests green (TDD: Refactor)</refactor>
  <verify>How to verify</verify>
  <done>What "done" looks like</done>
</task>
```

Task types: `auto`, `checkpoint:human-verify`, `checkpoint:decision`
