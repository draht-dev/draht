# AGENTS.md — SST v4 / TypeScript

## Stack
- **Runtime:** Node.js 20+ / TypeScript 5.x
- **Infrastructure:** SST v4 (AWS serverless IaC)
- **Resources:** Lambda, API Gateway V2, DynamoDB, S3
- **Package Manager:** npm

## Project Structure
```
├── sst.config.ts          # SST resource definitions
├── packages/
│   ├── core/              # Shared types, utilities
│   ├── functions/         # Lambda handlers
│   └── web/               # Frontend (if applicable)
├── tsconfig.json
└── package.json
```

## Rules

### Code Quality
- No `any` types unless absolutely necessary
- Strict TypeScript — `strict: true` in tsconfig
- Use ESM (`"type": "module"`) throughout
- Top-level imports only — no dynamic imports

### SST Resources
- Define all resources in `sst.config.ts`
- Use `Resource` import from `sst` to access linked resources at runtime
- **NEVER run `sst deploy` from development** — use `sst dev` for local development
- Use `link` to pass resource references to functions

### Lambda Handlers
- Each handler in its own file under `packages/functions/`
- Use `APIGatewayProxyHandlerV2` type from `aws-lambda`
- Return proper JSON responses with `statusCode`, `headers`, `body`
- Keep handlers thin — business logic in `packages/core/`

### DynamoDB
- Single-table design where appropriate
- Use `pk` / `sk` naming for partition and sort keys
- Access patterns drive table design, not entity relationships
- Use GSIs sparingly — prefer query flexibility in key design

### Testing
- Unit tests with Vitest
- Test handlers with mocked AWS SDK clients
- Integration tests against local DynamoDB (if available)

### Git
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`
- Atomic commits per logical change
- Never commit `.sst/` directory or AWS credentials

### Commands
```bash
npm run dev          # sst dev — local development
npm run build        # TypeScript compile check
npm run check        # Lint + type check
npm run test         # Run tests
```

## Environment
- AWS credentials via environment or SSO profile
- Stage-based deployment: `dev`, `staging`, `production`
- Secrets via SST Secret resource, not environment variables

## Testing (TDD)
- **Philosophy:** Write tests BEFORE implementation. Red → Green → Refactor.
- **Every task:** Write failing test first, then implement until green, then refactor.
- **No untested code:** If you write to `src/`, there must be a corresponding test.
- **Runner:** vitest or bun:test
- **Pattern:** `*.test.ts` alongside source files or in `test/` directory
- **Coverage:** Target 80% for new code, use c8/istanbul
- **Mocking:** Use vitest mock or bun mock for external dependencies

## Domain-Driven Design (DDD)
- **Domain model is required:** Every project starts with entities, value objects, aggregates, and bounded contexts defined in PROJECT.md.
- **Ubiquitous language:** Use domain terms consistently in code, comments, variables, and documentation. Check the glossary.
- **Bounded contexts:** Don't cross aggregate boundaries in a single task. Each bounded context has its own module/package.
- **Naming:** Class/type names must match domain glossary terms. CI will flag violations.
