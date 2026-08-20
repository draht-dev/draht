---
description: "Refine a fuzzy idea into a written design spec before planning or coding"
---

# /brainstorm

The pre-planning gate. Before draht's GSD cycle runs, before code is scaffolded, before `/new-project` or `/init-project`, converge on the idea through dialogue and write it to `.planning/specs/`. This command enforces design-first discipline.

## Usage
```
/brainstorm [idea or topic]
```

Topic: $ARGUMENTS

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Hear the Problem Beneath the Ask

The user's words describe an artifact; the design must serve a need. They are rarely the same thing.

**Procedure:**
1. Separate the stated artifact ("a dashboard") from the underlying need — what decision, pain, or moment does it serve?
2. When the user names a solution, ask what it solves before refining it. Solutions stay candidates until the need is confirmed.
3. State the need back in one sentence ("so the real problem is X — right?") and get an explicit yes before proposing any approach.

**Example:** "I want an admin dashboard" → questioning reveals they check one number, once a week → a scheduled email beats the dashboard by a month of build time.

**Prevents:** a polished spec for the wrong artifact.

## The Hard Gate

> Do NOT invoke any planning command, write any code, scaffold any project, or take any implementation action until you have:
>   1. Asked clarifying questions one at a time
>   2. Proposed 2–3 approaches with trade-offs
>   3. Presented a structured design and the user has approved it
>   4. Written the design to `.planning/specs/YYYY-MM-DD-<slug>-design.md`

If the user pushes to skip ("just build it"), surface the trade-off: "I can scaffold something now, but skipping brainstorming usually means we throw out the first version. Are you sure?" If yes, proceed but make the assumption explicit in the spec.

## The Process

### 1. Explore Context

Before asking anything, read what's already on disk:
- `git log --oneline -30` — what has the user been working on recently?
- `ls -la` — what's in the project root?
- `.planning/` if it exists — is there an active project?
- `README.md`, `package.json`, any `*.md` in root — what does this codebase claim to do?

If an existing codebase is in play (extending a real project), run `draht-tools map-codebase` + `draht-tools graph-hotspots` first to ground ideation in the real structure — so brainstormed ideas don't contradict existing architecture.

Use this to ground questions in reality instead of asking things the user has already told you.

### 2. Ask Clarifying Questions — ONE at a time

Most failed projects come from rushing past ambiguity. Ask **one focused question per message**, not a long list. Wait for the answer, then ask the next.

Question categories (sequence from foundational → detailed):
- **Goal** — who is this for? what changes for them when it ships?
- **Constraints** — deadline? budget? team size? language/stack preferences?
- **Scope** — what's in v1? what's explicitly NOT in v1?
- **Success criteria** — how do we know it works? what's the demoable outcome?
- **Domain** — what are the key nouns and verbs in this space? any existing glossary?
- **Risks** — what's the scariest part of this? what would make it fail?

If the project is obviously oversized for one cycle (e.g., "I want to build a social network"), flag it explicitly and propose decomposition into a v1 / v2 / out-of-scope split.

### 3. Propose 2–3 Approaches With Trade-offs

Once you have enough context, propose multiple approaches:
- Approach A: the simplest path. What it sacrifices.
- Approach B: the most flexible. What it costs.
- (Optional) Approach C: the most ambitious. Why it's tempting and why it might be too much.

For each: list trade-offs in plain language (time, complexity, future flexibility, lock-in). Let the user pick — don't pre-pick for them.

### 4. Present the Design in Sections, Each With an Approval Gate

Once an approach is chosen, present the design **section by section**, not all at once:
1. Goal & non-goals
2. User stories / observable truths
3. Domain model (bounded contexts, key nouns)
4. Architecture sketch (components, data flow)
5. v1 scope (what ships) vs v2/out-of-scope (what doesn't)
6. Open questions / risks

After each section, ask: "Does this match what you want, or should we adjust?" Only move to the next section once the current one is approved.

### 5. Write the Spec to `.planning/specs/`

Once all sections are approved:

```
.planning/specs/YYYY-MM-DD-<topic-slug>-design.md
```

The file should include:
- Header with date and approver
- All approved sections
- Open questions section (the things you flagged but didn't resolve)
- Next step: which command picks this up (`/new-project` or `/init-project`)

### 6. Self-Review the Written Spec

Before handing off, attack the spec as if you were paid to kill it:
- Contradictions between sections (the goal says X, the architecture implies not-X)
- Gaps (a user story with no architectural support)
- Premature commitments (specific tech choices made before they were needed)
- Domain language drift (different names for the same thing)
- The strongest case the whole design is wrong — wrong scope, wrong user, or already exists as a simpler tool. Write that case and why the design survives it into the spec's Open Questions.

Report any findings to the user and update before proceeding. A spec that was never attacked has never been tested.

### 7. Hand Off

Direct the user to the next command:
- Greenfield with no codebase → `/new-project`
- Existing codebase → `/init-project`

The spec file becomes input to those commands.

## Workflow

`/brainstorm` runs before any project initialization. Each later step runs in its own session (`/new` between steps):

```
/brainstorm → /new → /new-project (or /init-project) → /new → /discuss-phase 1 → /new → /plan-phase 1 → ...
```

## Anti-Patterns — STOP

- **Asking multiple questions in one message** — splits the user's attention, lowers answer quality
- **Pre-deciding before they've answered** — "I'll just assume you mean X" is a failure mode
- **Skipping the alternatives** — proposing only one approach hides the trade-space
- **Writing the spec before approval** — the spec records *decisions*, not *proposals*. Get the decision first.
- **Brainstorming code** — this command is for the design, not the implementation. Resist the urge to start writing.

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "It's a simple project, no need to brainstorm" | Simple projects also have ambiguous scope. The gate is fast for simple ones. |
| "User said 'just build it'" | They'll be unhappier when the wrong thing gets built. Surface the trade-off. |
| "I already know what they want" | Verify by stating it back and getting confirmation. |
| "Let's iterate after a first draft" | A first draft in code is more expensive to throw away than a first draft on paper. |

## Output

Brainstorming ends with a written spec file in `.planning/specs/`. That file is the artifact. If no file is written, the command did not complete.
