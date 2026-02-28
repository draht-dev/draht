# Phase 9 Context: Deploy Guardian Extension

## Domain Boundary
Coding agent extension for pre-deployment safety. Checks, Lighthouse integration, rollback automation. Never auto-deploys.

## Decisions
- **Extension pattern:** Same as knowledge/orchestrator — factory function with commands
- **Safety first:** All deploy-related commands require explicit confirmation
- **Lighthouse:** Shell out to `lighthouse` CLI (user must have it installed)
- **SST safety:** Detect SST projects, block any `sst deploy` in agent bash commands
- **Rollback:** Git-based (tag last known good, revert to it)
