# DRAHT — Dynamic Routing for Agent & Task Handling

## Vision
A custom AI agent harness for DACH freelancing, built on Pi Agent's minimal core (4 tools, extension system, model-agnostic). Draht adds serverless infrastructure, stack-specific extensions, client knowledge persistence, and multi-agent orchestration optimized for solo freelancers scaling to teams.

## Fork Origin
Forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (Pi Agent by Mario Zechner). MIT licensed.

## Domain
draht.dev

## Goals
1. Rebrand pi-mono → @draht/ namespace while preserving upstream compatibility
2. Add SST v4 infrastructure layer (AWS serverless IaC)
3. Create stack-specific coding agent extensions (SST Resource Manager)
4. Provide AGENTS.md template library for common stacks (SST/TS, Astro, Go/gRPC)
5. Foundation for client knowledge persistence and DACH compliance (future phases)

## Constraints
- Never run `sst deploy` during development
- Keep MIT license with fork attribution to Mario Zechner
- Atomic git commits per task
- Astro (not Next.js) for web framework templates
- Monorepo workspace structure must remain npm workspaces

## Tech Stack
- TypeScript 5.9+ / Node.js 20+
- SST v4 (AWS serverless IaC)
- Pi Agent extension system (TypeBox, event-driven)
- Astro (web framework in templates)
- Go (template only)

## Success Criteria
- All packages build under @draht/ namespace
- SST v4 infra package defines Lambda, API Gateway, DynamoDB resources
- SST Resource Manager extension is loadable by coding-agent
- 3 AGENTS.md templates (SST/TS, Astro, Go/gRPC) are usable
- Existing pi-mono tests still pass after rebrand
