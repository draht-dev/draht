# Phase 1 Context: Rebrand

## Decisions
- Package name mapping:
  - `@draht/ai` → `@draht/ai`
  - `@draht/agent-core` → `@draht/agent-core`
  - `@draht/coding-agent` → `@draht/coding-agent`
  - `@draht/tui` → `@draht/tui`
  - `@draht/web-ui` → `@draht/web-ui`
  - `@draht/mom` → `@draht/mom`
  - `@draht/coding-agent` → `@draht/pods`
  - `@mariozechner/jiti` → keep as-is (external dep, not ours)
- Root package: `pi-monorepo` → `draht-monorepo`
- README: Replace Pi branding with Draht, keep fork attribution section
- LICENSE: Add "Copyright (c) 2026 Oskar [Draht]" above original copyright
- AGENTS.md: Update repo-specific references but keep coding rules intact
- `pi-mono.code-workspace` → `draht-mono.code-workspace`
- Approach: `sed` bulk replace for .ts files, manual edits for .json/.md

## Scope
- Package names in all package.json files
- Import statements in all .ts files (246 files)
- README.md, AGENTS.md, CONTRIBUTING.md
- LICENSE, workspace file
- tsconfig references
- Do NOT touch node_modules or package-lock.json (regenerate via npm install)
