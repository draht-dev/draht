---
description: Grill any subject in whole-frontier question rounds — an idea, a spec, raw tickets, an architecture decision, or an open discussion; the output form is chosen at the end, not presumed at the start
argument-hint: "[subject]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /grill

Interrogate the subject relentlessly until you reach a shared understanding. A grill has no fixed outcome: it can end in a refined spec, a ticket list, a decision record, plain notes, or nothing but the conversation. The output form is chosen at the end, never presumed at the start.

## Usage
```
/grill [subject]
```

Subject: $ARGUMENTS

> **Tool note**: For environment facts, use the **Task tool** with `subagent_type: "architect"` — read-only fact-finding; never block the current round on it.

## The Design Tree

Map the subject as a **design tree**: every decision branches into the decisions that hang off it. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you haven't heard yet.

## Rounds

1. **Orient without blocking.** Skim what the subject names before round 1: files mentioned in it, `.planning/` if present, recent git history. Dispatch fact-finders for anything deeper — do not hold the first round for them.
2. **Ask the WHOLE frontier in one message.** Number every question, foundational → detailed, and give each one a recommended answer:

   ```
   **Q1 — <title>**: <body; may offer options>
   *Recommended:* <your recommended answer>

   ---

   **Q2 — <title>**: <body>
   *Recommended:* <your recommended answer>
   ```

3. **Defer dependent questions.** A question whose answer depends on another question still open this round belongs to a later round — asking it now means guessing at an answer you haven't heard.
4. **Let the user answer by number.** "1 yes, 2: B, 4 later" is a complete reply. Anything accepted by number or answered explicitly is **decided**. A recommendation acted on without confirmation is **assumed** and stays flagged until the user confirms it.
5. **Recompute and repeat.** Every answer reshapes the tree: settled decisions push the frontier outward and unblock the questions that hung off them. Recompute the frontier and ask the next round.

## Facts Are Your Job

Finding facts is your job, never the user's. When a frontier question needs an environment fact — filesystem, git history, code structure, existing docs — dispatch a fact-finder instead of asking. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now. Decisions belong to the user: put each one to them and wait.

## Done

The grill is done when the frontier is empty: every branch of the tree visited, nothing left silently assumed. Present the decided-vs-assumed summary, then — and only then — ask which artifact to produce:

1. **Refined spec** → `.planning/specs/YYYY-MM-DD-<slug>-design.md`. When it describes a project to build, offer to hand off to `/new-project` or `/init-project`.
2. **Ticket list** → `.planning/tickets/YYYY-MM-DD-<slug>.md`
3. **Decision record** → `.planning/decisions/YYYY-MM-DD-<slug>.md`
4. **Plain notes** → a file the user names

When no `.planning/` directory exists, every mode becomes a standalone file the user names. "No artifact" is a valid answer — sometimes the conversation was the point. Never start implementing or invoke a planning command without the user's explicit go-ahead.

## Anti-Patterns — STOP

- **Dribbling questions one at a time** — a serial interview hides the decision tree and wastes rounds; ask the whole frontier, numbered, with recommended answers
- **Asking the user for facts the environment can answer** — filesystem, git history, and code structure are yours to look up
- **Blocking a whole round on a running fact-finder** — only the questions downstream of it wait; ask the rest now
- **Presuming the outcome at round 1** — deciding early that this "is" a spec narrows the questioning to spec-shaped answers
- **Acting on the result before the user confirms shared understanding** — an empty frontier ends the questioning; only the user's confirmation ends the grill
