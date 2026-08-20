# CONTINUE HERE

> Handoff written 2026-08-20 before a context clear. Working tree is **clean** at
> `2ee60c857`; `npm run check` exits 0. Nothing is half-written on disk — every
> incomplete thing below is recorded as a `partial` phase with an explicit
> Residual list in `ROADMAP.md`, not as uncommitted work.

## Current Phase

**Phase 33 — On the Phone (Exposure, Pairing, Device Credentials)** — `pending`, ready to execute.
This is the phase that takes remote control off loopback and onto an actual phone:
`tailscale serve` exposure, QR/deep-link bootstrap, and rotated per-device credentials.

Read `.planning/ROADMAP.md` "## Phase 33" and `R33-REACH.*` in `.planning/REQUIREMENTS.md`.
Its first requirement is deliberately a **reachability spike** — prove `tailscale serve` reaches a
real phone browser *before* building on it, because a failure there re-plans Phases 34-40's
delivery model.

## Last Completed

**Phase 32 — Fleet, Attach & One Served Surface** (`2ee60c857`), landed `partial`.
The rev-8 product works for the first time: a headless browser loads the daemon-served bundle,
clicks a live `draht --attachable` session, types a prompt, and asserts the assistant's streamed
text in the DOM at desktop and 390x844. `fleet-attach.e2e.test.ts` passes 10/10, re-run five
consecutive times from a clean build.

## In Progress

Nothing is mid-edit. Three phases are `partial` and each carries its Residual list in `ROADMAP.md`:

- **Phase 32** — works; residuals are small. Most notable: the console replenishes its reconnect
  budget only on a successful ATTACH, so a console that connects but never opens a session gives up
  permanently (introduced by fixing the opposite bug). Also `@draht/ai` subpath aliasing is a point
  patch — `@draht/ai/providers/anthropic` still fails under jiti.
- **Phase 42 (/rewind)** — all 8 acceptance criteria pass; **blocked on a design decision** (below).
- **Phase 44 (sandbox core)** — dormant code, `enabled: true` required and nothing wires it in;
  **blocked on a threat-model decision** (below).

## Uncommitted Changes

None. `git status` is clean.

## Decisions Made This Session

- **geist pivoted from a Quest 3 spatial ADE to remote control over running draht sessions.**
  Spec: `.planning/specs/2026-08-18-geist-remote-control-rev8.md`. One core, three renderers —
  desktop and mobile are ONE responsive bundle at two viewports; spatial is a third renderer,
  scheduled last, off the critical path. geist absorbs `packages/gateway` (Phase 38).
- **Milestone 4 re-planned** into Phases 32-40 (`3d1fe4806`) by a three-angle judge panel. The
  angles disagreed on the central question — first moment a phone steers a session landed at Phase
  33, 39 and 40 — so the panel was worth running.
- **`--attachable` is opt-in, not default-on.** Phase 35 owns flipping it.
- **Planning reconciliation** (`cfabbf2be`): six phase statuses were wrong. 31/48/49 were `pending`
  but complete; 47/50/51 became `partial` with residuals.
- **Evidence discipline**: only class 3 (a test driving the emitted binary or public protocol) or
  class 4 (archived hardware) may close a phase. Package-level tests close nothing.

## Next Steps

```bash
cd /Users/exe008/draht/draht-mono
git log --oneline -1          # expect 2ee60c857
npm run check                 # expect exit 0
/resume-work                  # or restart the loop, see below
```

To restart the autonomous loop exactly as it ran:

```
/loop /draht:orchestrate ultradcode workflows with Fable 5 Advisors for all work left in @.planning/ starting with geist, geist needs to become an app thats just automatically give you remote control over all the draht sessions that you have running on a connected machine (tailscale is the number one connector for now)
```

To execute the next phase directly instead:

```
/draht:execute-phase 33
```

## Blockers

Four things need Oskar, not more agent work:

1. **Phase 42 batching-vs-callback.** `applyTreeDiff` spawns one `git checkout-index` process per
   path (~25s for 200 paths) and the suite now times out against its own 30s limit. Batching is the
   obvious fix but conflicts with the per-path `onPathRestored` callback the mid-restore
   failure-injection tests depend on. This is a design call, not a patch.
2. **Phase 44 threat model.** `R44-SBX.2` mandates a write allowlist containing the project tree,
   the OS temp dir and cache roots — and each is an execution vector for the *unsandboxed* shell
   that runs next (`.git/config`, `$TMPDIR` on `PATH`, npm cacache, cargo registry). Six critical
   escapes follow from the requirement, not the implementation. Needs a revised requirement:
   copied worktree, excluded `.git/`/`.claude/`, session-private temp, read-only cache roots,
   network-off default.
3. **GSEC-04 amendment.** Original demanded LAN mTLS 1.3 with pinned identity; rev 8 replaces it
   with loopback bind + `tailscale serve` TLS + tailnet identity + rotated device credentials.
   Weakens the stated remediation, strengthens the posture. Recorded in
   `.planning/geist/SECURITY-2026-07-13.md`, needs sign-off.
4. **GSEC-05 amendment.** Moved to Milestone 5 with a test-enforced condition that no approve/undo
   affordance exists in the served bundle. Needs sign-off.

Also waiting on Oskar, unrelated to design: **Phase 52 (publish)** needs npm/GitHub write access and
`packages/install` is still `"private": true`.
