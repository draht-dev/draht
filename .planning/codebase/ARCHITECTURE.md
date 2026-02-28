# Architecture

## Monorepo Structure
```
packages/
├── ai/              # LLM abstraction (providers, streaming, models)
├── agent/           # Agent core (state, tools, transport)
├── coding-agent/    # CLI agent app (extensions, sessions, TUI)
│   ├── src/
│   │   ├── core/    # Extensions, compaction, session management
│   │   ├── cli/     # CLI arg parsing
│   │   ├── modes/   # interactive, rpc, print modes
│   │   └── utils/
│   ├── test/
│   └── examples/    # Extension examples
├── tui/             # Terminal UI primitives
├── web-ui/          # Web chat components (SvelteKit)
├── mom/             # Slack integration
└── pods/            # GPU pod management
```

## Key Patterns
- **Extension system** (coding-agent): Factory functions register tools, commands, event handlers
- **Multi-provider LLM** (ai): Unified API over OpenAI, Anthropic, Google, etc.
- **Session tree** (coding-agent): Branching conversation history with compaction
- **Transport abstraction** (agent): Decouple agent logic from I/O

## Data Flow
1. User input → coding-agent CLI → agent core → ai (LLM call)
2. LLM response → tool calls → agent executes tools → results back to LLM
3. Extensions hook into any point via event system

## Extension Discovery
- `packages/coding-agent/src/core/extensions/loader.ts` — finds & loads extensions
- Extensions can be local files, npm packages, or inline
- TypeBox schemas define tool parameters
