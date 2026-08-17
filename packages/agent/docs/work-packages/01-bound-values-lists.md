# WP01 — Bound values and lists

## Status

Ready after WP00. The normative design is [`registers.md`](../registers.md).

## Goal

Replace the retained register/custom-state API with bound `Value<T>` and `ValueList<T>` addresses across every existing backend and application surface, then stop before runtime execution work.

## Scope

1. Add `session/values.ts` with universal `value()` / `list()`, typed write helpers, all `pi.*` built-in address/prefix constructors, and no registry, catalog, privilege path, or global type map.
2. Replace `RegisterValues`, namespace unions, `Register`, `getRegister`, `listRegisters`, raw register writes, custom-state APIs, and old persisted semantic names.
3. Expose the same bound-address reads through Storage, SessionReader, SessionMutator, Session, and SessionTree; add direct Session scalar/list writes and retain one-commit `Session.mutate()` composition.
4. Implement scalar replacement and list append/page/whole-list-delete in Memory, JSONL, and SQLite, including replay, compaction, snapshots, forks/rewrites, instrumentation, and shared conformance.
5. Use `pi.session.name`, `pi.entry.label`, and the complete built-in namespace/key grammar from `registers.md`. Applications define their own addresses directly.
6. Update telemetry schema source for value/list write kinds and regenerate `telemetry-schema.md`.
7. Update all retained source/tests and public exports; no old API shim remains.

## Preserve

- transaction atomicity and global write `seq` ordering;
- JSONL torn-tail and compaction behavior, preserving list-element sequences;
- SQLite `BEGIN IMMEDIATE`, writer fencing, and indexed list paging without temporary sorting;
- repository/fork semantics, branch indexes, stats, UUIDv7/follower IDs, v3 normalization, and existing entry/usage behavior;
- projection-only restore: no list read until bounded consumption-time hydration;
- trusted in-process values with no codecs, cloning, or runtime shape validation.

## Required coverage

- type inference and incompatible scalar/list write rejection;
- exact `pi.*` built-in addresses and five scan-prefix constructors;
- application-wide and dynamically keyed addresses with no second operation-time key;
- scalar set/get/delete/recreate and namespace-scoped prefix scans;
- list append, global element sequences, asc/desc cursors, limits, absent reads, whole delete, and delete-then-append;
- atomic entry + usage + scalar + list transactions and rollback;
- identical Memory/JSONL/SQLite behavior;
- JSONL replay, torn transactions, and cursor-preserving compaction;
- SQLite query plans;
- forks excluding operation-owned values/lists while preserving semantic session values;
- close rejecting later reads while admitted commits drain;
- zero old register or custom-state API references outside immutable release history.

## Non-goals

- No runtime acceptance, drive, provider, assistant-frame consumer, tool memo/checkpoint consumer, or operation-state redesign.
- No generic event log, list truncation, per-element deletion, registry, catalog, or compatibility facade.
- Do not rewrite applied backend migrations solely for terminology; follow the compatibility policy in `registers.md`.

## Validation

Run every modified test individually, the shared backend conformance suites, SQLite package tests, agent/root TypeScript, `git diff --check`, and `npm run check`.

## Stop condition

Stop when every existing backend and retained Session surface uses bound values/lists, old APIs are absent, and all checks pass. Report schema/compatibility choices; do not begin runtime execution work.
