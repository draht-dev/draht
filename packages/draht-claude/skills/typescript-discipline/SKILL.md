---
name: typescript-discipline
description: Design or review TypeScript domain types, parsing boundaries, and type-safety trade-offs. Use when the task concerns type modeling, unsafe assertions, or exhaustive handling.
---

# TypeScript Discipline

Use types to express the cases callers must handle, with the least complexity that keeps operations correct.

- Model mutually exclusive states with discriminated unions. Enforce exhaustive handling so adding a variant reveals missing cases.
- Parse external data from `unknown` at the boundary into a named type. Keep business logic typed and avoid repeating already-established validation inside it.
- Prefer constructive representations when they remove invalid combinations. A non-empty tuple proves a head exists; it does not prove an arbitrary numeric index is in bounds.
- Strengthen a type where an operation requires it. An empty list is valid input for a sum; a head operation must require non-empty input or return an optional result.
- Brand primitives when mixing their meanings is a plausible defect. Match the project's brand convention and validate at construction.
- Avoid `any`, unchecked `as`, and non-null assertions. Narrow, validate, or revise the model; isolate and explain an assertion that the compiler cannot express.
- Derive shapes from authoritative schemas and existing types. Use `satisfies` to check a value against a type without a type assertion.
- Type predicates must check their full claim. A named guard is not evidence that its implementation is sound.
- Use named object arguments when they prevent confusion; follow existing APIs and consider allocation-sensitive paths.

See [boundary and totality patterns](./references/patterns.md) for the cases that commonly need care. Follow repository rules on imports and type definitions; consult installed dependency declarations rather than guessing external APIs.
