# @draht/templates

AGENTS.md template library for common development stacks. Each template provides project rules, conventions, and tool usage guidelines for AI coding agents.

## Templates

| Template | Stack | File |
|----------|-------|------|
| SST/TypeScript | SST v4, Lambda, DynamoDB, TypeScript | `src/sst-typescript.md` |
| Astro | Astro 5.x, Tailwind CSS, TypeScript | `src/astro.md` |
| Go/gRPC | Go 1.22+, gRPC, Protocol Buffers | `src/go-grpc.md` |

## Usage

Copy the relevant template to your project root as `AGENTS.md` and customize for your specific project:

```bash
cp node_modules/@draht/templates/src/astro.md ./AGENTS.md
```

Or reference directly when setting up a new project with a Draht coding agent.
