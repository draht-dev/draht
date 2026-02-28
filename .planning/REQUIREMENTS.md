# Requirements

## v1 (Must Have)

### R1: Rebrand to @draht/ namespace
- R1.1: Update all package.json names from `@mariozechner/pi-*` to `@draht/*`
- R1.2: Update internal cross-package imports/references
- R1.3: Update README.md with Draht branding, keep fork attribution
- R1.4: Update AGENTS.md, CONTRIBUTING.md references
- R1.5: Update LICENSE to add Draht copyright while keeping original MIT

### R2: SST v4 Infrastructure Package
- R2.1: Create `packages/infra/` with package.json (@draht/infra)
- R2.2: SST v4 config (sst.config.ts) with AWS provider
- R2.3: Lambda function resources
- R2.4: API Gateway (HTTP API) resource
- R2.5: DynamoDB table resources (sessions, clients)
- R2.6: TypeScript IaC following SST v4 patterns

### R3: SST Resource Manager Extension
- R3.1: Extension that registers tools for querying SST resource state
- R3.2: Tool: `sst_status` — show deployed stack status (reads .sst/ metadata, NOT deploy)
- R3.3: Tool: `sst_resources` — list defined resources from sst.config.ts
- R3.4: Follows Pi Agent extension factory pattern

### R4: AGENTS.md Template Library
- R4.1: Create `packages/templates/` with package.json (@draht/templates)
- R4.2: SST/TypeScript AGENTS.md template
- R4.3: Astro AGENTS.md template
- R4.4: Go/gRPC AGENTS.md template
- R4.5: Each template includes project rules, conventions, tool usage

### R5: Monorepo Workspace Config
- R5.1: Add new packages to root workspaces array
- R5.2: Update build scripts to include new packages
- R5.3: Ensure `npm install` resolves cleanly

### R5-KB: Client Knowledge Base Extension
- R5-KB.1: Create `packages/knowledge/` with package.json (@draht/knowledge)
- R5-KB.2: Zvec integration for local vector DB operations (index, search, update)
- R5-KB.3: Per-client knowledge store (AGENTS.md, decisions, patterns) with namespace isolation
- R5-KB.4: Coding agent extension that auto-loads client context on session_start
- R5-KB.5: CLI commands for knowledge management (index, search, forget)

### R6-CI: CI/CD AI Review Pipeline
- R6-CI.1: Create `packages/ci/` with package.json (@draht/ci)
- R6-CI.2: GitHub Action YAML (action.yml) with inputs for model, AGENTS.md path, severity threshold
- R6-CI.3: TypeScript action that fetches PR diff, sends to Claude with AGENTS.md context
- R6-CI.4: Posts inline review comments, blocks merge on critical findings via check status

### R7-MA: Multi-Agent Orchestration
- R7-MA.1: Create `packages/orchestrator/` with package.json (@draht/orchestrator)
- R7-MA.2: GSD Controller pattern: task → plan → spawn sub-agents → synthesize results
- R7-MA.3: Ticket Decomposer: break tickets into agent-sized sub-tasks with dependency graph
- R7-MA.4: Sub-agent coordination with result synthesis and failure handling

### R8-WF: n8n Client Workflows
- R8-WF.1: Create `packages/workflows/` with package.json (@draht/workflows)
- R8-WF.2: Client onboarding workflow (form → repo → Notion → AGENTS.md → invoice)
- R8-WF.3: Daily AI standup workflow (git commits → summarize → post to channel)
- R8-WF.4: Invoice + time tracking workflow template

### R9-DG: Deploy Guardian Extension
- R9-DG.1: Coding agent extension for pre-deployment safety checks
- R9-DG.2: Lighthouse + load testing integration (run checks, report results)
- R9-DG.3: Rollback automation (detect failure → rollback to last known good)
- R9-DG.4: SST-specific safety (never auto-deploy, always verify, check resource drift)

## v2 (Nice to Have)
- DACH compliance module (Datenschutz, EU AI Act)
- Draht CLI wrapper around pi coding-agent
- draht.dev website

## Out of Scope
- Deploying any AWS resources
- Modifying Pi Agent core logic (ai, agent, tui packages internals)
- Custom LLM providers
