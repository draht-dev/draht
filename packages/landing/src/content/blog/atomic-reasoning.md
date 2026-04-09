---
title: "Atomic Reasoning Pattern in GSD Workflows"
description: "How Draht's GSD workflow commands use atomic reasoning to decompose complex problems into verifiable units before execution."
date: "2026-04-09"
author: "Oskar Freye"
tags: ["gsd", "reasoning", "workflows", "agents"]
---

All GSD workflow commands now incorporate an **Atomic Reasoning** pattern as a prompting technique. This pattern guides the AI agent to decompose complex problems into atomic reasoning units before execution.

## Pattern Structure

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

## Core Principles

### 1. Decomposition First
Before executing any workflow command, the agent must first break down the problem into atomic units. Each unit represents a single, coherent logical component.

### 2. Three-Phase Validation
Each atomic unit goes through three validation steps:
- **State** — Clearly articulate what this component is and what it does
- **Validate** — Confirm it can stand alone or identify its dependencies
- **Verify** — Define how we know it's correct

### 3. Synthesis Last
After analyzing all atomic units, synthesize them into a coherent execution strategy. The synthesis phase produces actionable steps.

## Command-Specific Adaptations

### Planning Commands
**Commands:** `/plan-phase`, `/discuss-phase`, `/init-project`, `/new-project`, `/next-milestone`

**Focus:** Decompose goals and requirements into observable truths and testable outcomes.

**Example from `/plan-phase`:**
```markdown
**For each observable truth (user-visible outcome):**
1. **State the logical component** — What must be true for the user?
2. **Validate independence** — Which artifacts prove this truth exists?
3. **Verify correctness** — What test scenarios prove this observable truth?
```

### Execution Commands
**Commands:** `/execute-phase`, `/quick`, `/fix`

**Focus:** Decompose work into independent tasks, identify dependencies, plan verification.

**Example from `/execute-phase`:**
```markdown
**For each plan in the phase:**
1. **State the logical component** — What is this plan's singular purpose?
2. **Validate independence** — Can this plan execute in parallel?
3. **Verify correctness** — What tests will prove this plan works?
```

### Verification Commands
**Commands:** `/verify-work`, `/review`

**Focus:** Decompose acceptance criteria, identify test strategies, prioritize findings.

**Example from `/verify-work`:**
```markdown
**For each deliverable:**
1. **State the logical component** — What was this deliverable meant to produce?
2. **Validate independence** — Can this deliverable be tested independently?
3. **Verify correctness** — What tests prove it works? What edge cases must pass?
```

### Analysis Commands
**Commands:** `/map-codebase`

**Focus:** Decompose codebase into bounded contexts, extract domain model, identify patterns.

**Example from `/map-codebase`:**
```markdown
**For each architectural layer:**
1. **State the logical component** — What is this directory/module's responsibility?
2. **Validate independence** — Is this a bounded context? What are its dependencies?
3. **Verify correctness** — What domain terms appear? What test infrastructure exists?
```

### Meta Commands
**Commands:** `/progress`, `/pause-work`, `/resume-work`, `/atomic-commit`

**Focus:** Decompose session state, understand context, plan transitions.

**Example from `/pause-work`:**
```markdown
1. **State the logical component** — What was accomplished this session?
2. **Validate independence** — Are there uncommitted changes? Are there blockers?
3. **Verify correctness** — Is the current state stable? Can work resume cleanly?
```

## Benefits

### 1. Reduced Errors
By forcing decomposition before execution, the agent catches logical errors and missing dependencies early.

### 2. Better Parallelization
Independence validation reveals which tasks can run in parallel, enabling efficient subagent delegation.

### 3. Clearer Verification
Explicit correctness criteria make verification objective and testable.

### 4. Improved Domain Alignment
Atomic reasoning surfaces domain concepts early, ensuring alignment with ubiquitous language.

### 5. Auditable Reasoning
The agent's reasoning process is explicit and traceable, making it easier to understand and debug.

## Usage Examples

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

## Implementation Notes

### Placement
The `## Atomic Reasoning` section appears:
- **After** the `## Usage` section
- **Before** the `## Steps` section
- **Before** any `## Prerequisites` sections (e.g., in `/next-milestone`)

### Tone
- Direct and technical
- Question-based prompts ("What is...", "Can this...", "What proves...")
- Action-oriented synthesis bullets

### Adaptability
While the three-phase pattern (State, Validate, Verify) is consistent, the specific prompts adapt to each command's domain:
- Planning commands focus on observable truths and requirements
- Execution commands focus on tasks and dependencies
- Verification commands focus on deliverables and tests
- Analysis commands focus on architectural layers and patterns

## Adding Atomic Reasoning to New Commands

When adding new GSD workflow commands:

1. Add an `## Atomic Reasoning` section before `## Steps`
2. Adapt the three-phase pattern to the command's context
3. End with a synthesis section that produces an actionable strategy
4. Use domain-specific language (bounded contexts, aggregates, etc. for domain work)
5. Keep prompts concise and question-based

## Related Concepts

- **Goal-Backward Planning** (used in `/plan-phase`) — start with goals, derive observable truths
- **TDD Red-Green-Refactor** — atomic reasoning applied to test-first development
- **Domain-Driven Design** — bounded contexts and ubiquitous language inform decomposition
- **Parallel Subagent Execution** — independence validation enables parallelization
