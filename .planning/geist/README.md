# geist — planning index

geist is a Quest 3 mixed-reality client: point at a running app, or at an ACP
(Agent Client Protocol) coding-agent session, and talk to it. It lives inside
this monorepo as a structurally separate product — `geist-core`, `geist-acp`,
`geist-console`, and `quest` import zero `@draht/*` packages; only
`packages/draht-acp` is a thin ACP shim over `@draht/coding-agent`, holding
exactly the privileges of any other harness (spec §17.1).

## Milestone → phase map

| Spec milestone | GSD phase | Focus |
|---|---|---|
| — | Phase 31 | Foundation & repo scaffold |
| M0 | Phase 32 | Spike: panel + ray |
| M1 | Phase 33 | Pairing + voice wire |
| M2 | Phase 34 | Context pack |
| M3 | Phase 35 | ACP loop closes |
| M4 | Phase 36 | Commands, addressing, project & harness grammar |
| M5 | Phase 37 | Fleet across projects & harnesses |
| M6 | Phase 38 | Variants, optionally mixed |
| M7 | Phase 39 | Run rendering |
| M8 | Phase 40 | Spatial dividends (v1.5) |

## Pointers

- Full locked spec (rev 7): `.planning/specs/geist-spec.md` (public-facing copy: `docs/geist/spec.md`)
- Phase breakdown & acceptance criteria: `.planning/ROADMAP.md` — "Phase 31: Geist Foundation & Repo Scaffold" through "Phase 40: M8 — Spatial Dividends"
- Numbered requirements: `.planning/REQUIREMENTS.md` — "Milestone 4 — geist"

## Evidence debt

All ten phases (31–40) are `complete` in ROADMAP.md — every automated ✅ criterion is built, tested, and committed. What remains for v1 is exclusively the H-gates below: human/hardware demos on Oskar's physical Quest 3 that no GSD loop can self-certify (spec §16). None of them block a phase's completion; each is logged here as the phase lands.

- H0 (Phase 32, M0) — hover-coords evidence; not achievable in the sandboxed dev environment.
- H1 (Phase 33, M1) — 9/10 live transcripts + pairing survives restart, with the real DE/turbo whisper model (only `ggml-base.en.bin` is installed in this sandbox).
- H2 (Phase 34, M2) — chip + crop demo (context-pack dispatch, end-to-end on real hardware).
- H3 (Phase 35, M3) — fr3n button change end-to-end on both draht and Claude harnesses; one permission answered by voice.
- H4 (Phase 36, M4) — spawn a draht `/plan` and a Claude session by voice in two projects; disambiguation by re-say.
- H5 (Phase 37, M5) — fr3n(draht) + kintura(claude) simultaneous, point-routed, 72 Hz with 3 live panels and tier-1 glass on (OVR evidence).
- H6 (Phase 38, M6) — 3-way variants shoot-out, winner picked by pointing.
- H7 (Phase 39, M7) — real draht `/orchestrate` lanes live; a Claude session's tool activity renders as untyped generic lanes.
- H8 (Phase 40, M8) — two-viewport layout fix demoed; workspace pose restores after a headset restart. M8 is entirely hardware-gated — it has no automated ✅ criterion of its own (spec §2/§16).

All eight require Oskar's physical Quest 3 (and, for H3, real `claude-agent-acp` network credentials); none are achievable in this sandboxed dev environment.
