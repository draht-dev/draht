---
name: ddd-workflow
description: Domain-driven design discipline — bounded contexts, ubiquitous language, aggregates, domain events, context maps, and how the .planning/DOMAIN.md file drives code structure and naming. Use whenever the user is modelling a new domain, extracting domain concepts from existing code, deciding where code should live, or naming things.
---

# DDD Workflow

Draht embeds domain-driven design into project initialization, planning, and execution. The `.planning/DOMAIN.md` file is the single source of truth for domain concepts.

## .planning/DOMAIN.md Structure

```markdown
## Bounded Contexts
- **Billing** — everything about invoices, payments, subscriptions
- **Catalog** — products, pricing, availability
- **Fulfillment** — order processing, shipping, returns

## Ubiquitous Language
- **Invoice** — a document requesting payment for delivered goods or services
- **Order** — a customer's request to purchase goods, before fulfillment
- **Line Item** — a single row on an invoice or order
- **SKU** — a unique identifier for a product variant in the catalog

## Context Map
- Billing ← Catalog (downstream — billing reads product info)
- Fulfillment ← Billing (downstream — fulfillment needs invoice status)
- Shared kernel: Money, TaxRate (used by Billing and Fulfillment)

## Aggregates
### Billing
- Invoice (root) — LineItem, Payment
- Subscription (root) — BillingCycle

### Catalog
- Product (root) — Variant, Price

## Domain Events
- `InvoiceIssued` — Billing → Fulfillment, Notification
- `PaymentReceived` — Billing → Notification
- `OrderShipped` — Fulfillment → Notification, Customer
```

## The Five Rules

### 1. Bounded contexts shape the code
- File/module structure mirrors bounded contexts: `src/billing/`, `src/catalog/`, `src/fulfillment/`
- Each context owns its aggregates, value objects, services, and domain events
- Cross-context imports are suspicious — prefer domain events or ACL adapters

### 2. Code uses the ubiquitous language
- Class names, method names, variable names must match the glossary
- If you need a new term, update `DOMAIN.md` **first**, then write the code
- Never invent terms in code that aren't in the glossary

### 3. Aggregates enforce invariants
- Each aggregate has one root entity
- All writes go through the root — never modify child entities directly from outside
- Aggregate boundaries align with transaction boundaries
- Aggregates reference each other by ID, not by reference

### 4. Domain events cross context boundaries
- Upstream context publishes an event (`InvoiceIssued`)
- Downstream contexts subscribe and react (Notification sends email, Fulfillment releases order)
- No direct function call from Billing into Fulfillment — always via event

### 5. Shared kernel is explicit
- If two contexts must share a type (e.g. `Money`, `TaxRate`), put it in `src/shared/` and document it in the Context Map
- Shared kernel changes are high-cost — they affect multiple contexts
- Prefer duplication over coupling when in doubt

## The Post-Phase Domain Health Check

The `gsd-post-phase.cjs` hook checks `DOMAIN.md` after each phase:
- Is `## Bounded Contexts` section present?
- Is `## Ubiquitous Language` section present?
- Count of unique PascalCase terms (proxy for glossary size)

The `gsd-quality-gate.cjs` script also runs a domain validator that compares identifiers in code against the glossary and flags unknown terms.

## Extracting Domain from Existing Code

When running `/init-project` or `/map-codebase` on a codebase that wasn't built with DDD:

1. List top-level `src/` subdirectories — candidates for bounded contexts
2. Scan PascalCase class / interface / type names — candidates for entities and value objects
3. Scan repeated nouns in function names — candidates for domain concepts
4. Look for cross-directory imports — candidates for context coupling to fix
5. Write `DOMAIN.md` with what you found + what should exist
6. Use subsequent phases to refactor toward the target model

## Anti-patterns

**Anemic domain model** — entities that are just data bags with no behaviour. Push logic into the entities.

**Scattered aggregates** — one aggregate's logic spread across multiple contexts. Consolidate or introduce an ACL.

**Terminology drift** — the same concept called different things in different files. Fix in `DOMAIN.md` first, rename code second.

**Shared database** — multiple contexts writing to the same tables without explicit shared-kernel agreement. Break the coupling.

**Direct cross-context imports** — `import { ... } from '../billing/...'` in `src/fulfillment/`. Use domain events or ACL adapters.

## When to Update DOMAIN.md

- Before writing code that introduces a new term → add it to the glossary first
- During `/discuss-phase` when gray areas reveal missing concepts
- After `/verify-work` when the reviewer agent flags domain language drift
- Whenever a refactor reveals that existing names don't match reality
