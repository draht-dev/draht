# Contributing to Draht

Thanks for wanting to contribute! This guide exists to save both of us time.

## The One Rule

**You must understand your code.** If you can't explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. You can gain understanding by interrogating an agent with access to the codebase until you grasp all edge cases and effects of your changes. What's not fine is submitting agent-generated slop without that understanding.

If you use an agent, run it from the `draht-mono` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## First-Time Contributors

We use an approval gate for new contributors:

1. Open an issue describing what you want to change and why
2. Keep it concise (if it doesn't fit on one screen, it's too long)
3. Write in your own voice, at least for the intro
4. A maintainer will comment `lgtm` if approved
5. Once approved, you can submit PRs

This exists because AI makes it trivial to generate plausible-looking but low-quality contributions. The issue step lets us filter early.

## Development Setup

```bash
bun install          # Install all dependencies
bun run build        # Build all packages
bun run check        # Lint + format (biome) + type check (tsgo)
bun run test         # Run all tests
```

### Tooling

- **Package manager:** bun (not npm)
- **Type checker:** tsgo (not tsc)
- **Linter/formatter:** biome
- **Test runner:** vitest
- **Infrastructure:** SST v4 (⚠️ never run `sst deploy` manually)

## Before Submitting a PR

```bash
bun run check    # must pass with no errors
bun run test     # must pass
```

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you're adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Project Structure

See the [main README](README.md) for the full package listing and architecture diagram.

## Philosophy

Draht's core is minimal. If your feature doesn't belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

Extensions can register tools, commands, providers, themes, skills, and prompt templates. See [Extension Docs](packages/coding-agent/docs/extensions.md).

## Questions?

Open an issue on [GitHub](https://github.com/nichochar/draht).
