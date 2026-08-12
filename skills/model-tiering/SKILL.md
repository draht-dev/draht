---
name: model-tiering
description: Cost-efficient model tiering — the advisor pattern (a cheap executor consults a stronger model rarely) and the orchestrator pattern (a strong model plans while cheaper workers execute). Use when choosing which model runs a session vs its subagents, when cost matters on long agentic work, or when the user mentions "Fable", "advisor", "model tiering", "token cost", "cheaper model", or asks which model should drive a workflow.
---

# Model Tiering

Two tiers, two directions of pull. Bill the volume tokens at the cheaper rate and spend the strongest model only where a single decision changes the outcome.

- **Advisor tier** — the strongest model available (Claude Fable 5)
- **Executor tier** — a fast, capable model (Claude Sonnet 5)

Reference numbers (SWE-bench Pro): a Sonnet 5 executor with a Fable 5 advisor reaches ~92% of Fable 5's solo score at ~63% of the price, with the advisor consulted roughly once per task. Official reference: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool>

## Pattern 1 — Advisor: the executor pulls intelligence down

Run the session on the executor tier; dispatch the `advisor` agent (pinned to the strongest tier) rarely and deliberately:

- **Once early** — after orientation (finding files, reading what's there) but BEFORE substantive work: writing, committing to an interpretation, building on an assumption
- **When stuck** — recurring errors, an approach that is not converging, results that don't fit
- **Once before declaring done** on hard tasks — after writes and test output exist; make the deliverable durable (commit it) before the consult

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
