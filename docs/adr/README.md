# Architecture Decision Records

Repo-wide engineering decisions live here. Each record captures one decision that constrains where future code or content lands, together with the evidence that forced it.

## Why this directory

Repo-root `docs/` is the contributor playbook home — AGENTS.md points agents at it for task-specific playbooks. `packages/coding-agent/docs/` is the published product-docs site (driven by its `docs.json`, copied into the package's dist). Decision records are contributor-facing, span packages, and must never ship to end users, so they live at the repo root.

## Form

- Files are named `NNNN-kebab-slug.md`. The title IS the decision — a reader who sees only the filename list knows what stands.
- Body: context (what forced a decision), the decision itself, and empirically-tested constraints — each constraint cites the command, file, or pinned tool version that proved it.
- Add an `## Invariants this creates` section when the decision constrains future work.
- When reality moves, append a dated `## Update, YYYY-MM-DD` block. Never rewrite prior text — the same immutability rule the CHANGELOGs follow.
- Keep each record under a page. If it grows past that, it is two decisions.

## When to write one

Write an ADR when a decision:

- constrains where future code or content lands (a placement or channel rule),
- spans packages, or
- pins behavior to an external tool version that can drift (record the version and the revisit triggers).

Do not write one for reversible local choices a later commit can simply change.

Form adapted from mattpocock/skills `.agents/adr` (MIT).
