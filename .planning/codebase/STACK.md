# Technology Stack

## Languages
- TypeScript 5.9+ (primary)
- Node.js 20+ runtime

## Package Manager
- npm workspaces (monorepo)
- package-lock.json lockfile

## Build Tools
- TypeScript compiler (tsc) + tsgo (native preview)
- tsx for runtime execution
- Biome 2.3 for linting/formatting
- Vitest for testing
- Husky for git hooks

## Key Dependencies
- `@sinclair/typebox` — runtime type validation (used in extension tool definitions)
- `@mariozechner/jiti` — JIT TypeScript imports for extensions
- `koffi` — FFI bindings (native terminal support)

## Packages (7)
| Package | npm Name | Purpose |
|---------|----------|---------|
| ai | @mariozechner/pi-ai | Multi-provider LLM API |
| agent | @mariozechner/pi-agent-core | Agent runtime + state |
| coding-agent | @mariozechner/pi-coding-agent | CLI coding agent (4 tools + extensions) |
| tui | @mariozechner/pi-tui | Terminal UI library |
| web-ui | @mariozechner/pi-web-ui | Web chat components |
| mom | @mariozechner/pi-mom | Slack bot delegate |
| pods | @mariozechner/pi | vLLM GPU pod management |

## Extension System
- Factory function pattern: `(pi: ExtensionAPI) => void`
- Event-driven: lifecycle hooks, tool registration, command registration
- Supports custom providers, tools, UI components
