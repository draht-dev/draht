# CONTINUE HERE

> Handoff written 2026-08-22. **29 commits** from one autonomous `/loop` run. **Phases 34 AND 35 are
> complete.** `npm run check` is green. `npm test` still fails on **exactly one** test, deliberately —
> the tailnet identity tripwire from Phase 33. Nothing else is red.

## What is true now that was not

**Open the app; every draht session running on your machine is there; steer any of them.** That sentence —
rev-8 §1, the one the product is defined by — now holds end to end:

- Oskar types `draht`. It registers a socket by default and appears on the phone.
- An agent asks for permission on the Mac; the ask reaches the phone; a tap answers it; the tool runs; and
  the session's own JSONL records what happened and who did it.
- Past sessions appear as history, honestly labelled, and resume over the wire.
- A phone that slept converges by delta on the same socket, without reconnecting.

| Phase | Commits | State |
|---|---|---|
| 34 — The Ask Reaches the Phone | 16 | `complete` |
| 35 — Every Session Is There | 13 | `complete` |

## Read this before trusting any green suite in this repo

**Nine separate suites in these two phases passed while the thing they named was broken.** Every one was
caught by mutation — breaking the feature on purpose and checking the test noticed — and none by reading a
passing run. The list, because the pattern is more useful than any single instance:

- A permission relay suite passed **141/141** with the relay's decision hardcoded.
- A decorator suite passed **17/17** with a fail-open inversion live.
- A history reader that consumed all **376 MB** passed 21/21 **faster than baseline**, because every
  assertion read counters the code kept about itself.
- A status probe hardcoded to `unknown` passed **7/7** — nothing asserted the honest positive.
- Half a split catch passed **10/10** — every explicit-flag test drove a bind that succeeded.
- `fleet_resync` returning an **empty payload** passed 6/6, because the assertion waited long enough for
  the delta stream to repair the view.
- **Nine** hardening properties on the spawn primitive were deletable in ONE edit, suite green.
- The lock format's readers were pinned and its only **writer** was not.
- The soak log's `client_attach` relocation — the fix for a real asymmetry — was invisible because every
  test client happened to carry the capability.

**Mutate in an isolated rsync copy, never a `git worktree` and never the shared tree.** A worktree does not
isolate this monorepo: `packages/<x>/node_modules/@draht/<y>` is a RELATIVE symlink resolved against its
target's real path, so `@draht/*` imports run the shared tree's code — wrong in BOTH directions, which is
worse than no mutation testing. And **copy `packages/*/dist`, never symlink it**: suites run `npm run
build` in `beforeAll` and tsc follows a dist symlink back into the real tree. Both mistakes were mine, both
are in `~/.claude/.../memory/parallel-wave-orchestration.md`, and the second one silently overwrote real
build artifacts before it was caught.

**Sanity-check isolation before trusting any mutation result** — make a change you know must fail and
confirm it fails.

## The two defects that failed OPEN

Everything else in both phases failed closed. These did not:

1. **An ask recorded as `expired` still ran its command.** The registry ended it, the wire and the JSONL
   said `expired`, and the local dialog stayed on screen — so a late answer executed against a durable
   record saying it was refused. Cause: `undefined` from the relay meant "spent, keep waiting", which is
   right for a refused raise and catastrophic for an ended ask. Now two different values.
2. **Two connections could both resume one session id, and both start a process.** Measured on the shipped
   daemon: `{ok:true, code:"resumed"}` twice, two draht processes on one session JSONL. The in-flight guard
   was per-connection, and the spawner read "a socket exists" as its own success — so the loser saw the
   winner's socket and reported success with its own dead child's pid.

## Still open — needs Oskar

**Two product decisions from Phase 35, recorded in `.planning/phases/35-default-on/PLAN.md`:**

1. **The `--continue` twin.** `continueRecent` reopens the most recent session FILE, so a second
   `draht -c` in one project reuses the header id and therefore the socket name. It degrades with a notice
   now instead of refusing to start — but the second window is silently NOT on your phone. Decoupling
   socket identity from session identity is recorded as named debt.
2. **Is a resumed session the daemon's child?** A daemon restart during Phase 39's 7-day soak takes every
   resumed session with it if they are children; detaching them means the daemon cannot enforce TERM→KILL.
   Related: a resumed session is an rpc-mode headless process, not the interactive draht a terminal runs.

**Four decisions still in `.planning/DECISIONS-PENDING.md`:** Phase 42 batching, GSEC-04 and GSEC-05
amendment sign-off, the Phase 44 threat model.

**The hardware residuals, unchanged since Phase 33:**

```bash
# THIS CLEARS THE RED TEST
node scripts/geist-tailscale-serve.mjs --capture-identity --peer <node> \
  --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json
#    then set DEFAULT_TAILNET_IDENTITY_HEADER in
#    packages/gateway/src/gateway/middleware/tailnet-identity.ts

node scripts/geist-tailscale-serve.mjs --verify --peer <node>   # reachability spike
node scripts/geist-device-evidence.mjs                          # class-4 device evidence
```

`~/.draht/gateway.config.json` still holds `host: "0.0.0.0"` with `tokens.default: "test"`. Nothing
listens on 7878 and the bind refusal prevents a wide bind — but the token is the literal string `test`.

## Carried forward, with owners

- **A `select`/`input` carrying a `tool_permission` detail still writes the wrong decision word** —
  under-reporting locally, a fabricated grant remotely. Closing it is a protocol revision.
  **Owner: Phase 37 opens the wire, Phase 38 freezes it at 1.0. It must not survive the freeze.**
- **The foreign-uid busy-lock refusal is unwitnessed** — it needs a second uid. Three ways to close it are
  costed in `session-resume.e2e.test.ts`'s notes; none is free.
- **The sockets-directory uid refusal is covered by reading only** — stated plainly in
  `socket-ownership-hygiene.e2e.test.ts` with the reason.
- **Replay starvation**: `pendingFor` truncates at 16 and nothing re-drives the remainder, so a client at
  the cap sees the same first 16 on every reconnect. Verified unreachable today (one pending ask per
  session), but the doc comment reads as if a later burst carries them.

## Next

**Phase 36 — Start Work From the Phone, Without Handing Out a Shell.** It inherits a large head start:
Phase 35 built the hardened spawn primitive early, because `session_resume` is already a client naming an
id and causing a process to start. `packages/gateway/src/session/spawn-primitive.ts` exists, the unguarded
`["draht","start"]` PATH spawn is gone, and **no route on the daemon creates a process from an HTTP
request**. What Phase 36 adds is the harness/project registry and `session_spawn` on top of it.

```bash
cd /Users/exe008/draht/draht-mono
git log --oneline -29
npm run check                 # expect exit 0
```

To restart the autonomous loop:

```
/loop /draht:resume-work with /draht:orchestrate ultracode workflows. they can use fable 5 advisors for difficult problems
```
