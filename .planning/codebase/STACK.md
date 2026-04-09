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
| ai | @draht/ai | Multi-provider LLM API |
| agent | @draht/agent-core | Agent runtime + state |
| coding-agent | @draht/coding-agent | CLI coding agent (4 tools + extensions) |
| tui | @draht/tui | Terminal UI library |
| web-ui | @draht/web-ui | Web chat components |
| mom | @draht/mom | Slack bot delegate |
| pods | @draht/coding-agent | vLLM GPU pod management |

## Extension System
- Factory function pattern: `(pi: ExtensionAPI) => void`
- Event-driven: lifecycle hooks, tool registration, command registration
- Supports custom providers, tools, UI components
