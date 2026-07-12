# Rewind & Checkpoints — Design Spec (v1)

- **Date:** 2026-07-12
- **Status:** Proposed (planned as Milestone 5, Phases 41–33 — nothing implemented; all phases `pending`)
- **Planned via:** Fable-model architect subagent (design only)
- **Scope:** `packages/coding-agent` (core + interactive mode). No new package.
- **Prior planning:** none — zero hits for "rewind" in `.planning/` or `docs/` before this spec.

> One-line: a first-class **`/rewind`** that jumps a session back to an earlier point and restores **conversation state and working-tree state together, atomically, never destructively** — parity with Claude Code's `/rewind` and Codex's checkpoint/rewind.

---

## Context

**Conversation-side rewind already exists.** Sessions are JSONL *trees* (`id`/`parentId`, `docs/session-format.md`) under `~/.pi/agent/sessions/<encoded-cwd>/`. Verified in `src/core/session-manager.ts`: `branch(branchFromId)` (line 1289, moves the leaf pointer; append-only, nothing deleted), `branchWithSummary(branchFromId: string | null, ...)` (line 1310), `createBranchedSession(leafId)` (line 1334, extracts one path to a new file, entry ids preserved), static `forkFrom(...)` (line 1490, copies entries verbatim — ids preserved), `getTree()` (line 1239), `resetLeaf()` (line 1301). The real conversation-rewind path is `AgentSession.navigateTree(targetId, {summarize, ...})` (`src/core/agent-session.ts` line 2799), which emits cancelable `session_before_tree` / `session_tree` extension events and optionally writes a `branch_summary` entry. UI: `/tree` (`TreeSelectorComponent`, `interactive-mode.ts` `showTreeSelector()` line 4608, with label editing via `appendLabelChange`), `/fork`, `/clone`, plus the `session_before_fork` hook (`docs/extensions.md` lines 426–441). Labels (`appendLabelChange`/`getLabel`, `docs/sdk.md` lines 816–817) can mark tree points.

**File/working-tree restore does not exist.** `docs/quickstart.md` (line ~84) tells users: "Use git or another checkpointing workflow if you want easy rollback." The only prior art is the opt-in sample `examples/extensions/git-checkpoint.ts` (53 lines, never audited or shipped). Verified flaws:

| # | `git-checkpoint.ts` behavior | Why it's wrong |
|---|---|---|
| F1 | `git stash create` per `turn_start` | Excludes untracked files; produces a *dangling* commit — GC can silently delete the checkpoint |
| F2 | Restore = `git stash apply <ref>` | Merges the old diff **onto** the current dirty tree (conflicts) instead of restoring *to* that state; never deletes files created after the checkpoint |
| F3 | `checkpoints` is an in-memory `Map`, cleared on `agent_end` | Checkpoints don't survive the turn, let alone a restart or `/resume` |
| F4 | Entry id tracked via last `tool_result` leaf | Approximate keying; first turn has no checkpoint key at all |
| F5 | Only hooks `session_before_fork` | `/tree` navigation — the actual in-session rewind path — gets no file restore |
| F6 | No safety snapshot before restore | Applying over uncommitted work can clobber it with no way back |

**Corrections vs. the prior exploration report:** the tree accessor is `getTree()` (not `getSessionTree()`); `branchWithSummary` takes a nullable `branchFromId`; the exploration missed `navigateTree()`/`session_before_tree` (the correct integration seam) and the always-loaded `core/builtins/` mechanism (`CORE_BUILTIN_EXTENSIONS`, introduced by the Phase 23 fix, commit `433e6afbe`) — the right home for a first-class, no-opt-in-required feature.

---

## Decisions log (locked — design within these)

