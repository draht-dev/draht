---
name: typescript-discipline
description: TypeScript type-system discipline — make illegal states unrepresentable with discriminated unions, build types constructively instead of guarding loose ones, brand semantic primitives, parse external data once at the boundary and trust types inside, keep functions total and strengthen a type only where partiality appears, make the compiler enforce exhaustiveness. Use when reading or editing any .ts or .tsx file, designing a type or function signature, reviewing a TypeScript diff, or deciding whether an `any`, an `as` cast, or a non-null `!` is acceptable.
---

# TypeScript Discipline

The type checker is a proof assistant. Used well, it eliminates impossible states, mismatched primitives, and unhandled variants at compile time; every case the types let you ignore is a runtime failure the compiler could have stopped. Prefer defining errors out of existence over proliferating handlers — unrepresentable states, total functions, and boundary parsing are the tools for that.

Two layers: the principles below hold in any statically-typed language; the rule table and `./references/patterns.md` ground them in TypeScript syntax.

## Principles

- **Make illegal states unrepresentable.** Model variants as a discriminated union, not as a bag of optional fields where contradictory combinations compile. The canonical anti-pattern: `{ completed: boolean; completedAt?: Date }` admits `completed: true` with `completedAt: undefined`, which means nothing. Derive the boolean from a single source (`completedAt !== null`) or model the variants explicitly: `{ kind: 'open' } | { kind: 'done'; at: Date }`. If a bug ever forces the question "wait, can this combination actually happen?", the type is too loose.
- **Types are constructions, not restrictions.** Build the type up from the values you want instead of carving them out of a looser type with runtime checks. A non-empty list is a head plus a rest, not a list with a length check. A valid time range is a start plus a duration, not two timestamps you must keep ordered. No representation is privileged — pick the shape that cannot build the illegal value, then expose the interface callers need on top of it.
- **Brand semantic primitives.** A `UserId` and an `OrderId` are both strings underneath but must not be interchangeable. Brand them, validate once at creation, trust the type downstream.
- **External data is untyped until parsed.** RPC payloads, JSON, CLI args, config files, environment variables, database rows: each gets a parse function at the boundary that turns unstructured input into the typed domain model. Validation lives at that boundary, once — inside the system there is typed data, no re-validation deep in call chains, and business logic in pure functions the boundary shell calls.
- **Don't lie to the compiler.** Casts and assertions that bypass the checker are runtime crashes waiting to happen. If the compiler can't prove a fact, prove it — validate, narrow, refine the model — or accept that the cast is a hazard you are choosing to carry. The cast buried today is the postmortem written next week.
- **Exhaustive matching is the compiler's job.** A match over a sum type must fail compilation when a new variant is added without a case, so the compiler tells the next author every place that needs updating.
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI spec, GraphQL schema, or database migration already defines a shape, derive from it instead of hand-rolling a parallel type. Manual duplication drifts.
- **Strengthen a type only where partiality appears.** A runtime assertion, a null check, or a "should never happen" throw marks the spot where a type is too weak — push that check up into the type, then stop. The type system's job is to track the cases each use site must handle, not to describe the data as precisely as possible. `sum` of an empty list is 0, so it takes the plain list; `head` of an empty list has no answer, so it demands the non-empty one. Extra precision beyond totality costs reuse and ceremony and buys no safety.

## Rules (TypeScript syntax)

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states can't be represented. No optional-field bags. |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` so they can't be mixed up. Validate once at creation. |
| Constructive modeling | Build the shape so the illegal value can't be constructed: `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `duration` for a range. Not a runtime guard, not a wish for refinement types. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to a non-empty type only where the loose type forces a `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. `any` disables type checking everywhere it touches. |
| No `as` casts | Every `as` is a potential runtime crash. Cast only after validation has earned it. |
| Narrowing hierarchy | Discriminant switch > `in` operator > `typeof`/`instanceof` > user-defined type guard > `as`. |
| Type guards | Must verify the claim. A lying guard is worse than `as` — the bug hides behind a name that says it's safe. Name them `isX` or `hasX`. |
| Exhaustiveness | Assign to a `never`-typed local in default arms so the compiler errors when a new variant is added. |
| `satisfies` over `as` | Validates the value without widening literal types. |
| Boundary validation | Parse where data crosses in — into a named domain type, once. `Record<string, unknown>` (however spelled) stops at that parse. Inside: trust the types, no redundant re-validation, logic in pure functions the boundary shell calls. |
| Schema-derived types | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface. |
| Object args | Pass objects, not positional arguments, so call sites are self-documenting. Skip on hot paths (per-frame render, tokenizers, parsers). |

Worked don't/do examples for every rule: `./references/patterns.md`.

## Self-Checks

- "Can I write a comment explaining when this combination of fields is valid?" If yes, the type is too loose — split it into a discriminated union.
- "Do two function arguments share a primitive type but mean different things?" Brand them.
- "Where did this `any`, this `as`, this `!` come from?" Trace it to the boundary and validate there instead.
- "If a new variant is added next month, will the compiler point at every place that needs a case?" If not, the match isn't exhaustive.
- "Is this type duplicating a shape another file or schema owns?" Derive instead.
- "Am I strengthening this type to keep an operation total, or just to be more precise?" If nothing would otherwise throw, keep the plain type.
