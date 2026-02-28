# Concerns

## Rebranding Scope
- 7 packages all under `@mariozechner/pi-*` namespace — cross-references everywhere
- Internal imports reference package names extensively
- README, AGENTS.md, CONTRIBUTING.md all reference pi-mono/badlogic

## Not Needed for Draht
- `pods` package (vLLM GPU management) — likely out of scope
- `mom` package (Slack bot) — may be replaced with custom integration
- `web-ui` — evaluate if needed

## Build Complexity
- Sequential build order required (tui → ai → agent → coding-agent → mom → web-ui → pods)
- Some packages have circular-ish dev dependencies

## No SST Infrastructure Yet
- Greenfield addition — no existing IaC patterns to follow
- Need to add SST v4 as new package without breaking existing build