1. **First-class, in `packages/coding-agent` core.** A `CheckpointManager` in `src/core/checkpoints/`, wired through `core/builtins/` so it is always loaded (same mechanism as the permission gate post-Phase-23). Not an example extension, not a new package. `examples/extensions/git-checkpoint.ts` becomes a superseded pointer.
2. **Snapshot mechanism = git commit objects via a temporary index.** Build each snapshot with `GIT_INDEX_FILE=<tmp>` + add-all (respects `.gitignore`, includes untracked) + `write-tree` + `commit-tree`, then anchor it at `refs/draht/checkpoints/<session-id>/<entry-id>`. Fixes F1 (untracked + GC-proof via a real ref) and never touches the user's index, `HEAD`, stash, or reflog. No `git stash` anywhere.
3. **Capture point = `turn_start`, keyed to the session leaf entry id at that moment** (the user message that initiated the turn — fixes F4). Dedup: skip when the `write-tree` hash equals the previous checkpoint's tree hash, so idle/read-only turns cost one `write-tree` and zero new objects.
4. **Metadata storage = sidecar JSONL next to the session file** (`<session-file>.checkpoints.jsonl`: entryId, ref, treeHash, timestamp, dirty-file count). Not a new session entry type — avoids a session-format version bump, tree pollution, and new special-casing in `createBranchedSession`/compaction (labels already need such special-casing; don't add a second kind). Fork/clone copy the sidecar records for preserved entry ids (ids survive both fork paths — verified). Fixes F3.
5. **Restore = diff-driven and scoped** (fixes F2): diff the *pre-rewind safety snapshot* tree against the target snapshot tree; check out only differing paths from the target and delete paths absent in it. Ignored files are never captured, therefore never touched. Implemented with a temp index (`read-tree` / `checkout-index`), not `checkout -- .`, not `stash apply`.
6. **Never destructive** (fixes F6): every rewind first takes a **pre-rewind safety snapshot** of the current tree, anchored and recorded against the current leaf — so abandoned work (including uncommitted/untracked files) is always recoverable. Abandoned conversation branches keep their checkpoints, so **rewind-forward/redo** works: rewinding to a later entry on an abandoned branch restores it.
7. **Atomic ordering:** safety snapshot → file restore (roll back to safety snapshot on any failure) → `navigateTree()`. The conversation leaf moves only after files succeed; a leaf move is itself just a pointer change, so no partial state is possible. If rollback *also* fails, both anchored refs are printed — nothing is ever unrecoverable.
8. **UX:** new `/rewind` command + `app.session.rewind` keybinding action. Selector reuses the tree-selector, filtered to checkpointed user messages, with checkpoint annotations (timestamp, dirty-file count). After picking an entry: scope menu — **conversation + files** (default) / conversation only / files only. `/tree` and `/fork` additionally offer file restore when the target entry has a checkpoint (via `session_before_tree` / `session_before_fork` seams — fixes F5).
9. **Degradation:** non-git cwd → capture disabled with a one-time notice, `/rewind` becomes conversation-only (today's `/tree` behavior). Non-interactive/RPC → never restores files without an explicit option.
10. **Retention:** refs are namespaced per session; `draht checkpoint prune` plus an age/count policy in settings (default: 30 days). Snapshot objects share the repo's object store, so cost is incremental blobs only.
11. **Extension surface:** `pi.checkpoints` (list/get/restore) on `ExtensionAPI`, plus events `checkpoint_created` and cancelable `session_before_rewind` — so extensions can veto or observe, same pattern as `session_before_tree`.

---

## Goal & Non-Goals

**Goal.** A user presses `/rewind` (or the Esc-Esc menu), picks an earlier user message, and gets back **both** the conversation leaf and the working tree exactly as they were at that point — with the state they abandoned still recoverable, and with redo possible.

**Non-goals (v1).**
- Shadow git repo for non-git directories (Claude Code does this; recorded as OQ1 for v2).
- Preserving the staged/unstaged split — snapshots capture worktree content; restore leaves the user's real index alone except for restored paths. Documented, tested.
- Multi-root / files outside the cwd's repository; submodule contents (snapshot records the submodule pointer only).
- Remote/CI checkpointing.

---

## Acceptance (observable truths)

1. Agent overwrites a file (tracked or untracked) during a turn → `/rewind` to the previous user message → file content is byte-identical to before the turn, and files the agent *created* after that point are gone. — *restore is real, both directions.*
2. Immediately re-running `/rewind` to the pre-rewind point brings the clobbered-by-rewind work back. — *never destructive.*
3. `git stash list`, `git status` of staged entries, `HEAD`, and reflog are unchanged by capture and by rewind (except restored worktree paths). — *invisible to the user's git workflow.*
4. Kill the process mid-restore → on next inspection the working tree equals either the target or the safety snapshot, and both refs exist. — *atomic or recoverable.*
5. A session with 50 read-only turns creates ≤ 1 snapshot ref. — *dedup keeps it cheap.*
6. In a non-git directory, `/rewind` still navigates conversation with a clear "files not restored" notice. — *graceful degradation.*

---

## Architecture sketch

```
turn_start ─► CheckpointManager.captureIfChanged(leafEntryId)
                 │  GIT_INDEX_FILE=tmp; add -A; write-tree        (dedup: same tree hash → skip)
                 │  commit-tree → update-ref refs/draht/checkpoints/<sid>/<eid>
                 └─► append sidecar record + emit checkpoint_created

/rewind ─► selector (tree-selector filtered: user msgs with checkpoints, annotated)
        ─► scope menu (conv+files | conv | files)
        ─► session_before_rewind (cancelable)
        ─► safetyRef = capture(current leaf, label "pre-rewind")
        ─► restore: diff(safetyRef.tree, targetRef.tree) → checkout-index differing paths,
                    delete paths absent in target   [failure → re-apply safetyRef]
        ─► AgentSession.navigateTree(targetId)  (existing path: summary prompt, hooks, re-render)

/tree, /fork ─► existing flows + "restore files to this point?" when sidecar has the entry
```

Components: `src/core/checkpoints/checkpoint-manager.ts` (git plumbing, sidecar IO, prune), `core/builtins/checkpoints.ts` (event wiring, always loaded), interactive-mode `/rewind` command + selector integration, `draht checkpoint prune` CLI subcommand.

---

## Open questions & risks

**Risks:**
- **K1 — repo bloat from large untracked-but-not-ignored files** (build artifacts not in `.gitignore`). Mitigation: per-file size guard (warn + skip above threshold, configurable); dedup means unchanged blobs are free.
- **K2 — capture latency on huge repos** (`add -A` into temp index each turn). Mitigation: perf budget is a phase-33 requirement (p95 < 200 ms warm on a medium fixture repo; dedup fast-path < 50 ms); if exceeded, fall back to `git status --porcelain`-driven partial add.
- **K3 — concurrent sessions in one repo.** Mitigation: refs namespaced by session id; one temp index file per operation; no shared mutable state. Tested in Phase 43.
- **K4 — restore vs. files changed *by the user* (not the agent) since the checkpoint.** Rewind restores the tree as designed, but the safety snapshot means nothing is lost; the scope menu ("conversation only") is the escape hatch.

**Open questions (non-blocking):**
- **OQ1** — shadow repo for non-git cwds (v2?).
- **OQ2** — size-guard default threshold for K1 (1 MB? 10 MB?).
- **OQ3** — keybinding: add "rewind" to the existing double-escape tree/fork chooser vs. a dedicated chord.
- **OQ4** — retention defaults: 30 days vs. per-session ref cap vs. prune-on-session-delete only.
- **OQ5** — should `/rewind` offer to restore into a *new* session (`createBranchedSession` + restore) for a Codex-style "branch from checkpoint"?

---

## Next step

Milestone 5 in `ROADMAP.md` (Phases 41–43, all `pending`); requirement blocks `R41-CKP`, `R42-RWD`, `R43-SFT` in `REQUIREMENTS.md`. Execution begins with Phase 41 (capture engine — the riskiest layer: git plumbing correctness proven before any UX is built on it).
