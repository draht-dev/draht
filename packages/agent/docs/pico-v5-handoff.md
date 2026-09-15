# Pico5 implementation handoff

`packages/agent/docs/pico-v5.md` is normative. Implement this list in order.
After every package: run its tests, run `npm run check`, and stop for user review.
Do not redesign later packages while implementing the current one.

Pico3 is reference material only. Preserve useful behavior, not its capability
facades, membranes, document routing, view projection, events, or clone chains.

## Status

- Obsolete `pico` and `pico4` prototypes were removed.
- `pico3` remains.
- No Pico5 implementation exists.

## 1. Records, cursors, and memory tables

Implement IDs, sequences, conversations, entries, inputs, live/terminal tasks,
document metadata, storage writes, cursors, and detached `MemoryStorage` tables.

Test mixed atomic commits, rollback, detached reads/writes, cursor boundaries,
fork-aware entry scans through deep ancestor caps, head lookup,
entry-to-commit lookup, and full task replacement.

## 2. Memory document records

Add document creation bases, deltas, required/checkpoint bases, retirement,
reincarnation, current/as-of membership, and base-plus-tail reconstruction.

Test Session-, conversation-, and task-scoped documents, retired historical
membership, family queries, and no scans of unrelated document records.

## 3. SQLite backend

Implement the complete storage contract with ordinary rows and indexed document
records. Do not translate Chord operations into SQL JSON patches.

Run the memory conformance suite after reopen. Test SQL transaction rollback,
recent/ancient as-of reads, query plans, latest reclamation, WAL checkpointing,
deleted-page reuse, and representative storage sizes.

## 4. JSONL publication

Implement table writes in `main.jsonl`, one document sidecar per incarnation,
one sidecar per live task, and one main marker per commit. Do not add a
standalone-sidecar protocol.

Fault-test torn/short sidecar writes, failures between sidecars, every marker
boundary, unconfirmed tails, missing confirmed data, and poisoned writes.

## 5. JSONL reclamation

Implement task-document retirement and current-only base reclamation using
committed markers, temporary replacement, rename, and descriptor invalidation.

Crash-test every rewrite/rename boundary. Verify that rewindable history is
never reclaimed and default no-fsync behavior matches the specification.

## 6. Tracker transaction core

Keep one tracker per loaded document. Add transaction begin, callback rollback
from the unchanged baseline, flush, fatal post-flush failure, committed baseline
adoption, and eviction.

Do not add membranes, transaction proxy graphs, capability facades, or defensive
full-document clones. Test callback failure, no-op transactions, storage failure
poisoning, and unload/reload.

## 7. Document definitions and access

Implement `defineDoc`, `defineDocFamily`, identity validation, the three direct
scopes, and get-or-create `tx.doc`, `snapshot`, and `documentSource` acquisition.

Test concurrent initialization once, initial bases, detached snapshots, family
initializer use only on first creation, scope/target mismatch, terminal-task
rejection, task-derived conversation identity, retirement, and
reincarnation-bound sources. Include create-task-then-document,
document-after-terminal rejection, and create-document-then-terminal settlement
in one transaction; internal candidate validation must not trigger
`ReadAfterWrite`.

## 8. Checkpoints and migration

Inside `Storage.commit()`, evaluate `checkpointWhen(value, ops)` exactly once
for ordinary mutations. Implement required creation/version bases and
all-older-version migration.

Test latest migration persistence, rewindable migration on current/historical
read, first post-migration mutation base, newer-version rejection, absent plugin
preservation, and checkpoint starvation without backend heuristics.

## 9. Conversation document forks

Using fixture conversations and entry-to-commit mappings, implement the `asOf`,
`current`, and `initial` settings for singleton and family documents.

Test unknown definitions, retired membership, new child incarnations, lazy
`initial` creation, and exclusion of task- and Session-scoped documents.

## 10. Chord structural array operations

Make ordinary positional mutations encode scattered removals without carrying
retained payloads. Callers must not write operations manually.

Test front/tail/middle/scattered/all/no removal, retained 256 KiB and 1 MiB
payloads, append plus removal, later nested/index writes, exact replay, and
unchanged previous immutable snapshots. Internal flushes must remain one commit.

## 11. Chord document source

Add the thin opaque-source adapter to `ReplicatedState`. It must use committed
value/ops directly, with no tracker or re-diff.

Test contiguous revisions, atomic hydrate/subscribe, attachment races,
retirement ending one incarnation, recreation requiring reacquisition, and
listener isolation.

## 12. Document watches

Implement get-or-create `watchDoc`: capture value/revision and register its
listener atomically, buffer without a cap until `start()` or `stop()`, and always
deliver value plus ops.

Test ordered draining, live delivery, retirement as absence, idempotent stop,
listener errors, and explicit cleanup. Invocation-owned cleanup is integrated in
package 15.

## 13. Conversations and entries

Implement conversation history/ownership records, entry creation, cursor-based
fork-aware scans, head lookup, and entry edits.

Test conversation creation and actual forks, deep ancestor caps, same-commit
entry prefixes, newest-edit wins, self-head resolution, raw head-to-tail
transcript, and ownership traversal.

## 14. Context derivation and system messages

