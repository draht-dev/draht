---
description: Investigate why code is the way it is — design rationale, history, rejected alternatives — via parallel evidence investigators and a confidence-tiered, citation-backed synthesis
argument-hint: "<file, symbol, or question>"
allowed-tools: Bash, Read, Task
---

# /why

Reconstruct why code is the way it is — the design rationale, the history, the rejected alternatives — from the evidence the repository and its surroundings actually carry. The output is a confidence-tiered, citation-backed answer with an explicit coverage map, never a plausible story.

## Usage
```
/why <file, symbol, or question>
```

Question: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch one `investigator` agent per available evidence category in parallel when your host allows it (single assistant turn = multiple subagent calls). To escalate a contested synthesis, consult the `advisor` agent.

## Routing

`/why` answers intent, history, and forces. Something misbehaving right now is a defect — route it to `/fix`, which is reproduction-gated. A `/why` run that uncovers a live defect hands off to `/fix`; a `/fix` that needs design intent (is this behaviour a decision or an accident?) consults `/why`. For structure and architecture walkthroughs — what the code IS rather than why it is that way — use `/map-codebase`.

## Epistemics

Every claim in the output follows the `epistemics` skill — five confidence tiers, cite-or-label-as-inference, null results as evidence. Load it before synthesising; the epistemic framing is the product, and de-hedging it to sound authoritative is the exact failure this command exists to prevent.

## Steps

### 1 — Parse the target and the question archetype

Identify what is being asked about (file, symbol, pattern, value) and which archetype the question is: design rationale ("why is this a queue?"), tradeoff-vs-alternative ("why X instead of Y?"), defensive reasoning ("why the triple-check here?"), external forcing function ("why did this change in March?"), dead code ("why does this exist at all?"), or a broad sweep ("why is this module shaped like this?"). If the target is vague, state your best-guess interpretation from context and proceed — do not block on a clarifying question.

### 2 — Build the code anchor

Cheap, done once by the lead, pasted into every brief:

- file paths and line ranges; the key symbols involved
- `git blame -L <range> <file>` on the target lines
- `git log --follow --oneline -20 <file>`
- PR numbers extracted from `(#N)` commit subjects; for each, `gh pr view <n> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews`
- linked ticket and ADR identifiers found along the way
- optionally a pasted `draht-tools graph-context <file>` slice for orientation (lead-only; subagents cannot run draht-tools)

### 3 — Probe the evidence map

Five categories. Probe availability before dispatching; each row is the assigned investigator's playbook.

| Category | Availability probe | What it uniquely surfaces + playbook |
|---|---|---|
| Git history | Always available | Pickaxe (`git log -S`/`-G`), blame, `git show`; test names encoding edge cases; `red:`/`green:`/`refactor:` and `docs:` prefixes as semantic signal. Pitfalls: squash flatlands → fall back to the PR record; misleading messages → read the diff; cargo-culted patterns → investigate the origin commit; bot commits carry no motivation. |
| Review record | `git remote` + `gh auth status` | PR bodies, review threads, linked issues — the argument that happened before merge, including rejected alternatives. |
| Planning record | `.planning/` exists | `STATE.md` `## Decisions` (dated, attributed) and `## Lessons`; `phases/NN-*/` PLAN, SUMMARY, VERIFICATION, and UAT files (observed/derived/assumed labels); `specs/`; `quick/`; `loop/PROGRESS.md`; `CONTINUE-HERE.md`. Probe before assuming `.planning/decisions/` and `.planning/tickets/` — they exist only when a grill chose that output. |
| Decision records | `docs/adr/` and `CHANGELOG.md` files exist | ADR titles are decisions; dated Update blocks cite forcing commits; per-package changelogs date user-visible shifts. |
| External systems | A registered extension tool only | Tracker, chat, observability, error tracking, analytics — the conversational and operational record. Searchable only via a project-registered tool; when none exists, do not dispatch: record one Sources Consulted gap line — "External records: unavailable — no tool registered in this runtime; the conversational and operational record was not searched." |

The map is extensible: a project-registered tool adds an investigator with the same brief shape; an unavailable category is a coverage gap, never a silent drop.

