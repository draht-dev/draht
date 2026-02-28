# @draht/orchestrator

Multi-agent task orchestration for the Draht coding agent.

## Features

- **Task Decomposition** — Break complex tasks into sub-tasks
- **Execution Engine** — Coordinate multiple agent instances
- **Extension** — Registers as a Draht coding agent extension

## Usage

```typescript
import { orchestratorExtension } from "@draht/orchestrator";

// As a coding agent extension
export default orchestratorExtension;
```

## Exports

| Export | Description |
|--------|-------------|
| `orchestratorExtension` | Draht coding agent extension |
| `Decomposer` | Task decomposition logic |
| `Engine` | Multi-agent execution engine |
