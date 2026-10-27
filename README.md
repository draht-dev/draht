<p align="center">
  <a href="https://draht.dev">
    <img src="https://draht.dev/draht-logo.png" alt="draht logo: link to draht.dev" width="128">
  </a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@draht/coding-agent"><img alt="npm version of @draht/coding-agent" src="https://img.shields.io/npm/v/@draht/coding-agent?style=flat-square" /></a>
  <a href="https://github.com/draht-dev/draht/actions/workflows/ci.yml"><img alt="CI build status" src="https://img.shields.io/github/actions/workflow/status/draht-dev/draht/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>
<p align="center">
  <a href="https://draht.dev">draht.dev</a> domain via <a href="https://draht.dev/domain">Spaceship</a>
</p>

# draht: open source coding agent for the terminal

draht is an open source (MIT) AI coding agent that runs in your terminal, published on npm as `@draht/coding-agent`, for developers who want to work with Anthropic, OpenAI, Google, GitHub Copilot and other models from one extensible CLI. It is a fork of the pi coding agent by Mario Zechner and adds features such as duet mode (two models in one session) and Polyphase multi-agent workflows.

<!-- Oskar: add a short terminal GIF or asciinema recording here (e.g. duet mode), with alt text. -->

## Quickstart

Requires Node.js `^22.23.4`, `^24.22.1` or `^26.12.1` (from `engines` in [packages/coding-agent/package.json](packages/coding-agent/package.json)).

Run without installing:

```bash
npx @draht/coding-agent
```

Or install globally and start the `draht` command:

```bash
npm install -g @draht/coding-agent
draht
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
draht
```

Or use an existing subscription from inside draht:

```text
/login
```

Then describe what you want. By default the model gets four tools: `read`, `write`, `edit` and `bash`.

## What is draht

draht is a terminal coding agent plus the libraries it is built on. This repository is a monorepo. The coding agent lives in [packages/coding-agent](packages/coding-agent), which has the full user documentation.

The supported Draht product is a local agent stack for building and running AI agents, with selected public extensions and deployment tools. Private workspaces and examples in this monorepo are not hosted-service or release claims. See the [product and package support map](.planning/PRODUCT-MAP.md) for the authoritative scope and evidence gates.

## Features

- **Many providers and models:** log in with subscriptions (Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro (Codex), GitHub Copilot, Google Gemini CLI, Google Antigravity) or use API keys for Anthropic, OpenAI, Azure OpenAI, Google Gemini, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, ZAI, OpenCode Zen, OpenCode Go, Hugging Face, Kimi For Coding and MiniMax. See [providers](packages/coding-agent/docs/providers.md).
- **Duet mode:** use two or more models in one session, either alternating turns or with a lead model that delegates read-only investigations. See [duet mode](packages/coding-agent/docs/duet.md).
- **Polyphase:** live oversight of subagents and model-written multi-phase `workflow` scripts. See [Polyphase](packages/coding-agent/docs/polyphase.md).
- **Session tree:** sessions are stored as trees, so you can branch and continue from any earlier point. See [sessions](packages/coding-agent/docs/sessions.md).
- **MCP servers** over stdio or streamable HTTP (`draht mcp add`). See [MCP](packages/coding-agent/docs/mcp.md).
- **Compaction** of long sessions. See [compaction](packages/coding-agent/docs/compaction.md).
- **Extensible without forking:** TypeScript extensions, skills, prompt templates and themes, shareable as Draht Packages via npm or git. See [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md) and [packages](packages/coding-agent/docs/packages.md).
- **Four modes:** interactive, print or JSON, RPC for process integration, and an SDK for embedding. See [RPC](packages/coding-agent/docs/rpc.md) and [SDK](packages/coding-agent/docs/sdk.md).
- **Workflow skills** in [skills/](skills), for example `tdd-workflow`, `ddd-workflow` and `debugging-workflow`.

## Installation

```bash
npm install -g @draht/coding-agent
```

The package installs the `draht` command. Platform notes: [Windows](packages/coding-agent/docs/windows.md), [Termux (Android)](packages/coding-agent/docs/termux.md), [tmux](packages/coding-agent/docs/tmux.md), [terminal setup](packages/coding-agent/docs/terminal-setup.md).

