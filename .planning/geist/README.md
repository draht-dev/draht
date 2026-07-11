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

- H0 — hover-coords evidence, requires Oskar's physical Quest 3 running this build; not achievable in the sandboxed dev environment.
- H1 — 9/10 live transcripts + pairing survives restart, requires Oskar's physical Quest 3 running this build with the real DE/turbo whisper model; not achievable in the sandboxed dev environment (only ggml-base.en.bin is installed here).
