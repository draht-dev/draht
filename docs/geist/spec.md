# SPEC — geist

> Canonical planning source: `.planning/specs/geist-spec.md`. This copy is the public-facing reference; keep both in sync by hand until a sync script exists.

> Working title (de: *Geist* — the ghost in your app). Rename = find/replace, zero coupling.
> A harness-agnostic ADE in the spirit of [Orca](https://github.com/stablyai/orca) and [t3code](https://github.com/pingdotgg/t3code), rebuilt for mixed reality: your coding agents — **any ACP agent: Claude Code, Codex, Gemini CLI, OpenCode, draht, ~50 in the registry** — live as panels in passthrough on Quest 3. Point at your running app and talk to change it; point at an agent and talk to steer it; point at the board and spawn sessions in any project on the dev machine.

**Home:** [`draht-dev/draht`](https://github.com/draht-dev/draht) monorepo — with a hard import boundary (§17.1): geist core knows only ACP; draht holds zero code-level privileges.
**Status:** rev 7 · no open decisions. Flip-cheap locks flagged in §17.
**Rev history:** r2 coupled to draht · r3 fleet/modes/orchestrate · r4 orchestration corrected to agent-side · r5 project registry + spatial workspace · **r6 decouples from draht: geist is an ACP client** (Agent Client Protocol, the LSP-for-agents standard — Zed/JetBrains/MS Terminal clients; Claude Code & Codex via maintained adapters; Gemini/OpenCode native); draht participates through a thin `draht-acp` shim with exactly the privileges of any other agent · **r7 design language: geist glass** — Apple-Liquid-Glass-derived, adapted to Quest's real constraints (no passthrough sampling → a two-material system, §13).

---

## 1. One line

Your coding agents — whichever you run — in the room with you: **point at your app, or at an agent, and talk.**

## 2. Core story & clarity verdict

One interaction — point + talk — three addressees. **Pointing is addressing:**

| You point at… | Talking means… |
|---|---|
| an **element** in an app panel | a design/change request, context-packed, to the session owning that panel |
| an **agent** (session card / detail panel) | a plain message to that session — commands, follow-ups, `allow`/`deny` on its permission requests |
| the **fleet board** | a global act: spawn a session (any harness, any project), `variants n`, open/close/switch |

The harness is a *qualifier*, like the project: *"new **claude** session **in kintura**: …"*. It adds a word to the sentence, not a second interaction.

| Candidate | Verdict | Ruling |
|---|---|---|
| App panel · element pointing · PTT → prompt · loop close | core | M0–M3. |
| **ACP harness layer** (any registry agent; capability-negotiated) | core (r6) | Structured sessions, tool-call updates, plan updates, permission requests — the exact event vocabulary the board needs, standardized. Bespoke per-CLI adapters (t3code's road) and PTY scraping both rejected (§5). |
| **Permission requests in XR** (agent asks → chip on its card → voice `allow`/`deny`) | core (r6) | Fell out of ACP for free; completes the trust loop alongside approve/undo. |
| Fleet · Projects · Spatial organization · Commands by voice · Variants | core | As r5. Variants gains **mixed harnesses**: *"variants with claude, codex and draht: …"* — the compare row becomes an agent shoot-out. |
| Run rendering (tool/plan lanes; draht subagent lanes as data-driven enrichment) | core | Generic via ACP tool-call/plan updates; typed lanes are a recognizer, not an import. |
| **geist glass** design language (Liquid-Glass-derived, two honest materials) | core (r7) | The look is a product decision, not decoration: token-driven (§13), perf-budgeted (§14), signature placed in the core gesture — the target ring. |
| Multi-viewport · pins · history · pose persistence | bonus | v1.5 (M8). |
| Terminal panels · direct manipulation · GitHub/Linear · PTY fallback · non-ACP agents | cut / v2 | Registry coverage (~50) makes PTY's mush a bad trade. |

## 3. Does / does NOT

**Does (v1):**
- Any URL as a passthrough panel; hover highlight; PTT → frozen target → DE/EN transcription → dispatch.
- **Harnesses:** configured set of ACP launch specs (draht via shim, Claude Code via `claude-agent-acp`, Codex via `codex-acp`, Gemini native — exact commands pinned at M3 from the ACP registry). `geist doctor` verifies each agent's own auth (t3code-style: `claude auth login`, `codex login`, …). Capabilities negotiated per ACP handshake; geist degrades per capability (images, commands, modes, resume), never per harness name.
- **Permissions:** ACP permission requests render as option chips on the session card; voice `allow|erlauben` / `deny|ablehnen` resolves the pending request of the pointed session (single global pending → pointing optional); richer option sets are tappable chips.
- **Projects · Fleet · Addressing · Variants · Spatial layout · Follow-ups:** as r5 (registry = yaml ∪ workspaceRoots discovery ∪ recents; ≤4 sessions across projects *and harnesses*; scoped approve/undo/stop; sibling-worktree variants — now optionally one harness per member; board-anchored project clusters).
- **Commands:** palette + voice set fed by whatever the agent advertises over ACP (commands/modes) — plus verbatim `/…` pass-through always; each harness interprets its own slash commands.
- **Run rendering:** tool-call and plan updates → live lanes for every harness; draht's `subagent` tool calls get typed lanes via a name-keyed recognizer; `.planning/loop/LOOP.md` surfaced when present (file-based, harness-neutral).

**Does NOT (v1):**
- No geist-side orchestration, no PTY scraping, no non-ACP harnesses, no voice-spoken paths, no in-headset editors/terminals, no GitHub/Linear, no direct manipulation, no native-app targets, no geist cloud, no store release.

## 4. The core loop (UX contract) — as r5, two additions

…3a. The agent wants to run `pnpm test` — a chip appears on its card; you glance over: *"allow."*
…4a. *"new codex session in kintura: tighten the hero animation"* — harness word optional; default harness applies when omitted. Everything else unchanged (element loop, `/review` on a card, orchestrate-by-command where the harness has it, variants winner by pointing).

## 5. Platform & architecture decisions (locked) & rejected alternatives

**Locked:** Meta Spatial SDK (Kotlin) headset app · draht-monorepo home **with enforced import boundary** · projects/worktrees/git/variants/spatial layer exactly as r5 — all of it was already harness-free.

**Locked (r6): the harness layer is an ACP client.** One `HarnessSession` port in `geist-core`, implemented once over ACP (JSON-RPC 2.0, stdio subprocess per session, capability handshake). Agents are launch specs, not integrations.

| Alternative | Why rejected |
|---|---|
| draht SDK binding (r2–r5) | Oskar's call, and the ecosystem agrees: the structured-events problem ACP solves is exactly what the SDK binding solved — minus the lock-in. draht keeps first-class *support* via `packages/draht-acp`, gaining Zed/JetBrains/geist in one shim. |
| Bespoke per-CLI adapters (t3code's current model) | N integrations tracking N fast-moving CLIs; ACP's registry already covers that set and 40 more. t3code predates registry maturity; geist doesn't. |
| PTY scraping (Orca's lowest common denominator) | Spinner frames and idle heuristics instead of tool-call events; the board would be guessing. Rejected outright, not deferred. |
| ACP-only *and* nothing else | Accepted — with eyes open: non-ACP agents are simply out of scope until they adapt, which the market is doing for us. |
| WebXR · Unity · streaming · standalone repo · bridge-side orchestration | As r2–r5. |

## 6. Locked stack

| Layer | Choice | Notes |
|---|---|---|
| Headset app · Panels · Input · Spatial layout | As r5 (Spatial SDK pinned at M0 · board/detail/app WebViews, ≤3 live · addressee at PTT press · project arcs, compare row, grabbable, anchors in M8) | |
| Bridge | `packages/geist` (composition root) + **`packages/geist-core`** (sessions, projects, registry, git, variants, composer, ports — **imports no @draht/\***) | TS strict · Bun (Node ≥20 ok) · Hono + WS · bin `geist`. |
| Harness layer | **`packages/geist-acp`**: ACP client (pinned protocol lib version), subprocess lifecycle, capability handshake, event normalization → `HarnessSession` port | The only code that knows ACP wire shapes. |
| Agents | Launch specs in config; v1 pinned set at M3 from the ACP registry: `draht` (via **`packages/draht-acp`** shim — pi-acp lineage), `claude` (`claude-agent-acp`), `codex` (`codex-acp`), `gemini` (native flag) | The shim doubles as draht's door into Zed/JetBrains — a gift beyond geist. |
| Design language | **geist glass** (§13): `tokens.css` consumed by the console *and* the picker overlay · **Geist / Geist Mono** typefaces (OFL, self-hosted) · two materials: room-glass (alpha smoke over passthrough) and content-glass (blur/refraction tiers inside panels) · Kotlin panels match radii + alpha (M0 probe) | Accent is dichroic (`spectra` gradient), reserved for target ring · PTT states · approve. |
| Dispatch | Element → composed situation prompt; image content block when capability-advertised, crop **always** at `<wt>/.geist/task-<id>/target.webp` and path-referenced · commands/free speech → prompt text (harness expands its own `/…`) · streaming → ACP cancellation/queue semantics per capability; *"stop and …"* = cancel + re-prompt where mid-turn steer isn't offered | |
| Sessions & worktrees · sha ledger · lazy dev servers · ports | As r5 (`<repo>/.geist/wt/<slug>`, `baseSha`/`lastApprovedSha`, undo = `reset --hard <ref>`, `PORT` templating, headless-until-configured) | Harness-free then, harness-free now. |
| Run rendering | ACP tool-call + plan updates → generic lanes; `subagent-recognizer.ts` upgrades draht/Claude-Task-style calls to typed lanes (golden-tested, data-driven) | |
| Permissions | ACP permission requests ↔ `permission_request`/`permission_answer` WS messages; options rendered as chips; voice allow/deny maps to the closest offered option | |
| ASR · Picker · Protocol · Console · Config · Tooling | As r4/r5 (whisper.cpp turbo/small · IIFE picker · zod + Kotlin mirrors + `check-geist-mirrors` · React `/ui` · `--config` > `./geist.yaml` > `~/.geist/config.yaml` · root `check`, vitest per package, Playwright, gradle, repo AGENTS.md binding) | Faux-provider tests move inside `draht-acp`; geist-core e2e runs against a **mock ACP agent** (tiny deterministic stdio process in-repo). |

## 7. Architecture

```
┌────────────────────────────── Quest 3 ───────────────────────────────────┐
│ quest/ — Kotlin · Spatial SDK · passthrough                               │
│  board (clusters, lanes, permission chips) · session details · app panels │
│  ray→addressee · PTT FSM · AudioRecord · PixelCopy · layout · WS          │
└───────────────────────────────┬───────────────────────────────────────────┘
                          WS (LAN, token)
┌───────────────────────────────▼───────────────────────────────────────────┐
│ geist bridge                                                               │
│  geist-core: pairing · addressee router · composer · project registry ·   │
│              worktree/port mgr · sha ledger · variants · git ops · /ui     │
│  geist-acp:  HarnessSession port ⇄ ACP client ── subprocess per session    │
│              capability handshake · events · permissions · cancel          │
│      ├── draht-acp shim ─→ draht        ├── claude-agent-acp ─→ Claude Code│
│      ├── codex-acp ─→ Codex             └── gemini (native ACP) …registry  │
│  whisper.cpp (DE/EN)                                                       │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ localhost / LAN
              per-project worktree dev servers (HMR), spawned lazily
```

Strict responsibilities: Kotlin never composes prompts · bridge never renders, never orchestrates, never talks to an LLM · **geist-core never speaks ACP; geist-acp never touches git or layout** · picker is the only code inside target pages.

## 8. Repo layout (inside draht-dev/draht)

```
packages/
  geist/            # CLI + composition root (wires core + acp + console)
  geist-core/       # harness-free product logic (boundary-checked)
  geist-acp/        # ACP client + HarnessSession implementation
  draht-acp/        # thin ACP shim for draht (pi-acp lineage)
  geist-protocol/ geist-picker/ geist-console/
quest/              # Kotlin · NOT a workspace
scripts/check-geist-mirrors.mjs · scripts/check-geist-boundary.mjs   # both in root `check`
.planning/geist/ · geist.yaml.example · docs/geist/spec.md
```

## 9. Contracts

### 9.1 Config — r5 plus harness block

```yaml
harness:
  default: draht
  agents:            # ACP launch specs; exact cmds/args pinned at M3 from the registry
    draht:  { cmd: draht-acp }
    claude: { cmd: claude-agent-acp }
    codex:  { cmd: codex-acp }
    gemini: { cmd: gemini, args: [--experimental-acp] }
```

### 9.2 WS protocol — r5 plus

| type | dir | payload |
|---|---|---|
| `fleet_state` | B→H | sessions gain `harness, capabilities: {images, commands, modes, resume}`; `agents: [{name, authOk}]` |
| `session_new` | H→B | + `harness?` (default applies when omitted) |
| `permission_request` | B→H | `sessionId, requestId, title, options: [{id, label, kind}]` |
| `permission_answer` | H→B | `sessionId, requestId, optionId` |
| `variants_new` | H→B | + `harnesses?: [name]` (round-robins across members when set) |
| everything else | ↔ | as r5 |

### 9.3 `ElementContext` — unchanged (r2)

### 9.4 Dispatch composition — as r4/r5, capability-gated

(Situation prompt + image block where advertised, crop always on disk; `/…` passes through verbatim — each harness owns its command semantics; steer via cancel+re-prompt where needed; courtesy `/design` template remains a draht package extra, not a geist dependency.)

### 9.5 Voice grammar — r5 plus

| Addressee | Additions |
|---|---|
| any | `allow\|erlauben` · `deny\|ablehnen` (resolves the pointed session's pending request; unambiguous single pending → pointing optional) |
| board | `new [<harness>] [<command\|persona>] session [in <project>]: <text>` · `variants <n> [with <harness>[, <harness>…]] [in <project>]: <text>` |

Resolution order: reserved verbs (incl. allow/deny) → command match → **harness qualifier** (closed vocab = configured agents) → project qualifier → text. Nothing may shadow anything earlier in the chain.

## 10. Element picker — unchanged (r2) · ## 11. Voice pipeline — unchanged (r2)

## 12. Sessions, runs & git semantics — as r5, restated harness-free

Spawn: resolve project + harness → worktree + `baseSha` → launch ACP subprocess (`cwd=wt`) → handshake → dispatch. Status: `running` while the turn streams; `awaiting_review` when the turn ends **and** git is dirty/ahead (git is the truth, not the agent's claim). approve/undo via sha ledger; variants winner semantics unchanged; permission requests pause visibly, never silently. Confinement v1 = ACP permission flow + cwd + review gate + reset-to-ref; deeper sandboxing = per-harness config (e.g. an agent's own sandbox modes), v2 topic.

## 13. Board, spatial layout & design language

**Board & layout** — as r5, plus capability badges + permission chips per card; run lanes fed by ACP tool/plan updates for every harness.

**Design language: geist glass (r7).** The brief is Apple's Liquid Glass — translucent, refractive, specular, content-adaptive — executed for *this* subject, with one physical honesty stated up front: **Quest apps cannot sample passthrough** (system-composited, by design), so nothing can blur or refract the actual room. geist glass therefore defines two materials instead of pretending:

- **room-glass** — panel chrome against passthrough: alpha-composited smoke (`smoke-900` @ ~78%), fine noise, specular top edge, 1 px dichroic hairline. No blur claimed. Panel-alpha API probed at M0; fallback = opaque smoke — the design holds in both states.
- **content-glass** — everything *inside* panels (cards, chips, command palette, lanes, permission chips, diff headers) over the board's own backdrop: the full treatment — `backdrop-filter: blur(16–24px) saturate(1.5)`, inner top highlight, gradient hairline stroke; **tier 2** adds real refraction via SVG displacement (`backdrop-filter: url(#lens)` — the console renders in Chromium-lineage WebView, so it works), feature-flagged, auto-disabled on frame-budget breach.

**Tokens** (`geist-console/tokens.css`, shared with the picker overlay): `smoke-900 #0B0D10 · smoke-700 #14171C · ink #F2F4F8 · ink-dim #9AA3AF · spectra-a #6EE7F0 → spectra-b #A78BFA` — the accent is a dichroic *gradient*, an optical effect rather than a flat brand color, used **only** for the target ring, PTT states, and approve confirmation; status hues `ok #7BD88F · warn #F5C066 · danger #F07178`, always glassed. Radii are concentric by rule (outer = inner + gap). Type: **Geist** for UI, **Geist Mono** for selectors, diffs, and logs (both OFL, self-hosted; SF Pro is Apple-platform-licensed and not used — and yes, the typeface named this product's font before we arrived). XR legibility floor: ≥ 17 px effective body at panel distance; any text over glass sits on a scrim meeting AA.

**Signature element** (one; everything around it stays quiet): the **target ring**. The picker's element highlight is a ring of liquid glass that *genuinely* refracts the app's own pixels beneath it — in-page, where refraction is real — with a spectra specular sweep; on PTT press it condenses into the frozen-target lens and persists as the mini-crop chip on the session card. The product's core gesture is where the material lives.

**Motion:** chips morph in (scale + blur-in, spring easing), lanes grow rather than pop, PTT arm = a breathing glass glow; `prefers-reduced-motion` collapses all of it to opacity fades. Kotlin's contribution: matching panel corner radii and alpha; poses and layout unchanged from r5.

## 14. Performance & latency — as r5, plus: ACP handshake + first prompt accepted ≤ 1.5 s per spawn (subprocess start dominated); permission chip round-trip (request → chip visible) ≤ 300 ms. **Glass budgets:** ≤ 6 blurred surfaces live per panel, blur radius ≤ 24 px, tier-2 refraction on ≤ 2 elements simultaneously with auto-degrade on breach — and **H5's 72 Hz gate runs with tier-1 glass ON**: the look lives inside the budget, it is not the thing you switch off to pass.

## 15. Security & privacy — as r5, plus: each agent runs under its **own** vendor auth on the dev machine (geist stores no provider credentials); permission requests are never auto-answered; allow/deny requires an utterance or tap.

## 16. Milestones

**M0 — Spike: panel + ray** — as r4, plus the **panel-alpha probe** (room-glass vs opaque-smoke fallback is decided here, next to the hover-coords question) (**H0** hover evidence; ray×plane fallback in-milestone).
**M1 — Pairing + voice wire** — as r4; the console ships on geist-glass tokens from its first pixel — no "restyle later" debt (**H1** 9/10 transcripts, pairing survives restart).
**M2 — Context pack** — as r4; image delivery asserted where capability on, path-reference asserted always (**H2** chip + crop).

**M3 — ACP loop closes** — `geist-acp` client + mock ACP agent (in-repo, deterministic) + **two real agents: draht (via new `draht-acp` shim) and Claude Code (`claude-agent-acp`)**; permission render + allow/deny (loop can't close without it); sha ledger; launch specs pinned from the registry.
✅ e2e vs mock: dispatch → tool events → edit → turn end + dirty git → `awaiting_review` → approve/undo/stop, permission round-trip · ✅ same fake-headset script green vs draht-acp (CI, keyless via draht faux provider inside the shim's tests) · ✅ `smoke:harness -- claude` (network, non-CI) · **H3:** fr3n button change end-to-end on *both* harnesses; one permission answered by voice.

**M4 — Commands, addressing, project & harness grammar** — ACP-advertised commands/modes → palette + voice where offered, verbatim pass-through always; harness qualifier; project resolution as r5.
✅ e2e: advertised-command golden per mock capability profile; *"new claude session in <fixture>: x"* spawns right harness+path; qualifiers can't shadow verbs/commands · **H4:** spawn draht `/plan` and a Claude session by voice in two projects; disambiguation chips by re-say.

**M5 — Fleet across projects & harnesses** — as r5 + mixed-harness cards, capability badges.
✅ 3 mock sessions (2 capability profiles) across 2 fixture repos, isolation + `fleet_state` goldens, scoped undo · **H5:** fr3n(draht) + kintura(claude) simultaneously, point-routed, 72 Hz with 3 live panels **and tier-1 glass on** (OVR evidence).

**M6 — Variants, optionally mixed** — `variants 3 with claude, codex and draht: …`.
✅ e2e: mixed mock profiles, winner kept, siblings reset+pruned · **H6:** 3-way shoot-out, winner by pointing.

**M7 — Run rendering** — generic tool/plan lanes; `subagent-recognizer.ts` (data-driven, golden-tested); LOOP.md surfacing.
✅ scripted mock tool-call sequences → lane goldens (generic + draht-typed); stop cancels cleanly · **H7:** real draht `/orchestrate` lanes live; a Claude session's tool activity renders as lanes untyped.

**M8 — Spatial dividends (v1.5)** — as r5 (**H8** two-viewport fix; workspace restores after restart).

**v2 backlog:** as r5, minus what ACP absorbed; plus: ACP remote transports when they land (headset → multiple dev boxes) · non-ACP escape hatch only if a must-have agent never adapts.

## 17. Decisions locked on Oskar's behalf (flip-cheap, non-blocking)

1. **§17.1 Home stays the draht monorepo, boundary-enforced:** `check-geist-boundary.mjs` fails root `check` if `geist-core`/`geist-acp`/`geist-console`/`quest` import `@draht/*` (only `draht-acp` may). Extraction to a standalone repo is therefore a `git mv`, any day, no rewrite — the coupling concern is solved in code, not by moving folders today.
2. **v1 agent set:** draht, claude, codex, gemini — registry-pinned at M3; adding one later = a yaml launch spec.
3. **draht stays `harness.default`** — sentiment, not dependency; one word to change.
4. **Steer fallback = cancel + re-prompt** where ACP mid-turn steer isn't offered.
5. **geist-glass starting tokens** (smoke/ink/spectra hexes, §13) — `tokens.css` is one file; retint at will without touching structure.
6. **Glass tiers:** tier-1 (blur + saturate) always on; tier-2 (SVG displacement refraction) flag-gated with auto-degrade; room-glass falls back to opaque smoke if panel alpha disappoints at M0.
7. Carried: variants naming (n=3) · voice=names/paths=picker · active-project default · conservative resolution thresholds · undo = reset-to-ref · caps 4/3/4100 · whisper turbo · demo target fr3n · `quest/` top-level · codename **geist**.

## 18. GSD loop protocol — as r5, reviewer scope updated

Reviewer additionally: boundary check clean · no ACP wire types outside `geist-acp` · recognizer goldens updated with recognizer changes · mock-agent capability profiles cover every capability branch touched in the loop.

## 19. Risks & mitigations

| Risk | L | Mitigation |
|---|---|---|
| ACP churn (v0.13.x cadence) | med | Protocol lib + adapter versions pinned; nightly (non-required) `smoke:harness` matrix; monorepo `check` catches shim drift. |
| Adapter quality variance (claude-agent-acp / codex-acp are external) | med | Capability-gated UX + badges; two-agents-at-M3 rule keeps the port honest; worst case an agent is dropped from the pinned set, not worked around in core. |
| `draht-acp` shim scope creep (re-privileging draht through the back door) | med | Shim implements ACP, nothing more; boundary script + reviewer enforce. |
| Permission fatigue in XR | med | Chips batch per session; agents' own auto-approve modes selectable per session via ACP modes; never auto-answered by geist. |
| Turn-end vs git-truth mismatch (agent "done" but still writing) | low | `awaiting_review` requires turn end **and** quiescent git status (debounced fs-watch). |
| Passthrough can't be sampled → no true room-blur | — | Not a risk but a platform law, stated up front: the two-material system (§13) designs around it so nobody "discovers" it in M5. |
| `backdrop-filter` cost in WebView at 72 Hz | med | Glass budgets (§14), tier auto-degrade, and H5 runs glass-on — regressions gate the milestone, not the ship date. |
| Panel-alpha API friction | med | M0 probe; opaque smoke is a designed state, not a regression. |
| Text-on-glass legibility | low | Scrim rule + AA floor + 17 px minimum, encoded in tokens. |
| Carried from r2–r5 | low–med | Hover-coords M0 gate · name collisions → chips · dev-server load → lazy+caps · Quest FPS → suspension+H5 evidence · secure context → adb reverse · whisper CPU → small flag · Spatial SDK churn → pin · pinch → 400 ms floor. |

## 20. Parity map

| | Orca | t3code | geist v1 |
|---|---|---|---|
| Harness breadth | any CLI via PTY | 3 CLIs via bespoke adapters | **any ACP agent (~50)** via one client |
| Event fidelity | scraped | per-adapter | **protocol-structured** (tools, plans, permissions) |
| Design context | Design Mode (click → HTML/CSS/crop) | — | superset, spatial + voice |
| Compare | worktree fan-out | — | **mixed-harness variants** in a spatial row |
| Surface | desktop + phone | web/desktop | **the room** |
