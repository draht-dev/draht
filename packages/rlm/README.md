# @draht/rlm

Recursive Language Models (RLM) core primitives — the inference-time scaffold
from Zhang, Kraska, Khattab (2026), *Recursive Language Models*
(arXiv:2512.24601): root-LLM-produces-code → REPL-executes →
truncated-stdout → history-append → FINAL-check.

## Status

Scaffold only. See
`.planning/phases/26-rlm-core-primitives/26-01-PLAN.md` for the full
architecture and task breakdown:

- `RlmSession` root loop (`src/session.ts`) — not yet implemented.
- Python REPL driver (`python/repl_driver.py`) — not yet implemented.
- `llm_query` RPC-over-pipes mechanism, `FINAL`/`FINAL_VAR` sentinels — not
  yet implemented.

`llm_query` and the root LLM are both injectable TypeScript callbacks; this
package does not hardcode a real LLM provider. Real `@draht/router` wiring
lands in a later phase.

## Development

```bash
npm install          # from repo root, resolves this workspace package
cd packages/rlm
npx tsgo --noEmit    # typecheck
npm test             # vitest
```
