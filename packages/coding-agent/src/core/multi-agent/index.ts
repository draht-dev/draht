/**
 * Multi-agent coordination primitives.
 *
 * Re-exports the five building blocks of draht's multi-agent orchestration
 * layer from a single entry point:
 *
 * - `fsm.ts`             — per-agent lifecycle state machine (IDLE/REQUEST/WORKING/WAIT/RESPOND)
 * - `mailbox.ts`         — in-process pub/sub message passing between agents
 * - `task-board.ts`      — autonomous task board with self-assign + atomic locking
 * - `worktree.ts`        — git worktree isolation for conflict-free parallel work
 * - `permission-gate.ts` — three-tier (deny/allow/approve) tool-call permission gate
 *
 * Consumers (e.g. the `subagent` builtin) import from here rather than reaching
 * into individual files.
 */

export * from "./fsm.ts";
export * from "./mailbox.ts";
export * from "./permission-gate.ts";
export * from "./task-board.ts";
export * from "./worktree.ts";