**Incident overlay**: when the target looks defensive — null guards, retry, timeout, rate limiting, feature flags — instruct every investigator to hunt incident-shaped evidence inside its own category: revert-then-reapply chains, `## Lessons` entries, ADR Update blocks, UAT failure verdicts.

### 4 — Dispatch parallel investigators

Dispatch one investigator per AVAILABLE category, all in a single assistant turn when the host allows it; if the category count exceeds what the host can dispatch at once, fold overflow into the nearest category. Skip rules:

- A skip needs a written justification that surfaces in Sources Consulted. Unavailability is a gap, not a choice.
- "Provably irrelevant, not just probably" — a build-time script with no runtime path provably cannot appear in runtime error tracking; "it's feature code, error tracking won't have anything" is a guess, so search it.

Each brief is standalone:

```
You are investigating ONE evidence category for a why-question. Gather evidence, not narrative — a verbatim quote with a precise citation beats a paragraph of plausible summary.

Question: <the question and its archetype>

Code anchor:
<the anchor from Step 2>

Your category: <name + the playbook row from Step 3>
<if the incident overlay applies: hunt incident-shaped evidence inside your category — revert/re-apply chains, Lessons entries, ADR Update blocks, UAT failure verdicts>

Report using exactly these sections: Source / What I Searched (queries verbatim) / Direct Evidence Found / Indirect-Circumstantial Evidence (inference chain + alternative readings) / Contradictions / Gaps / Additional Leads.

Stay inside your category; record cross-category references under Additional Leads for the owning investigator — never chase them.

Do NOT run draht, draht-tools, or pi commands.

End with STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

`NEEDS_CONTEXT` / `BLOCKED` → supply the missing info and re-dispatch. Hard cap: 3 re-dispatches total.

### 5 — Synthesize (the lead, in this context)

- Investigator claims are inputs, not verdicts — spot-verify load-bearing citations with git/gh before repeating them.
- Merge duplicate citations into one authoritative reference.
- Surface contradictions without picking a side.
- Tier every claim per the `epistemics` skill.
- Hand each investigator's Additional Leads to the owning category's follow-up, or record them as gaps.
- When competing hypotheses are decision-changing for an imminent code change, consult the `advisor` agent with the tiered findings for a steer.

### 6 — Output contract

Exact section order:

1. **The Question**
2. **The Code in Question** — what it does mechanically, in two or three sentences
3. **What We Found** — [Direct] and [Supported] bullets, each cited
4. **What We Can Reasonably Infer** — [Inferred] bullets with the chain visible: "Given A and B, C is likely because D"
5. **Competing Hypotheses** — hypothesis + evidence for + evidence against. Don't force a winner. Skip only when there is one clear answer.
6. **What We Don't Know** — specific searches that came up empty, named unavailable sources, people who would know
7. **Sources Consulted** — one line per category INCLUDING empties, gaps, and justified skips: `- <Category>: <what was searched>. <found / no relevant results / skipped: reason / unavailable: gap>`
8. **Confidence Summary** — 1-2 sentences

**Closing hook**: when the question precedes a change, convert the findings into a Preserve / Change / Avoid / Risk constraint set suitable for `/discuss-phase` or `/plan-phase`.

**Effort valve**: a trivial single-commit target whose PR or commit already answers the question may be handled inline by the lead running the git-history archaeology itself — only after stating why the other available categories would be redundant. The output contract and the coverage map still apply.

## Failure Modes — STOP

Stop immediately if you catch yourself:

- **Confident storytelling** — an uncited bullet belongs under Inferred or Hypotheses, never under What We Found
- Citing code as evidence of its own intent
- Recency bias — explaining an accretion as one decision; trace back
- Sycophantic agreement with the asker's embedded hypothesis
- Skipping the gaps section
- Skipping investigators by anticipation — a null result is a data point; a skipped search is a blind spot
- Collapsing categories into one investigator

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "The commit message says X, done" | One source is a lead, not a verdict — the record contradicts itself more often than it lies consistently. |
| "The code obviously does this for performance" | Code is mechanics; motivation needs an external source or an [Inferred] label. |
| "The user already told me why" | That is a hypothesis; check it independently. |
| "No .planning/ here, nothing to search" | git and gh still exist; report the missing categories as gaps, don't invent. |
