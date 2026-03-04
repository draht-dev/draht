# /init-project

Scaffold `.draht/` configuration into an existing project from global agent defaults.

## Usage
```
/init-project
```

Use this when you already have a git repo and want to add GSD methodology support.
For creating a brand new project from scratch, use `/new-project` instead.

## Steps
1. Check if `.draht/` already exists — if so, warn and stop
2. Create directory structure:
   ```
   .draht/
     agents/       — agent definitions (copied from ~/.draht/agent/agents/)
     extensions/   — project-local extensions
     settings.json — project settings
   ```
3. Copy agent definitions from `~/.draht/agent/agents/*.md` into `.draht/agents/`
4. Create `.planning/` directory for GSD state tracking
5. Report what was scaffolded and suggest next steps:
   - Customize `.draht/agents/*.md` for the project's stack
   - Run `/new-project` to go through the full questioning + planning flow
   - Or run `/plan-phase 1` to jump straight into planning
