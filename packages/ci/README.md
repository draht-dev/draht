# @draht/ci

CI/CD review pipeline for the Draht coding agent. Automates GitHub PR reviews using AI.

## Features

- **PR Reviewer** — AI-powered code review for GitHub pull requests
- **GitHub Integration** — Direct GitHub API integration for PR comments
- **Action** — Runnable as a GitHub Action step

## Usage

```typescript
import { reviewer } from "@draht/ci";
```

## Exports

| Export | Description |
|--------|-------------|
| `reviewer` | PR review logic |
| `github` | GitHub API client |
| `action` | GitHub Action entry point |
