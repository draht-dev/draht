# CONTINUE HERE

> Handoff written 2026-08-21. **30 commits** from an autonomous `/loop` run. `npm run check` is green.
> `npm test` fails on **exactly one** test, deliberately — see "The red test" below before you treat it
> as a regression.
>
> Note: another of your sessions committed to `main` concurrently (landing pages, `draht-claude install
> --force`). No file overlap with this work, but two agents on one working tree is a race, not a design.

## Current Phase

**Phase 34 — The Ask Reaches the Phone (Permission Relay)** — `pending`, **blocked on a product decision**.
Its viability probe ran and found the requirement names the wrong seam. Do not start building until the
seam is settled — see decision 5 in `.planning/DECISIONS-PENDING.md`.

## Last Completed

**Phase 33 — On the Phone** landed `partial`. **A phone pairs by QR and steers a live draht session over
TLS**, proven class 3 against the emitted binaries, not asserted in process.

| Suite | Result |
|---|---|
| `reach-transport.e2e.test.ts` | 9/9 — eight acceptance clauses + whole-run 127.0.0.1 bind |
| `first-pairing-no-restart.e2e.test.ts` | 5/5 — QR pairs an already-running daemon, unchanged pid |
| `geist-reach-browser.e2e.test.mjs` | 2/2 — full journey + proxy killed mid-stream |
| `fleet-attach.e2e.test.ts` | 10/10 — Phase 32's invariant preserved through the new path |
| `geist-console-bundle.e2e.test.mjs` | 29/29 — incl. 390x400 keyboard layout, 44px targets |
| `packages/gateway` | 364 pass, 1 fail (the deliberate tripwire) |

## The red test — read this before "fixing" it

```
packages/gateway/src/__tests__/tailnet-identity.test.ts
  → "the pinned identity-header contract > is a real capture, not the placeholder this repo ships"
```

The real tailnet identity header **has never been observed on this machine**. The pin ships as a marked
placeholder and this test fails until a human captures the real one. It is a gate, not a bug. Its failure
message names the command. **Do not skip, exclude, delete or `continue-on-error` it** — `.planning/ROADMAP.md`
says so under Phase 33's run-budget note, and CI is knowingly red on it.

The deny-only policy it guards **is** tested and green. What is unverified is which header name Tailscale
actually sends.

## What needs Oskar — nothing here is more agent work

### Hardware / tailnet (Phase 33's three residuals)

```bash
# 1. the reachability spike — proves tailscale serve carries wss:// to a real browser
node scripts/geist-tailscale-serve.mjs --verify --peer <node>

# 2. THIS CLEARS THE RED TEST
node scripts/geist-tailscale-serve.mjs --capture-identity --peer <node> \
  --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json
#    then set DEFAULT_TAILNET_IDENTITY_HEADER in
#    packages/gateway/src/gateway/middleware/tailnet-identity.ts to the header it records

# 3. class-4 device evidence — iOS Safari + Quest 3 (Quest has been offline 36 days, charge it)
node scripts/geist-device-evidence.mjs            # then --measure for the Phase 39 inputs
```

Recorded skew worth knowing before you run these: tailscale CLI 1.98.8 vs tailscaled 1.102.1, and
`tailscale serve status` reports no serve config — this is a first publish.

### Five decisions, all in `.planning/DECISIONS-PENDING.md` with recommendations

1. **Phase 42 batching-vs-callback** — the dichotomy is false; the callback has no production consumer.
2. **Phase 44 threat model** — advisor *rejects* the copied-worktree pivot you had recorded.
3. **GSEC-04 amendment** — sign off with seven conditions.
4. **GSEC-05 amendment** — sign off, but record it OPEN with owner Phases 42-43.
5. **Phase 34's seam (NEW)** — the probe and the advisor disagree, and it is a question about what geist
   *is*, not about code.

### Machine state, unchanged and still worth a minute

`~/.draht/gateway.config.json` holds `host: "0.0.0.0"` with `tokens.default: "test"` and
`allowedPaths: ["~/"]`. Nothing listens on 7878 so it is latent, and Phase 32's bind refusal now prevents
a wide bind at next start — but the token is the literal string `test`.

## Phase 34's probe — why it is blocked

The probe drove four real sessions rather than reading code. It found:

- **The phone never reaches `createExtensionUIContext`**, which is what R34-PERM.2 tells us to hook. geist
  spawns `draht-acp` headless — no InteractiveMode, no TUI. Two disconnected permission systems exist and
  the requirement names the one the phone cannot see.
- **Under shipped defaults an external ACP client's `bash` call hard-fails with ZERO permission requests
  raised.** The probe's first run only worked because its shell had `DRAHT_PERMISSION_MODE=auto`. This is
  a defect in what ships today.
- **A real approved permission leaves no trace in the session JSONL.** R34-PERM.2 demands the resolution be
  asserted from the JSONL; nothing writes one. That is a durability task the requirement smuggled in.
- **On the attach wire, answering "Yes" is swallowed as a queued new prompt.**

The Fable 5 advisor (high confidence) rejects the probe's fallback of re-speccing onto the ACP seam,
because that path runs through `packages/geist/src/pairing/server.ts` — GSEC-04's named subject and rev-7
leftover — and would relay permissions only for geist-*spawned* sessions, leaving the sessions you start
in your own terminal with no relay at all. It recommends a `RelayUIContext` decorator at the mode-agnostic
injection point instead.

An R34-PERM.8 turn-hold measurement was running when this handoff was written; check
`.planning/ROADMAP.md` Phase 34 for its result.

## Uncommitted

Nothing of this loop's. Your other session left `packages/landing/pnpm-lock.yaml` and
`packages/landing/pnpm-workspace.yaml` untracked — deliberately not touched.

## Next Steps

```bash
cd /Users/exe008/draht/draht-mono
git log --oneline -1
npm run check                 # expect exit 0
cd packages/gateway && bun test   # expect 364 pass, 1 fail (the tripwire)
```

Then either answer the five decisions, or run the three hardware commands above to close Phase 33.

To restart the autonomous loop:

```
/loop /draht:orchestrate ultradcode workflows with Fable 5 Advisors for all work left in @.planning/ starting with geist, geist needs to become an app thats just automatically give you remote control over all the draht sessions that you have running on a connected machine (tailscale is the number one connector for now)
```

## Lessons worth keeping

- **A class-3 test found what code reading missed.** The daemon could not pair a device at all —
  `cli.ts` never constructed a `DeviceRegistry` — and the gate that caught it was an acceptance suite
  driving the emitted binary. Package-level tests would have stayed green.
- **A feature can pass its own spec while being dormant in production.** Ask reviewers explicitly: is this
  live, or inert until something else wires it?
- **Two acceptance clauses asserted the wrong thing.** Both were fixed against verified product behaviour
  rather than bending the product — but "it's just a test bug" is how broken security ships, so each was
  checked against the documented design first.
