# @draht/router

Role-based model routing with direct API calls, automatic fallback, and cost tracking.

## Overview

The router maps task roles to LLM provider/model combinations with ordered fallback chains. Calls go directly to each provider API; OpenRouter is used only for models it hosts (the DeepSeek fallbacks below).

## Configuration

Config is loaded from (in priority order):
1. `.draht/router.json` (project-level)
2. `~/.draht/router.json` (global)
3. Built-in defaults

### Example `.draht/router.json`

```json
{
  "architect": {
    "primary": { "provider": "anthropic", "model": "claude-opus-5-5" },
    "fallbacks": [{ "provider": "google", "model": "gemini-2.5-pro" }]
  },
  "implement": {
    "primary": { "provider": "anthropic", "model": "claude-sonnet-5" },
    "fallbacks": [
      { "provider": "openai", "model": "gpt-6.1-sol" },
      { "provider": "openrouter", "model": "deepseek/deepseek-v3.2" }
    ]
  }
}
```

## Default Role Mapping

| Role | Primary | Fallbacks |
|------|---------|-----------|
| architect | anthropic/claude-opus-5-5 | google/gemini-2.5-pro |
| implement | anthropic/claude-sonnet-5 | openai/gpt-6.1-sol → openrouter/deepseek/deepseek-v3.2 |
| boilerplate | openrouter/deepseek/deepseek-v3.2 | google/gemini-2.5-flash |
| quick | google/gemini-2.5-flash | openrouter/deepseek/deepseek-v3.2 |
| review | anthropic/claude-sonnet-5 | — |
| docs | openai/gpt-6.1-sol | anthropic/claude-sonnet-5 |
| rlm-root | anthropic/claude-opus-5-5 | google/gemini-2.5-pro |
| rlm-sub | google/gemini-2.5-flash | openrouter/deepseek/deepseek-v3.2 |

## CLI Usage

```bash
# Show current configuration
draht router show

# Set model for a role
draht router set implement anthropic/claude-sonnet-5 --fallback openai/gpt-6.1-sol,openrouter/deepseek/deepseek-v3.2

# Test resolution (dry-run)
draht router test
draht router test architect

# View cost summary
draht router cost
```

## Fallback Behavior

When the primary model fails with a retryable error (429, 5xx, timeout), the router automatically tries the next model in the fallback chain. Non-retryable errors (401, 400) are thrown immediately.

## Cost Tracking

Every API call is logged to `.draht/cost-log.jsonl` with:
- Timestamp, role, provider/model
- Input/output token counts
- Estimated cost in USD
- Session ID

## Coding Agent Extension

```typescript
import { createRouterExtension } from "@draht/router/extension";

const ext = createRouterExtension();
const model = ext.selectModel("implementation"); // → anthropic/claude-sonnet-5
const chain = ext.selectModelWithFallbacks("architecture"); // → full fallback chain
```

Task types are automatically mapped to roles:
- `planning`, `architecture` → architect
- `implementation`, `coding` → implement
- `scaffold`, `boilerplate` → boilerplate
- `question`, `quick` → quick
- `review`, `pr-review` → review
- `documentation`, `readme` → docs
