# geist — planning index

geist is a Quest 3 mixed-reality client: point at a running app, or at an ACP
(Agent Client Protocol) coding-agent session, and talk to it. It lives inside
this monorepo as a structurally separate product — `geist`, `geist-core`,
`geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console` may import
only non-privileged Geist-family packages, `quest/` imports no `@draht/*`, and
only `packages/draht-acp` may import the Draht kernel. The
2026-07-13 audit found the boundary allowlist does not fully enforce that rule,
so Phase 31 is reopened for a focused correction.

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

- Rev 7 product/design baseline: `.planning/specs/geist-spec.md` (public-facing copy: `docs/geist/spec.md`); release acceptance is qualified by the audit/security amendment notices
- Phase breakdown & acceptance criteria: `.planning/ROADMAP.md` — "Phase 31: Geist Foundation & Repo Scaffold" through "Phase 40: M8 — Spatial Dividends"
- Numbered requirements: `.planning/REQUIREMENTS.md` — "Milestone 4 — geist"
- Reality audit: `.planning/geist/AUDIT-2026-07-13.md`
- Stable security findings: `.planning/geist/SECURITY-2026-07-13.md`

## Current status

A five-agent reality audit on 2026-07-13 found that the prior Milestone 4 completion decision conflated isolated primitives/package tests with production integration. Phases 31–39 are reopened as `pending`; Phase 40 is `pending` and not started. The production `geist` CLI is still a stub, the Quest app has no Meta Spatial SDK integration, the console renders only a wordmark, and the boundary gate has a privileged-shim allowlist loophole.

See [`AUDIT-2026-07-13.md`](./AUDIT-2026-07-13.md) for the phase-by-phase current-vs-target status and new acceptance strategy. Numbered requirements are canonical in `.planning/REQUIREMENTS.md`; stable security blockers are in [`SECURITY-2026-07-13.md`](./SECURITY-2026-07-13.md).

## Evidence debt

All nine H-gates below remain unverified on Oskar's physical Quest 3. They are non-normative summaries of the canonical numbered requirements, and are not substitutes for host, browser, Android, or integration evidence. A phase may close only after its phase-appropriate software acceptance and applicable H-gate both have evidence.

- H0 (Phase 32, M0) — hover-coordinate and panel-alpha evidence on the connected Quest 3; unverified.
- H1 (Phase 33, M1) — 9/10 live transcripts + pairing survives restart, with the real DE/turbo whisper model (only `ggml-base.en.bin` is installed in this sandbox).
- H2 (Phase 34, M2) — chip + crop demo (context-pack dispatch, end-to-end on real hardware).
- H3 (Phase 35, M3) — fr3n button change end-to-end on both draht and Claude harnesses; one permission answered by voice.
- H4 (Phase 36, M4) — spawn a draht `/plan` and a Claude session by voice in two projects; disambiguation by re-say.
- H5 (Phase 37, M5) — fr3n(draht) + kintura(claude) simultaneous, point-routed, 72 Hz with 3 live panels and tier-1 glass on (OVR evidence).
- H6 (Phase 38, M6) — 3-way variants shoot-out, winner picked by pointing.
- H7 (Phase 39, M7) — real draht `/orchestrate` lanes live; a Claude session's tool activity renders as untyped generic lanes.
- H8 (Phase 40, M8) — two-viewport layout fix demoed; workspace pose restores after a headset restart, after implementation and automated recreation/migration tests pass.

All nine require Oskar's physical Quest 3. H3, H4, H5, H6, and H7 additionally require the applicable real-agent adapters and vendor authentication. The headset is now available for development, but none of these gates has recorded evidence yet.
