# Phase 7 Context: Multi-Agent Orchestration

## Domain Boundary
GSD Controller pattern for multi-agent task decomposition and coordination. Controller reads task → creates plan → spawns sub-agents → synthesizes results.

## Decisions

### Architecture
- **Pattern:** Controller agent orchestrates sub-agents via message passing
- **Sub-agent types:** research, implementation, test, review (each gets focused context)
- **Coordination:** Sequential with dependency graph (not parallel initially)
- **State:** Orchestration state in JSON, persisted to disk for resumability

### Ticket Decomposer
- **Input:** High-level ticket/task description
- **Output:** Array of sub-tasks with dependency graph, estimated complexity, and agent assignment
- **Uses Claude** to decompose — prompt includes project context (AGENTS.md) for informed decomposition

### Package Structure
- **Location:** `packages/orchestrator/` as @draht/orchestrator
- **Exports:** OrchestratorEngine, TicketDecomposer, SubTask types
- **Coding agent extension** for /orchestrate command

## Claude's Discretion
- Exact sub-agent prompt templates
- Retry/failure handling strategy
- Result synthesis format

## Deferred Ideas
- Parallel sub-agent execution
- Agent specialization profiles
- Cost tracking per orchestration