Implement model-context reduction, PR #9548 positional `SystemMessage` replay,
tool-result ordering, and missing post-fork tool results. Replay `content`,
ordered named `sections` with `null` removal, then tool removals/additions.

Test model-less and excluded-stop-reason entries, replacements/omissions,
multiple heads, section replacement/removal/re-addition order, rejection of
integer-like section keys, tool addition/removal/replacement order, and raw-view
versus model context.

## 15. Task definitions and invocations

Implement `defineTask`, exhaustive phase maps, full checkpoint replacement,
kind migration, runtime commits, memos, and invocation close gates.

Use a fake two-phase effect. Test intent/effect/outcome recovery,
unchanged-checkpoint faulting, same-phase checkpoint progress, cancellation
precedence, thrown-handler faulting, close/reopen without abort marks, outcomes,
or task-document retirement, no fresh phase/abort dispatch while closing,
first-writer-wins memos, and automatic watch cleanup.

## 16. Scheduler and terminal tasks

Implement reservation, running-task reopen reconciliation, dependencies,
terminal outcomes, waits, holds, joins, and orphaning.

Test result values and entry IDs, terminal records after reopen, dependency
eligibility, unknown kinds, and terminal removal of checkpoints/memos.

## 17. Abort and owned conversations

Implement durable abort marks, signal/join/fresh-abort invocation, owned
conversation creation, subtree traversal, background behavior, and idle waits.

Test commit rejection after a run task is marked, crashes at every abort stage,
close precedence over a previously marked task, deep ownership trees, and atomic
retirement of task-scoped documents.

## 18. Inputs and positional inbox

Define the initial inbox and turn-control documents, then implement request-ID
deduplication, awaitable input handles, busy admission, withdrawal, queue modes,
and `postTools`/`final` boundaries. Use a fake successor task.

Table-test every input transition, interleaved steer/follow-up/write selection,
self-head cuts, stale targets, successor triggers, reopen waits, compact
large-payload removals, and orphan/fault cleanup of active turn control.

## 19. Remaining built-in documents and view

Define the concrete configuration, preference, and live presentation documents;
reuse the approved inbox/turn definitions. Record all IDs, fields, history,
fork settings, migration, and checkpoint predicates in the normative
specification.

Implement `{ conversation, entries, docs }`. Test direct task writes, one
publication per Session commit, atomic
entry/preview settlement, head changes, contiguous revisions, stable public
paths, retry/collapse late-join status, bounded-output truncation metadata, and
absence of semantic projection. Specify which diagnostics become entries,
terminal details, or bounded document state.

## 20. Registries, hooks, and sections

Implement task/tool/entry/section registries, Session and owned-subtree hooks,
positional PR #9548 section/tool updates, complete baselines after a head cut,
and preparation revision checks. Do not add a public event stream or
plugin-state router.

Test registration lifetimes, hook replay with memos, exact persisted rendered
section strings, minimal section patches and `null` removals, complete baseline
tool declarations, and a head cut that retains earlier system messages. Verify
the new baseline entry omits those messages through `ContextEdit` before replay,
including retained `content`, section order, and tool changes. Include a retained
delta whose ID precedes the head-carrying entry: select omissions by retained
context membership, not an ID comparison with the head entry. Test tool loadout
additions/removals and preparation retry after registry movement. Do
not implement in-process replacement of Session-side plugin code; a host plugin
change uses the Harness close/reopen boundary.

## 21. Tool and post-tools tasks

Implement offered-set checks, argument validation, tool hooks, durable bounded
progress, owned APIs, interrupted/replay-safe recovery, result entries,
post-tools joining, controls, and boundaries using fake tools.

Test recovery from every phase, both stored/current replay-policy directions,
and atomic assistant/tool/post-tools settlement. Use a fake generation
successor; package 22 replaces it and reruns integration.

## 22. Generation task

Implement preparation, request intent, durable throttled partials, attempts,
retry policy, response classification, continuation, and deferred polling/
cancellation with the faux provider.

Test every phase before and after reopen, aborted partial conversion, overflow
through a fake collapse kind, input settlement, and no visible-undurable update.
Replace the fake tool successor and rerun the package 21 integration tests.

## 23. Collapse task

Implement manual, threshold, and overflow collapse; exchange-boundary range
selection; summarization; retries; staleness; and headed summary entries.

Test context before/after collapse, provider failure, declined/stale work, and
reopen from every phase. Replace generation's fake overflow target and rerun its
overflow integration test.

## 24. Job and plugin tasks

Implement process jobs with bounded durable output, interruption recovery,
rescheduling, and registered plugin handlers.

Test process exit/error/abort/reopen, background idle behavior, notifications as
state or entries, and plugin handler recovery.

## 25. Harness integration

Expose conversation/input/task handles, watches, dynamic registries, close,
suspend, service withdrawal/client detach, and product wiring. Implement the v1
host-plugin reload path as stop admission, close/join, dispose, rebuild with all
new definitions, reopen/migrate, and resume. Test that closing seals commit and
get-or-create admission, lets storage settlement for already-flushed admitted
commits finish despite caller cancellation, writes no abort or terminal outcome, starts no fresh abort
invocation, and does not run old and new generations concurrently.

Run all package-specific tests and the repository check. Verify a local
coding-agent turn and a reopened interrupted turn, then stop for final review.
