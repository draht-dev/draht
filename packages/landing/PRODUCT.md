# Product

> **Scope:** this file guides the internal draht.dev surface. Public package
> support and release inclusion are governed by the
> [product support map](../../.planning/PRODUCT-MAP.md). The site must not promote
> private examples or internal workspaces as shipped products.

## Register

brand

## Users

Two audiences arrive at this page:

**Developers and freelancers using coding agents.** Solo operators who bill clients need to justify AI spend. They use Claude Code or similar tools daily, care about cost control, and need audit trails that survive a client invoice review or a GDPR question. They evaluate draht against problems they already have.

**Potential clients checking out Oskar Freye.** People who received a proposal or referral use the page for due diligence. They want to know whether Oskar ships working software and understands the engineering behind it. The page is also a work sample.

## Product purpose

draht is a local GSD workflow engine and coding-agent stack. It routes each task to a capable model based on cost, writes the failing test before implementation, reads the domain model before editing code, and keeps provenance records through supported local packages and CLIs. It runs as a Claude Code plugin or standalone CLI. The code is MIT-licensed and designed for local operation. Telemetry, audit, invoice, compliance, hosted-service or managed-deployment claims need separate evidence and are not implied by private examples in this repository.

## Brand personality

Precise, uncompromising, honest. "Handgefertigt" means handcrafted in Dortmund. Use direct workshop vocabulary instead of startup language. Treat numbered principles as commitments, not decoration.

## Anti-references

- Vercel-dark: sleek gradient SaaS with glowing floating cards
- Linear-clean: minimalist product-app aesthetic used as marketing
- Typical DevTool landing: floating screenshots, animated feature grids, "10x your productivity" hero copy
- Any SaaS puffery: gradient text, hero-metric templates ("412k tokens saved!"), glassmorphism, identical card grids

## Design principles

1. **Practice what you preach** — a tool that enforces discipline should look disciplined. No decorative complexity that the tool itself would reject.
2. **The work is the credential** — use code artifacts, terminal demos, and numbered clauses instead of unsupported marketing claims.
3. **Bilingual precision** — German/English isn't a quirk, it's identity. Dortmund workshop, not Silicon Valley startup.
4. **Receipts before promises** — the audit-trail aesthetic extends to the page itself: everything legible, nothing hidden, no fine print.
5. **Boring ships** — restraint over spectacle. Unusual choices earn their place or they're cut.

## Accessibility and inclusion

No specific WCAG target stated. Respect `prefers-reduced-motion` (already implemented for wire animations). Maintain readable contrast on the warm dark palette.
