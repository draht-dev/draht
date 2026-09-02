---
title: "Atomic reasoning in GSD workflows"
description: "How Draht splits work into units that can be implemented and checked independently."
date: "2026-04-09"
author: "Oskar Freye"
tags: ["gsd", "reasoning", "workflows", "agents"]
---

Every GSD workflow command starts by splitting the request into units that can be checked independently. Draht calls this atomic reasoning. The agent names each unit, identifies its dependencies, and defines the check that will prove it correct before execution starts.

## Pattern structure

Each command's atomic reasoning section follows this structure:

```markdown
## Atomic Reasoning

Before [action], decompose this [context] into atomic reasoning units:

**For each [unit of work]:**
1. **State the logical component** — What is this? What does it do? What is its purpose?
2. **Validate independence** — Can this be done independently? What are the dependencies?
3. **Verify correctness** — What proves this is correct? What could go wrong?

**Synthesize [strategy name]:**
- [Bullet point synthesis of the plan]
- [Concrete next actions]
```

## Core principles

### 1. Decompose first

Before a workflow command acts, it breaks the problem into units with one purpose each.

### 2. Check each unit

Each unit passes through the same questions:

- **State.** What is this component, and what does it do?
- **Validate.** Can it stand alone? If not, what does it depend on?
- **Verify.** Which check proves it is correct?

### 3. Synthesize last

Only after those checks does the agent order the units into an execution plan.

## Adaptations by command

### Planning commands

`/plan-phase`, `/discuss-phase`, `/init-project`, `/new-project`, and `/next-milestone` use the pattern to turn goals and requirements into observable outcomes and proving tests.

**Example from `/plan-phase`:**
```markdown
**For each observable truth (user-visible outcome):**
1. **State the logical component** — What must be true for the user?
2. **Validate independence** — Which artifacts prove this truth exists?
3. **Verify correctness** — What test scenarios prove this observable truth?
```

### Execution commands

`/execute-phase`, `/quick`, and `/fix` split work into tasks, identify dependencies, and name the verification for each task.

**Example from `/execute-phase`:**
```markdown
**For each plan in the phase:**
1. **State the logical component** — What is this plan's singular purpose?
2. **Validate independence** — Can this plan execute in parallel?
3. **Verify correctness** — What tests will prove this plan works?
```

### Verification commands

`/verify-work` and `/review` split acceptance criteria into separate checks, choose a test strategy for each one, and order the findings.

**Example from `/verify-work`:**
```markdown
**For each deliverable:**
1. **State the logical component** — What was this deliverable meant to produce?
2. **Validate independence** — Can this deliverable be tested independently?
3. **Verify correctness** — What tests prove it works? What edge cases must pass?
```

### Analysis commands

`/map-codebase` divides a codebase into bounded contexts, extracts the domain model, and records the patterns it finds.

**Example from `/map-codebase`:**
```markdown
**For each architectural layer:**
1. **State the logical component** — What is this directory/module's responsibility?
2. **Validate independence** — Is this a bounded context? What are its dependencies?
3. **Verify correctness** — What domain terms appear? What test infrastructure exists?
```

### Meta commands

`/progress`, `/pause-work`, `/resume-work`, and `/atomic-commit` apply the pattern to session state, handoffs, and commit boundaries.

**Example from `/pause-work`:**
```markdown
1. **State the logical component** — What was accomplished this session?
2. **Validate independence** — Are there uncommitted changes? Are there blockers?
3. **Verify correctness** — Is the current state stable? Can work resume cleanly?
```

## What the pattern changes

The independence check exposes work that can run in parallel and work that must stay ordered. Naming the proving check before implementation prevents vague "done" states. For domain work, the decomposition also exposes bounded contexts and team terminology before the agent edits code.

The plan records those decisions, so a reviewer can see why tasks were split and what evidence each task must produce.

## Examples

### Example 1: `/execute-phase 5`

**Before Atomic Reasoning:**
Agent immediately starts executing plans without analyzing dependencies, leading to sequential execution when parallelization was possible.

**With Atomic Reasoning:**
```
Atomic Reasoning:
- Plan 5.1 (Auth): Touches src/auth/*, no dependencies → can run in parallel
- Plan 5.2 (API): Touches src/api/*, depends on Plan 5.1 → must wait
- Plan 5.3 (UI): Touches src/ui/*, no dependencies → can run in parallel with 5.1

Synthesis: Execute Plans 5.1 and 5.3 in parallel, then 5.2
```

### Example 2: `/fix login-redirect-broken`

**Before Atomic Reasoning:**
Agent jumps straight to proposing a fix without understanding the root cause.

**With Atomic Reasoning:**
```
Atomic Reasoning:
1. State: User reports redirect fails after login → expected: /dashboard, actual: /login
2. Validate: Likely in auth middleware (src/auth/middleware.ts) → isolated to one component
3. Verify: Need test that reproduces: login → check redirect destination

Synthesis: Diagnose via debugger subagent, write failing test, apply minimal fix
```

### Example 3: `/plan-phase 3`

**Before Atomic Reasoning:**
Agent creates plans without clear success criteria or test scenarios.

**With Atomic Reasoning:**
```
Atomic Reasoning for Observable Truth: "User can view order history"
1. State: User accesses /orders → sees list of past orders with status
2. Validate: Requires: API endpoint GET /api/orders, UI component OrderList, auth check
3. Verify: Tests:
   - GET /api/orders with valid token → returns order array
   - OrderList renders orders correctly
   - Unauthorized access → 401

Synthesis: Create plan with 3 tasks (API, UI, Auth) with specific test scenarios
```

## Implementation notes

### Placement
The `## Atomic Reasoning` section appears:
- **After** the `## Usage` section
- **Before** the `## Steps` section
- **Before** any `## Prerequisites` sections (e.g., in `/next-milestone`)

### Tone
- Direct and technical
- Question-based prompts ("What is...", "Can this...", "What proves...")
- Action-oriented synthesis bullets

### Adaptation

The State, Validate, and Verify questions stay fixed. Their wording changes with the command:
- Planning commands focus on observable truths and requirements
- Execution commands focus on tasks and dependencies
- Verification commands focus on deliverables and tests
- Analysis commands focus on architectural layers and patterns

## Adding atomic reasoning to new commands

When adding new GSD workflow commands:

1. Add an `## Atomic Reasoning` section before `## Steps`
2. Adapt the three-phase pattern to the command's context
3. End with a synthesis section that produces an actionable strategy
4. Use domain-specific language (bounded contexts, aggregates, etc. for domain work)
5. Keep prompts concise and question-based

## Related concepts

- **Goal-Backward Planning** (used in `/plan-phase`) — start with goals, derive observable truths
- **TDD Red-Green-Refactor** — atomic reasoning applied to test-first development
- **Domain-Driven Design** — bounded contexts and ubiquitous language inform decomposition
- **Parallel Subagent Execution** — independence validation enables parallelization
