# CONTINUE HERE

> Handoff written 2026-08-22. **15 commits** from an autonomous `/loop` run. Phase 34 is **complete**.
> `npm run check` is green. `npm test` still fails on **exactly one** test, deliberately — the tailnet
> identity tripwire from Phase 33, described below. Nothing else is red.

## What landed

**Phase 34 — The Ask Reaches the Phone (Permission Relay) — `complete`.** An agent asks for permission
on the Mac, the ask reaches a phone, a tap answers it, the tool runs, and the session's own JSONL records
what actually happened and who actually did it. Proven class 3 over **two independent transports**: the
gateway's WebSocket, and a raw `net.Socket` speaking newline-JSON straight to the published `.sock`.

| Suite | Result |
|---|---|
| permission unit suites (7 files) | 202 pass |
| `permission-relay-roundtrip.e2e` | 7 pass — incl. an expired ask that cannot be revived |
| `permission-answer-validation.e2e` | 1 pass, 65 expects — four bad answers, none consuming |
| `permission-durability.e2e` | 6 pass |
| `permission-enumeration.e2e` | 12 pass — incl. two fail-open negative controls |
| `permission-safe-text.e2e` | 5 pass |
| `attach-mode-permission.e2e` | 9 pass |
| `geist-console-permission.e2e` | 7 pass — real browser |

The seam question that blocked this phase (decision 5) was **resolved from the spec, not by a product
call**: rev-8 §4 says a session appears "because it is *running*, not because it was started by geist —
this is the whole point", so an ACP-seam relay fails the sentence the product is defined by. Recorded in
`.planning/DECISIONS-PENDING.md`.

## Read this before trusting any green suite here

**Four separate suites passed while the thing they named was broken.** Every one was caught by mutation —
breaking the feature on purpose and checking the test noticed — and none by reading a passing run:

- The enumeration proved a tool *ran*, not that an *answer made it run*. `raise()` self-resolving as
  approved without waiting left all five approve tests green.
- `truncated` was a lie: a 5000-character command arrived elided to ~530 and reported that nothing was
  abbreviated. The test asserting `truncated: false` was pinning the defect as correct.
- Both of T10's build items (replay cap, its capability gate) survived deletion.
- `console.css`'s entire bidi defence could be deleted unnoticed.

A suite passed **141/141** with the relay's decision argument hardcoded. Another passed **17/17** with a
fail-open inversion live. Treat "the tests pass" as the beginning of verification here, not the end.

**Mutate in an isolated worktree or an rsync'd copy under `/tmp`, never in the shared tree.** A wave-4
agent left `// MUTATION 4: bidi overrides are no longer neutralized` live in `safe-text.ts`, deleting the
RLO range the spoof defence exists for. HEAD was clean; the working tree was not. The later wave was told
to isolate and all four did, leaving zero markers. Before committing anything a mutation-testing agent
touched, grep the diff for `MUTATION`.

## The one defect that failed OPEN

Everything else in this phase failed closed. This one did not, and it was found by a test written for
something else: **an ask recorded as `expired` still ran its command.** The registry ended it, the wire
and the JSONL both said `expired`, and the local dialog stayed on screen — so a late answer executed
against a durable record saying it was refused.

Cause: `undefined` from the relay meant "spent, keep waiting", which is right for a refused raise and
catastrophic for an ended ask. Those are now two different values (`RelayEnded`), and an ending is
honoured whether or not a local surface is live.

## Carried forward — one unclosed falsehood, with an owner

A `select` or `input` carrying a `tool_permission` detail still writes the **wrong decision word**:
under-reporting locally (`cancelled` for a command that ran), a fabricated grant remotely (`approved`).
Proven live with a probe extension, which also falsified the earlier containment argument that
`select`/`input` never carry such a detail.

`RelayOutcome` already carries the honest `answered` kind; what is missing is a neutral member in the
wire's `TerminalDecision`. Closing it is a **protocol revision** no single task's file set can reach:
`socket-server/types.ts`, `PermissionResolutionEntry.decision`, `geist-protocol/src/wire.ts`, its geist
mirror, `MIRRORED_FRAMES`, the regenerated `geist-0.3` corpus and `MIGRATIONS.md`.

**Owner: whoever next opens the wire — Phase 37 changes it for run lanes, Phase 38 freezes it at 1.0.
It must not survive the freeze.** Recorded in `.planning/ROADMAP.md` under Phase 34.

## Known-weak, recorded rather than fixed

- The **capability gate on replay** is unwitnessed in the negative direction: removing it ships green.
  The gate is present and correct; a future edit deleting it will not be caught.
- **Replay starvation**: `pendingFor` truncates at 16 and nothing re-drives the remainder, so a client at
  the cap sees the same first 16 on every reconnect. Verified unreachable today — the gate parks the turn
  on one ask per session — but the doc comment reads as if a later burst carries them.
- `SettleRefusal "cross_session"` is unreachable from the socket path (`handleResponse` always passes its
  own bound sessionId). It is a guard on direct registry use, not a wire-reachable state.

## What still needs Oskar — unchanged from Phase 33

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
listens on 7878 and Phase 32's bind refusal prevents a wide bind at next start — but the token is the
literal string `test`.

**Four decisions remain open** in `.planning/DECISIONS-PENDING.md`: Phase 42 batching, GSEC-04 and
GSEC-05 amendment sign-off, and the Phase 44 threat model.

## Next

**Phase 35 — Every Session Is There (Default-On, History, Honest Liveness).** It is the phase that makes
"just automatically" literally true: `draht` with no flags shows up on the phone. Note R35-ALWAYS.5 is a
prerequisite — `activeRewinds` in `coding-agent/src/core/checkpoints/rewind.ts` is module-global and
default-on multiplies attachable sessions per host.

```bash
cd /Users/exe008/draht/draht-mono
git log --oneline -15
npm run check                 # expect exit 0
```

To restart the autonomous loop:

```
/loop /draht:resume-work with /draht:orchestrate ultracode workflows. they can use fable 5 advisors for difficult problems
```
