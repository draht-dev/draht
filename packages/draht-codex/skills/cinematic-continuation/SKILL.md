---
name: cinematic-continuation
description: Use when creating new video sequences from the bundled cinematic style without reanalyzing source footage.
version: 1.0.0
author: Draht
license: MIT
metadata:
  draht:
    tags: [video, continuation, cinematography, continuity, prompting]
---

# Cinematic Continuation

## Overview

Create additional provider-neutral video sequence specifications from an already-distilled cinematic style. The expensive source pass is complete. Use this skill's compact references, template, and deterministic compiler; do not reopen or reanalyze the source film for ordinary continuation work.

Bundled resources, relative to this `SKILL.md`:

- `references/style-bible.md` — distilled visual, edit, acting, physics, and audio grammar
- `references/continuity-schema.md` — canonical provider-neutral continuity state
- `references/seedance-adapter.md` — optional Seedance 2.5 boundary and disclosure
- `templates/continuation-spec.json` — neutral sequence-spec template
- `scripts/compile-continuation.mjs` — offline validator and prompt compiler

## When to Use

- Continue one established shot or action state.
- Add a montage, demonstration, reaction, or emotional beat in the bundled style.
- Produce a time-coded neutral sequence before mapping it to a video provider.
- Resume continuation work in a new session without source-film analysis.

Do not use this skill for an unrelated visual style or when the user explicitly asks to analyze new media.

## Workflow

### 1. Load distilled state only

Read `references/style-bible.md`, `references/continuity-schema.md`, and the template. Do not seek the original MP4, frame corpus, contact sheets, forensic timeline, or private cache.

**Complete when:** the request maps to one documented continuation mode, camera family, and continuity anchor.

### 2. Lock the starting state

Choose one mode: seamless shot, montage beat, emotional continuation, demonstration variant, or clean chapter extension. Record subject appearance without identity claims, wardrobe, props or vehicle, environment, screen direction, camera geometry, action phase, lighting, material residue, emotion, and intentional changes.

**Complete when:** every intended change is named and all other visible state is locked.

### 3. Write a bounded neutral spec

Copy `templates/continuation-spec.json` to the working project. Prefer 5–10 second chunks. Shots must cover the requested duration exactly once with no gap or overlap. Each shot defines subject, one causal action arc, camera, lighting, audio, optional approved dialogue, and transition.

Use portable project-relative paths or user-supplied URLs for references. Never copy local source-analysis paths into a spec.

**Complete when:** all required fields are filled and the timeline is contiguous.

### 4. Preserve physical and emotional causality

Actions follow setup → force/contact → consequence → recovery/hold. Preserve hand ownership and count, rigid-object geometry, gravity, parallax, screen direction, occlusion order, lighting direction, and material history. Expressions evolve through ordered gaze, eyelid, brow, lip/jaw, breath, shoulder, and hand changes rather than face swaps.

Default to clean diegetic footage: no generated text, logo, UI, subtitle, promotional overlay, split-screen border, or watermark. Add approved typography in a controlled editorial pass.

**Complete when:** the sequence passes the acceptance invariants in the continuity schema.

### 5. Compile offline

From the directory containing this `SKILL.md`, run:

```bash
node scripts/compile-continuation.mjs /path/to/sequence.json --output /path/to/compiled.json
```

The compiler validates the complete timeline and emits a `master_prompt` plus optional `provider_adapters`. It performs no network request, upload, generation, or credential lookup.

**Complete when:** the command exits zero and the compiled timeline matches the requested duration.

### 6. Map at the provider boundary

The canonical sequence remains provider-neutral. Treat Seedance 2.5 only as an optional adapter. Before any live request, inspect the selected provider's current official endpoint schema and model list, then map the neutral adapter fields at call time. Do not infer unsupported endpoint fields, limits, authentication, reference syntax, audio behavior, or model IDs.

Keep credentials in protected runtime environment variables. Uploads and credit-spending generation require explicit authorization.

**Complete when:** endpoint assumptions are validated separately from the canonical spec.

## Model and Provider Disclosure

The requested `gpt-5.6-luna` was unavailable during source analysis. Source semantic synthesis used `gpt-5.6-sol` plus local deterministic tools. Never claim Luna execution.

ByteDance has an official Seedance 2.5 product page. That confirms product existence only. The bundled adapter is a replaceable integration boundary, not an official API contract; concrete endpoint fields must be validated at call time.

## Common Pitfalls

1. Reanalyzing source media instead of loading the bundled distilled references.
2. Treating a provider adapter as the canonical schema.
3. Copying machine-specific absolute paths into a portable spec.
4. Seeding from a peak or residue frame when the next action needs an earlier causal phase.
5. Mixing camera/lens families inside one shot.
6. Turning source advertising overlays into story continuity.
7. Inventing dialogue from uncertain visible speech or ASR.
8. Claiming unavailable model execution.

## Verification Checklist

- [ ] No source film, raw frame corpus, contact sheets, or forensic timeline was reopened
- [ ] Mode, anchor, camera family, action phase, and locked state are explicit
- [ ] Shots cover the full duration exactly once
- [ ] Subject, wardrobe, props, screen direction, camera, light, and material history remain coherent
- [ ] Canonical fields are provider-neutral
- [ ] Seedance remains an optional adapter with endpoint assumptions disclosed
- [ ] Compiler exits zero and emits no credential or machine-specific path
- [ ] No generated text, branding, UI, or watermark is requested by default
