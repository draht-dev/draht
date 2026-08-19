# geist rev 8 — Remote Control for Running draht Sessions

> **Status:** draft, supersedes the product definition in `.planning/specs/geist-spec.md` (rev 7).
> Rev 7 is **not deleted** — its spatial interaction design is retained as the *spatial renderer*
> of this spec (§5.3). What changes is which surface is the product and which is a renderer.
> **Date:** 2026-08-18. **Author:** pivot directed by Oskar; grounded by three Fable 5 advisor
> consults and the verification log in §9.

## 1. Product thesis

> "geist should just absorb gateway … the desktop and the mobile companion is then just like a
> ChatGPT Codex or a Claude desktop app, and on a VR goggle it's a spatial agentic ADE, but they
> basically have the same building blocks — as UI elements on a screen, or as spatially placed
> sessions." — Oskar, 2026-08-18

geist is **one core with three renderers**. The core discovers, attaches to, and steers every draht
session running on a connected machine. A renderer decides only whether a session is *laid out* (a
row on a phone, a pane on a desktop) or *placed* (a panel in space). Nothing about discovery,
attach, permission, or run rendering is renderer-specific.

The single sentence the product must satisfy:

> Open the app; every draht session running on your machine is there; steer any of them.

## 2. What changes from rev 7

| | rev 7 | rev 8 |
|---|---|---|
| Product | Quest 3 spatial ADE | Remote control for running draht sessions |
| Primary surface | Headset | Desktop + mobile; headset is a third renderer |
| Critical path | Nine H-gates on physical Quest 3 | CI-testable host + protocol; zero hardware gates |
| Transport | LAN pairing | Loopback bind, exposed via `tailscale serve` |
| `packages/gateway` | Separate experiment | **Absorbed** — becomes geist's daemon host |
| Session model | Sessions geist spawns | Sessions geist *discovers*, spawned or not |

Rev 7's spatial design (ray targeting, panel placement, pointing-to-address, variants shoot-out)
survives intact as §5.3. It stops being a precondition for shipping.

## 3. The building blocks (renderer-agnostic)

These are the core. Every renderer consumes exactly these and adds only layout.

| Block | Responsibility | Substrate today |
|---|---|---|
| **B1 Discovery** | Enumerate every live draht session on the machine, with pid, cwd, id | `coding-agent/src/core/socket-server/discovery.ts` — **works, unwired** |
| **B2 Attach** | Multi-client attach to a running session; output out, input in | `socket-server.ts` + `socket-client.ts` — **works, unwired** |
| **B3 History** | Past sessions, resumable by id | `~/.draht/agent/sessions/<cwd-slug>/*.jsonl`, `--session`/`--resume` |
| **B4 Fleet state** | Projection of B1+B3 into one addressable list with capabilities | `geist-protocol` `fleet_state` |
| **B5 Permission relay** | Agent asks; any renderer answers; answer is authoritative | `geist-protocol` `permission_request`/`permission_answer`, `geist/src/session-bridge.ts` |
| **B6 Run lanes** | Tool calls, plans, diffs rendered as structured lanes, not raw text | `geist-core/lanes`, `coding-agent/src/modes/rpc/` |
| **B7 Registry** | Projects and harnesses; what may be spawned and where | `geist-protocol/config.ts`, `geist-core/registry` |
| **B8 Transport** | Daemon host, auth, pairing, WS | `packages/gateway` + `geist/src/pairing/server.ts` |

**The product is B1→B8 wired together.** The 2026-07-13 audit's finding was that geist had
primitives without composition. This spec's acceptance is composition, and nothing counts until a
block is reachable from the emitted binary.

## 4. What "automatically" must mean

The word in the brief is load-bearing. The zero-config bar:

- **No IP typing.** First contact is a QR / deep link carrying a MagicDNS URL and a one-time
  bootstrap token. Thereafter the app reconnects to a stable name with a stored device credential.
- **No per-session registration.** A session appears because it is *running*, not because it was
  started by geist. This is the whole point, and it is what B1+B2 buy.
- **No manual token copying** after first pair. The bootstrap token is exchanged for a rotated
  per-device credential and never reused.
- **Honest v1 limit:** "running" means a session that registered a control socket. Sessions started
  by a draht build that predates socket wiring are visible as *history* (B3), resumable but not
  live-attachable. This distinction must be visible in the UI, never papered over.

## 5. Renderers

All three consume `fleet_state` and the same message set. They differ only in placement.

### 5.1 Desktop (reference renderer)
A Claude-desktop / Codex-shaped app. Session list, transcript, run lanes, permission prompts,
diff review. This is where a block is proven before any other renderer gets it.

### 5.2 Mobile companion
Same blocks, one session at a time, optimized for the actual mobile job: *an agent asked for
permission while you were away, and you answer it from your phone.* B5 is the flagship feature and
the reason the mobile app justifies its existence.

### 5.3 Spatial (Quest 3)
Same blocks, sessions *placed* rather than listed: a panel per session, pointing to address, and
rev 7's spatial-organization dividends (multi-viewport, pins, pose persistence). Runs **off the
critical path** — it ships when hardware evidence is recorded, and its absence never blocks 5.1/5.2.

