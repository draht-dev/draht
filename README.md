# Draht Monorepo

> **Dynamic Routing for Agent & Task Handling**

A modular, extensible AI coding agent framework. Extensions, skills, multi-model support — all in your terminal.

**Website:** [draht.dev](https://draht.dev) · **Install:** `npx @draht/coding-agent`

## Quick Start

```bash
# Install globally
bun add -g @draht/coding-agent

# Or run directly
npx @draht/coding-agent

# Interactive mode with a prompt
draht "Refactor this module to use dependency injection"

# Non-interactive (process and exit)
draht -p "List all TODO comments in src/"
```

## Packages

| Package | Description |
|---------|-------------|
| **[@draht/coding-agent](packages/coding-agent)** | Interactive coding agent CLI (`draht`) |
| **[@draht/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, etc.) |
| **[@draht/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@draht/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@draht/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@draht/knowledge](packages/knowledge)** | Client knowledge base with vector search |
| **[@draht/ci](packages/ci)** | CI/CD review pipeline (GitHub PR reviews) |
| **[@draht/orchestrator](packages/orchestrator)** | Multi-agent task orchestration |
| **[@draht/deploy-guardian](packages/deploy-guardian)** | Pre-deploy safety checks |
| **[@draht/mom](packages/mom)** | Slack bot that delegates messages to the coding agent |
| **[@draht/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |
| **[@draht/infra](packages/infra)** | SST v4 infrastructure (Lambda, API Gateway, DynamoDB) |
| **[@draht/templates](packages/templates)** | AGENTS.md template library for common stacks |
| **[@draht/workflows](packages/workflows)** | n8n workflow definitions |
| **[@draht/landing](packages/landing)** | Astro landing page for draht.dev |

## Architecture

```
draht (CLI)
├── @draht/coding-agent    ← main CLI, extension loader, session management
│   ├── @draht/agent-core  ← tool execution, message handling
│   │   └── @draht/ai      ← LLM providers (Anthropic, OpenAI, Google, Bedrock)
│   └── @draht/tui         ← terminal rendering
├── @draht/knowledge       ← vector store for project context
├── @draht/ci              ← PR review automation
├── @draht/orchestrator    ← multi-agent task decomposition
└── @draht/deploy-guardian ← pre-deploy safety checks
```

## Extensions

Draht supports a rich extension system. Extensions can register tools, commands, providers, themes, skills, and prompt templates.

```json
// package.json
{
  "draht": {
    "extensions": ["./my-extension.ts"]
  }
}
```

```typescript
// my-extension.ts
export default function(draht) {
  draht.registerCommand("hello", {
    handler: async () => console.log("Hello from my extension!")
  });
}
```

See [Extension Docs](packages/coding-agent/docs/extensions.md) for the full API.

## Development

```bash
bun install          # Install all dependencies
bun run build        # Build all packages
bun run dev          # Watch mode for all packages
bun run check        # Lint, format, and type check (biome + tsgo)
bun run test         # Run all tests
```

### Project Structure

```
draht-mono/
├── packages/
│   ├── coding-agent/    # Main CLI
│   ├── ai/              # LLM providers
│   ├── agent/           # Agent runtime
│   ├── tui/             # Terminal UI
│   ├── web-ui/          # Web components
│   ├── knowledge/       # Knowledge base
│   ├── ci/              # CI review
│   ├── orchestrator/    # Multi-agent
│   ├── deploy-guardian/ # Deploy checks
│   ├── mom/             # Slack bot
│   ├── pods/            # GPU pod management
│   ├── infra/           # SST infrastructure
│   ├── templates/       # AGENTS.md templates
│   ├── workflows/       # n8n workflows
│   └── landing/         # draht.dev website
├── .github/workflows/   # CI/CD
└── .planning/           # GSD planning docs
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DRAHT_OFFLINE` | Disable startup network operations (`1`/`true`/`yes`) |
| `DRAHT_CACHE_RETENTION` | Cache retention mode (`short`/`long`) |
| `DRAHT_PACKAGE_DIR` | Override package directory (for Nix/Guix store paths) |
| `DRAHT_SHARE_VIEWER_URL` | Base URL for /share command |
| `DRAHT_TIMING` | Enable performance timing (`1`) |

## Fork Attribution

This project is forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (Pi Agent by Mario Zechner). Licensed under MIT — see [LICENSE](LICENSE).
