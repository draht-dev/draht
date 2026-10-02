---
name: explainers
description: Pick the output form that lets a human understand agent work fastest, and build it from evidence — Mermaid diagrams for relational content, a self-contained HTML explainer for findings worth exploring, the STE register in unslop for procedures, and narrated video reels as a non-core option. Use when a report, review, plan, investigation, or handoff describes structure (dependencies, call paths, data flow, state machines, sequences, timelines, wave order), when the user asks to "draw", "diagram", "visualize", "show me", "explain as HTML", "make an explainer", or "Schaubild", or when prose alone would make the reader rebuild a graph in their head.
---

# Explainers

The more work agents do, the more of the human's time goes to oversight: reading what was done and deciding whether to trust it. Prose is often the slowest form for that. This skill chooses a faster form and keeps it honest.

Pick the cheapest form that carries the structure:

1. **Prose** — the default. For procedures, use the controlled register in `unslop`.
2. **Diagram** — when the content is a graph: things connected to things.
3. **HTML explainer** — when the reader will want to filter, expand, or compare, or when the deliverable leaves the terminal (a client, a non-developer).
4. **Video reel** — non-core. See the last section.

## Evidence Rule

A picture of a claim is still a claim, and it is harder to audit than a sentence. So:

- Every node, edge, label, and number in a diagram or HTML explainer traces to a source cited in the same deliverable: `draht-tools graph-*` output, a `file:line`, command output, or a commit SHA.
- An edge you inferred is drawn dashed (`-.->`) and labelled `inferred`. It follows the same `epistemics` tier as the sentence that would have stated it.
- Never draw architecture from memory or from what the code "probably" does. Query first: `draht-tools graph-impact`, `graph-path`, `graph-callers`, `graph-callees`, `git log --graph`. Then draw what came back.
- A visual never says more than the report around it. When the two disagree, the report wins and the visual is wrong.

## Diagrams

Use a fenced `mermaid` block. Draht's TUI renders flowchart, state, class, ER, and sequence diagrams inline as box art; any other type falls back to source. Other hosts show the source, so keep the source readable on its own.

| Content shape | Mermaid form |
|---|---|
| Dependencies, blast radius, import paths | `flowchart LR` |
| Request flow, call sequence, protocol exchange | `sequenceDiagram` |
| Lifecycle, status transitions | `stateDiagram-v2` |
| Plan waves and task dependencies | `flowchart TD` with one `subgraph` per wave |
| Commit or branch history | `flowchart LR`, one node per commit (short SHA and subject) |
| Domain model, aggregates | `classDiagram` or `erDiagram` |

Rules:

- One sentence before the diagram says what to look at ("The red path is the one this change removes.").
- At most about 15 nodes. Split a bigger picture into two diagrams with one question each.
- Short node ids, labels in double quotes: `A["packages/ai/src/stream.ts"]`. Quote any label that contains parentheses, brackets, or a colon. Never use `end` as a node id.
- Add a one-line legend under the diagram when it uses colours, dashed edges, or classes.
- Skip the diagram when there are fewer than three nodes, the content is a plain list, or a table already says it.

## HTML Explainers

Build one when the user asks, or when the finding has more than one dimension the reader will want to explore: a filterable findings list, a dependency graph to click through, a before-and-after comparison, a timeline.

- **Data first.** Put the deliverable's data in a `<script type="application/json" id="data">` block and render the page from it. A reviewer can audit the data block, and the page cannot claim more than the data holds.
- **Escape the data.** Write every `<` in the JSON block as `\u003c`, so a quoted `</script>` in the data cannot end the block. Insert strings from the data with `textContent`, never `innerHTML`: findings often quote code from the repository under review.
- **One self-contained file.** Inline all CSS and JavaScript. Make no network requests, so the file works offline and leaks nothing when a client opens it. Draw diagrams as inline SVG you generate from the data. If a Mermaid diagram is essential, show its source in a `<pre>` and load Mermaid from a CDN only after the user approves the network request, pinned to an exact version with an `integrity` (SRI) hash.
- **The report stays the source of truth.** The HTML is a view of it. Write the Markdown report first, then the HTML.
- **Location.** Write it to the system temp directory as `draht-explainer-<YYYY-MM-DD>-<slug>.html` and print the path. It is a throwaway artifact. Never write it under `.planning/`: `draht-tools commit-docs` stages that whole directory. Move it into the repository only when the user asks.
- **Prose inside the page** follows `unslop`. For a client, write in the client's language and remove internal paths, hostnames, and secrets.
- **Verify before you hand it over** (`verification-gate`): the file exists, the JSON block parses, and `grep -nE 'src="https?:|href="https?:'` shows no external asset except links to cited sources and an approved, SRI-pinned Mermaid script. If a browser is available, open it once and look at it.

## Prose Register

Procedures, runbooks, fix steps, and "next steps" in handoffs use the controlled register (STE-lite) in `unslop`. Short sentences and one instruction per sentence also make text easier to read aloud, which matters for the `speak` command.

## Video Reels (Non-Core)

The draht monorepo has an example package, `packages/reels` (`@draht/reels`), that turns git history into narrated vertical explainer videos (Remotion for visuals, ElevenLabs for narration) and a scrollable feed web app per repository. It runs in CI, not inside a command. Mention it only when the user asks for a video or audio explainer of repository changes. No draht command invokes it.