## 6. Transport and security

Non-negotiable, from `.planning/geist/SECURITY-2026-07-13.md` and the §9 verification log:

1. **Loopback bind, code-enforced.** `packages/gateway`'s `DEFAULT_CONFIG.host` is `"0.0.0.0"`
   today (`src/config/config.ts:38`). It must become `127.0.0.1`. A non-loopback bind requires an
   explicit flag that warns.
   **Correction (2026-08-18):** an earlier draft of this line said the warning should "name GSEC-04".
   That was wrong and is retracted. GSEC-04's subject in `.planning/geist/SECURITY-2026-07-13.md` is
   `createPairingServer()` in `packages/geist/src/pairing/server.ts`, which the gateway bind work does
   not touch — that server still calls `Bun.serve({ port })` with no hostname option, so GSEC-04
   remains OPEN. Operator-facing refusal text must carry no finding ID; where the gateway docs mention
   GSEC-04 they must state explicitly that this change does not close it.
2. **Exposure via `tailscale serve` only.** This yields TLS with a real certificate and a stable
   MagicDNS name. That is not a nicety: Quest browser and iOS clients require `wss://` with a
   trusted cert, and a bare `ws://100.x` does not give them one. No Funnel — ever.
3. **No arbitrary command execution.** `POST /sessions` currently accepts any `command: string[]`
   and passes it to `Bun.spawn`; `validateCommand` (`routes/sessions.ts:46`) is a shape check with
   no binary allowlist. Replace with harness-id + project selection resolved against B7's registry.
4. **No tokens in query strings.** Move to first-message auth, as the pairing server already does.
5. **Bootstrap token → rotated device credential**, modelled by the existing `PairingState`.
6. When fronted by `tailscale serve`, additionally assert the tailnet identity header matches the
   configured owner — defense in depth, never the only check.

## 7. Package disposition

| Package | Disposition |
|---|---|
| `packages/gateway` | **Absorbed into geist.** Daemon host, lifecycle, EventBus, auth middleware kept; raw-stdout session wire retired in favour of geist-protocol |
| `packages/geist` | Composition root — the thing that is currently a stub |
| `packages/geist-protocol` | The single wire protocol |
| `packages/geist-core` | Fleet projection, pairing, lanes, registry, variants |
| `packages/geist-acp` | Structured harness control (upgrade, not a v1 gate) |
| `packages/draht-acp` | The only package permitted to import the Draht kernel |
| `packages/geist-picker` | Parked with the spatial renderer |
| `packages/geist-console` | Becomes the desktop renderer (5.1) |
| `coding-agent/core/socket-server` | Promoted from orphan to load-bearing; needs wiring + tests |

## 8. Acceptance model (anti-repeat of 2026-07-13)

Every criterion states its **evidence class**, and only classes 3 and 4 may close a phase:

1. *source-only* — code exists. Closes nothing.
2. *package-tests* — unit/integration tests inside a package. Closes nothing on its own.
3. *production-e2e* — a test drives the **emitted binary** or the **public protocol** end to end.
4. *hardware* — archived physical-device evidence. Required only for the spatial renderer.

The rev-7 failure was recording class 2 as class 3. Each phase's completion entry must name its
class explicitly.

## 9. Verification log (2026-08-18)

Facts established by direct execution, not inference:

- **Attach substrate round-trips: 9/9.** A harness exercising `SocketServer` + `discoverSocketSessions`
  + `SocketClient` proved socket bind, discovery with live-pid filtering, cwd reporting, metadata on
  attach, server→client streaming, client→server input, multi-client tmux-style echo, and
  disappearance from discovery on stop. **Remote control of running sessions is a wiring job, not a
  build job.**
- **The substrate is unwired.** `makeSessionAttachable` has zero call sites; no `--attachable`/
  `--attach` flag exists; `~/.draht/agent/sockets/` does not exist on this machine.
- **`packages/gateway` is green:** 199 tests pass, 0 fail, 30 files, 2.09s.
- **Session history is enumerable:** 843 project-keyed directories under `~/.draht/agent/sessions`;
  each JSONL's first line carries `id`, `cwd`, `timestamp`. 118 sessions for draht-mono alone.
- **`--session` / `--resume` exist** in `coding-agent/src/main.ts`.
- **Latent exposure:** `~/.draht/gateway.config.json` on this machine sets `host: "0.0.0.0"` with a
  token. The gateway is **not currently running** (nothing listening on 7878), so this is latent,
  not live — but it would expose arbitrary command execution on first start on any network joined.

## 10. Open questions

1. Does the desktop renderer reuse `geist-console` (React) or the existing `packages/web-ui`?
2. Is Adler (external Flutter client) usable as the mobile renderer, or is a gateway-served web UI
   the faster path to a working phone surface?
3. Does socket registration default **on** for interactive sessions, or behind a flag? Default-on is
   what makes the product promise true; it also means every session opens a local socket.
4. How do the 13 GSEC findings re-own onto the new phase set — which are transport-layer (closed by
   §6) and which remain agent-layer?
