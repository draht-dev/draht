
<p align="center">
  <a href="https://draht.dev">
    <img src="https://draht.dev/logo.svg" alt="draht logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://draht.dev">draht.dev</a> domain graciously donated by
</p>

# draht Monorepo

> **Looking for the draht coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@draht/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@draht/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@draht/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@draht/mom](packages/mom)** | Slack bot that delegates messages to the draht coding agent |
| **[@draht/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@draht/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@draht/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run draht from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