<!-- Oskar: the repo also has install.sh at the root. Should it be documented here as an install option? -->

## Usage

```bash
draht [options] [@files...] [messages...]
```

Examples from the [CLI reference](packages/coding-agent/README.md#cli-reference):

```bash
draht "List all .ts files in src/"   # interactive with an initial prompt
draht -p "Summarize this codebase"   # non-interactive
draht --thinking high "Solve this complex problem"
```

Inside a session, `/model` (or Ctrl+L) switches models and `/duet` starts duet mode. See the [coding agent README](packages/coding-agent/README.md) for commands, keyboard shortcuts and settings.

## Configuration, models and providers

- Config directory: `~/.draht/agent` (override with `DRAHT_CODING_AGENT_DIR`). Project config lives in `.draht/`.
- Custom providers and models: `~/.draht/agent/models.json` for providers that speak a supported API (OpenAI, Anthropic, Google). See [models](packages/coding-agent/docs/models.md) and [custom providers](packages/coding-agent/docs/custom-provider.md).
- Settings: [settings](packages/coding-agent/docs/settings.md). Environment variables: [environment variables](packages/coding-agent/docs/environment-variables.md).

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

The table lists supported public packages, not every workspace. In particular, `@draht/infra`, `@draht/invoice`, `@draht/compliance`, and `@draht/workflows` are examples; `@draht/ci`, `@draht/landing`, and `@draht/x-markdown` are internal tools. They are private and excluded from public package releases.

## How draht differs from pi

draht is built on [pi](https://github.com/earendil-works/pi-mono), the coding agent by Mario Zechner, and is periodically synced with it (see [.upstream-sync](.upstream-sync)). pi is MIT licensed; its copyright notice is kept in this repo's [LICENSE](LICENSE). The minimal core and the extension model come from pi.

Differences documented in this repo:

- Renamed packages and CLI: `@draht/*` packages, the `draht` command, `~/.draht` config.
- Duet mode, Polyphase and built-in MCP support, documented in [duet.md](packages/coding-agent/docs/duet.md) and [polyphase.md](packages/coding-agent/docs/polyphase.md).
- Additional workflow skills in [skills/](skills).

<!-- Oskar: confirm the upstream link (earendil-works/pi-mono vs badlogic/pi-mono, or pi.dev) and which of these features are draht-only vs also in current pi. -->

## FAQ

### What is draht?
An open source AI coding agent for the terminal, installed from npm as `@draht/coding-agent`.

### How do I install draht?
Run `npx @draht/coding-agent`, or `npm install -g @draht/coding-agent` and then `draht`.

### Which models does draht support?
Models from the built-in providers listed under [Features](#features), plus custom providers through `~/.draht/agent/models.json`.

### Can I use my Claude or ChatGPT subscription instead of an API key?
Yes. Run `/login` and choose Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro (Codex), GitHub Copilot, Google Gemini CLI or Google Antigravity.

### Is draht a fork of pi?
Yes. draht is based on pi by Mario Zechner and keeps its MIT copyright notice.

### Does draht support MCP?
Yes. draht connects to MCP servers over stdio or streamable HTTP, for example `draht mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .`. See [mcp.md](packages/coding-agent/docs/mcp.md).

<!-- Oskar: the coding-agent README Philosophy section still says "No MCP". Update it in a separate change? -->

### Can I use draht from my own program?
Yes, through the SDK or RPC mode. See [sdk.md](packages/coding-agent/docs/sdk.md) and [rpc.md](packages/coding-agent/docs/rpc.md).

### Why is the npm package not called `draht`?
The name `draht` was already taken on npm, so the package is `@draht/coding-agent`. The installed command is still `draht`.

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

Use the exact Bun canary package and revision declared by `packageManager` and `drahtReleaseBunRevision` in the root `package.json`. Dependency lifecycle scripts stay disabled during installation; run required build, check, and test steps explicitly.

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Oskar Freye (Draht) and (c) 2025 Mario Zechner.
