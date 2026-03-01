# /map-codebase

Analyze existing codebase before planning.

## Usage
```
/map-codebase [directory]
```

## Steps
1. Run `draht map-codebase [dir]`
2. Tool generates: STACK.md, ARCHITECTURE.md, CONVENTIONS.md, CONCERNS.md
3. Review output, supplement with your own analysis if needed
4. Identify implicit bounded contexts from directory structure:
   - Look for top-level `src/` subdirectories, packages, or modules that encapsulate a coherent domain concept
   - Note any cross-directory coupling that suggests context boundaries are blurred
5. Extract domain language from existing code:
   - Collect PascalCase class/interface/type names, key function names, and database table/collection names
   - Look for repeated nouns that represent core domain concepts (e.g., `Order`, `Invoice`, `Subscription`)
6. If `.planning/DOMAIN.md` does not already exist, create it with:
   - `## Bounded Contexts` — one entry per discovered context with a brief description
   - `## Ubiquitous Language` — glossary of extracted domain terms
   - `## Context Map` — rough diagram or list showing how contexts relate
   - `## Aggregates` — list aggregates and their root entities per context
   - `## Domain Events` — any existing event names or patterns discovered
7. Discover test infrastructure and document findings in `.planning/TEST-STRATEGY.md`:
   - Test framework(s) in use (Jest, Vitest, Bun test, Mocha, etc.)
   - Test directory conventions (co-located, `__tests__/`, `test/`, etc.)
   - Existing coverage configuration and goals (if any)
   - Which layers have tests today (unit, integration, e2e)
   - Gaps and recommendations
8. Commit: `draht commit-docs "map existing codebase"`
