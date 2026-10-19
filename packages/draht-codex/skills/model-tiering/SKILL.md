---
name: model-tiering
description: Choose executor, advisor, and orchestrator models when configuring a workflow's quality, cost, and latency tradeoffs.
---

# Model Tiering

Use an executor for routine work and a stronger advisor or orchestrator where its judgment improves the result. Select available models from the host's current catalog.

- **Advisor tier** — a model with stronger performance on the task's difficult decisions
- **Executor tier** — a faster or cheaper model capable of the implementation work

Tiering does not guarantee savings or better results. Compare executor-only, executor-with-advisor, and stronger-model-only runs on representative tasks; measure accepted results, total billed tokens, latency, and retries. Re-evaluate when model versions or workflow prompts change. API behavior and current guidance: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool>.

## Pattern 1 — Advisor: the executor pulls intelligence down

Run the session on the executor tier; dispatch the `advisor` agent (pinned to the strongest tier) rarely and deliberately:

- **Once early** — after orientation (finding files, reading what's there) but BEFORE substantive work: writing, committing to an interpretation, building on an assumption
- **When stuck** — recurring errors, an approach that is not converging, results that don't fit
- **Once before declaring done** on hard tasks — after writes and test output exist; save the deliverable before the consult and commit only when the task authorizes it

Treat the advice with serious weight: deviate only on empirical failure or primary-source contradiction. If your evidence points one way and the advisor points another, don't silently switch — surface the conflict in one reconcile consult ("I found X, you suggest Y — which constraint breaks the tie?").

Target ~1–3 consults per task. On short reactive tasks where the next action is dictated by output just read, skip the advisor — its value is highest before the approach crystallizes.

## Pattern 2 — Orchestrator: the strong model pushes work down

Run orchestrating sessions (`/orchestrate`, `/orchestrate-loop`, `/plan-phase`, `/execute-phase`) on the strongest tier and let workers execute on the executor tier. The orchestrator plans, decomposes, dispatches, and verifies; workers burn the volume tokens at the lower rate.

Pin worker models per agent via the plugin's `configure` command (it writes `model:` into the agent frontmatter). Keep `spec-reviewer` and the final verification gate on a strong tier — verifier quality bounds loop quality.

## Choosing

| Workload | Pattern |
|---|---|
| Mostly mechanical, occasional hard decisions | Advisor — one context, rare consults |
| Sustained planning and decomposition quality needed | Orchestrator — the strong model steers throughout |
| Long loops (`/orchestrate-loop`) | Orchestrator, with `advisor` consulted on stall |

The patterns compose: an orchestrating session on the executor tier can still pull `advisor` for its hardest decisions.

## API-level advisor (built harnesses)

For agents built directly on the Claude API (e.g. draht's own harness code), the advisor exists as a server-side tool: `{"type": "advisor_20260301", "name": "advisor", "model": "<advisor model id>"}` with beta header `advisor-tool-2026-03-01`. The executor calls `advisor()` with no input; the server forwards the full transcript to the advisor model and only the advice text returns. Cap cost with `max_uses` and `max_tokens` on the tool definition; trim advice length with an inline user-message request ("Advisor: please keep your guidance under 80 words").
