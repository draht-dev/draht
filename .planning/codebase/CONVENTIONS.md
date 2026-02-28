# Conventions

## Code Style
- No `any` types unless absolutely necessary
- No inline/dynamic imports — always top-level
- Biome for formatting and linting (biome.json at root)
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`

## Testing
- Vitest test framework
- Tests colocated in `test/` directories per package
- Run specific: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Never run `npm test` from root

## Module System
- ESM (`"type": "module"`) throughout
- `.js` extensions in imports (TypeScript ESM convention)

## Git
- Never `git add -A` — always specific files
- Never `git reset --hard`, `git stash`, `git clean -fd`
- Include `fixes #N` in commits when applicable
- Lockstep versioning across all packages

## Extension Development
- Use `ExtensionAPI` (pi) for registration
- Use `ExtensionContext` (ctx) in handlers
- TypeBox for parameter schemas
- Return typed results from tools
