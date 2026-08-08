# Continuity schema

Use this compact schema in new sessions; it replaces source-video reanalysis.

## Canonical state dimensions

| Dimension | Required state |
|---|---|
| Narrative mode | seamless shot, montage beat, or emotional close-up |
| Subject | appearance-only description; no inferred identity |
| Wardrobe | garment type, color, fit, accessories, footwear |
| Props/vehicle | silhouette, paint, material, control/contact points |
| Environment | place class, weather, surfaces, traffic/background topology |
| Screen direction | subject and background travel direction |
| Camera geometry | mount/viewpoint, side/height, subject distance, lens feel |
| Camera motion | tracking velocity, pan/tilt/orbit, vibration, framing drift |
| Physical action | initial pose, causal action arc, end pose, occlusion order |
| Lighting | time of day, source direction, key/fill ratio, practicals/rim |
| Look | palette, contrast, grain, motion blur, depth of field |
| Emotion | initial microexpression, transition stages, resolved expression |
| Audio | ambience, score contour, transient accents, sparse dialogue |
| Transition | hard cut, whip-pan, impact/glitch, match action, or no cut |
| Exclusions | drift, mutation, impossible physics, unwanted text/branding |

## Shot-family anchors

### A. Wet freeway action

- Subject: long dark hair, glasses, light-blue sleeveless top, red shorts, dark knee-high boots; black sport motorcycle.
- Camera: very low wide/fisheye action camera on a parallel motorcycle; camera-bike fairing visible at frame bottom.
- Environment: wet multilane freeway, gray overpass, cool overcast light, silver traffic.
- Motion: matched side-by-side velocity; hair/wet-road parallax; plausible one-hand greeting followed by camera yaw and closing distance.
- Suggested references: F0001 establishing geometry, F0024 greeting pose, F0048 forward traffic POV.

### B. Ground-level action/reaction

- Camera near pavement, strong wide-angle expansion and body/hand foreshortening.
- Cars/buildings remain fixed spatial anchors while bodies approach, fall, jump, or ride through.
- The action must complete a causal setup → peak → landing/recovery arc.

### C. Sunset convertible reaction montage

- Deep navy/black open convertible, cream/tan leather, peach sunset horizon, dark windshield diagonals and occasional cyan reflection.
- Shot/reverse-shot alternates intimate passenger/driver close-ups and a low frontal two-shot.
- Emotional progression is gradual within each take: laughter → attentive neutrality → realization → widened eyes/open jaw → hands-up alarm; reverse cut carries the same emotional beat.
- Suggested references: F1026 passenger smile, F1180 frontal two-shot, F1250 laughter, F1313 hands-up shock, F1349 reverse reaction.

### D. Tearful indoor portrait

- Centered eye-level head-and-shoulders close-up; cream shirt; loosely tied dark hair with damp flyaways; warm wooden-shelf bokeh.
- Warm frontal key evolves toward stronger golden rim/chiaroscuro while exposure stays low and readable.
- Emotional sequence: contained tears → deeper sob → upward gaze → face wipe with correct occlusion → composure → broad smile while tear history remains visible.
- Suggested references: F1398 initial tearful state, F1480 deep sob, F1548 hand occlusion, F1585 first smile, F1616 resolved smile.

## Montage rules

- Use 1–3 second shots for most beats; permit longer micro-action or acting shots when the performance evolves continuously.
- Cut on a new consequence, reaction, transformation, or emotional escalation—not randomly.
- Preserve action → reaction → emotional resolution across location changes.
- Promotional layouts and readable branding are source evidence, not default diegetic content. Exclude all text/logos/watermarks unless the user explicitly requests a branded promo.

## Reference use

For seamless continuation, use an already-exported selected anchor frame as an image reference. For montage continuation, use at most one or two references per shot family; do not mix incompatible wardrobe/location anchors into a single shot. The raw frame store is intentionally not bundled; ordinary sessions should use only user-supplied named anchors rather than scanning or reanalyzing source media.

## Acceptance invariants

- Same subject description before/after occlusion
- Same side of vehicle/road and same screen direction
- Same number and ownership of hands/limbs/props
- Rigid vehicle/board/bowl geometry
- Causal object contact and gravity
- Stable light direction and horizon
- No text or branding unless intentional
- Dialogue timing does not override visible evidence when ASR confidence is low
