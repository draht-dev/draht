# DRAHT Monorepo

> **Dynamic Routing for Agent & Task Handling**

Custom AI agent harness for DACH freelancing, built on [Pi Agent](https://github.com/badlogic/pi-mono) by Mario Zechner.

**Domain:** [draht.dev](https://draht.dev)

## Packages

| Package | Description |
|---------|-------------|
| **[@draht/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@draht/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@draht/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@draht/mom](packages/mom)** | Slack bot that delegates messages to the coding agent |
| **[@draht/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@draht/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@draht/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |
| **[@draht/infra](packages/infra)** | SST v4 infrastructure (Lambda, API Gateway, DynamoDB) |
| **[@draht/templates](packages/templates)** | AGENTS.md template library for common stacks |

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run dev          # Watch mode for all packages
npm run check        # Lint, format, and type check
```

## Fork Attribution

This project is forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (Pi Agent by Mario Zechner). Licensed under MIT — see [LICENSE](LICENSE).
