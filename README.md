
<p align="center">
  <a href="https://draht.dev">
        <img src="https://draht.dev/draht-logo.png" alt="draht logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://draht.dev">draht.dev</a> domain via <a href="https://draht.dev/domain">Spaceship</a>
</p>

# draht Monorepo

> **Looking for the draht coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

The supported Draht product is a local agent stack for building and running AI
agents, with selected public extensions and deployment tools. Private workspaces
and examples in this monorepo are not hosted-service or release claims. See the
[product and package support map](.planning/PRODUCT-MAP.md) for the authoritative
scope and evidence gates.

## Packages

| Package | Description |
|---------|-------------|
| **[@draht/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@draht/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@draht/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@draht/knowledge](packages/knowledge)** | Persistent project knowledge extension |
| **[@draht/mom](packages/mom)** | Slack bot that delegates messages to the draht coding agent |
| **[@draht/tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@draht/web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@draht/pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

The table lists supported public packages, not every workspace. In particular,
`@draht/infra`, `@draht/invoice`, `@draht/compliance`, and `@draht/workflows` are
examples; `@draht/ci`, `@draht/landing`, and `@draht/x-markdown` are internal
tools. They are private and excluded from public package releases.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
bun install --frozen-lockfile --ignore-scripts --linker hoisted  # Reproducible canonical install
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run draht from sources (can be run from any directory)
```

Use the exact Bun canary package and revision declared by `packageManager` and
`drahtReleaseBunRevision` in the root `package.json`. Dependency lifecycle
scripts stay disabled during installation; run required build, check, and test
steps explicitly.

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
