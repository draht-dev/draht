# Phase 6 Context: CI/CD AI Review Pipeline

## Domain Boundary
GitHub Action that reviews PRs using Claude with AGENTS.md context. Posts inline comments, blocks merge on critical findings.

## Decisions

### GitHub Action Design
- **Action type:** Composite action with TypeScript entry point (uses bun for runtime)
- **Trigger:** `pull_request` event (opened, synchronize)
- **Inputs:** model (default claude-sonnet-4), agents-md-path, severity-threshold (info/warning/critical)
- **Secrets:** ANTHROPIC_API_KEY

### Review Pipeline
- **Diff fetching:** GitHub API via octokit to get PR diff
- **Context:** AGENTS.md content + diff sent to Claude
- **Output:** Inline review comments via GitHub API, check run status
- **Blocking:** If severity >= threshold → set check status to failure

### Package Structure
- **Location:** `packages/ci/` as @draht/ci
- **Entry:** `src/action.ts` — main action logic
- **Action definition:** `action.yml` at package root
- **No build step needed** — runs via bun directly

## Claude's Discretion
- Exact prompt engineering for review quality
- Comment formatting and grouping
- Rate limiting strategy for large PRs

## Deferred Ideas
- Support for other LLM providers
- Custom review rules per project
- Review summary PR comment
