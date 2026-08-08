# Distilled Style Bible — 67.4 s Seedance 2.5 Promotional Film

## 1. Scope, status language, and source boundary

This bible is distilled only from `timeline-segments.json`, `scenes.json`, `transcript.json`, `AUDIO-ANALYSIS.md`, `ANALYSIS-METHODOLOGY.md`, and the three canonical visual-agent JSON analyses. It covers decoded frames **F0001–F1616**, **0.00–67.37 s**, with **95 gapless semantic intervals** and **31 detected picture shots**. It makes no identity claims.

Use these labels throughout:

- **[E] Evidence:** directly reported by the canonical artifacts.
- **[I] Inference:** a production recommendation generalized from repeated evidence; useful, not source fact.
- **[O] Official fact:** ByteDance's official Seedance 2.5 product page was confirmed by the methodology. No other provider capability, limit, field name, audio behavior, or endpoint behavior is established here as official.
- **[A] Adapter assumption:** the generator-neutral adapter compiles prompt, duration, aspect ratio, resolution, image references, and provider-specific extras, but performs no API call. Concrete provider field names came from an explicitly unofficial SDK reference and require endpoint validation.

Never convert [I] or [A] into a product claim. `gpt-5.6-luna` was unavailable; the visual synthesis was performed with `gpt-5.6-sol` plus local deterministic tools. [E]

## 2. Film structure and approximate timing

| Time | Chapter | Production function |
|---|---|---|
| **0.00–10.40 s** | Wet-freeway mini-narrative | Parallel motorcycle portrait → greeting → forward recenter → near-impact → glitch/title hold → low-lens confrontation/fall → second lens address → white flash. [E] |
| **10.43–22.30 s** | “50 inputs” fashion/music build | White studio wardrobe card → headphone/controller/clapper inputs → pink-room reveal → character lineup → whip-pan into DJ/crowd portrait → eyewear transformation. [E] |
| **22.37–28.20 s** | Video-to-video demonstrations | Toy/model car paired with a green full-size-looking car, then handheld living-room input paired with an in-car output in a clean tutorial layout. [E] |
| **28.23–35.57 s** | Food micro-action | One locked intimate noodle shot: slurp → discomfort → wipe → smaller bite → bowl lift/drink → forearm wipe → exit → empty-dish hold. [E] |
| **35.63–42.70 s** | Kinetic capability montage | Daylight fight → cyan angry phone close-up → night drift car → sunny grocery walk → complete skateboard setup/air/landing/ride-out. [E] |
| **42.77–58.23 s** | Sunset convertible / naturalistic acting | Passenger smile and hand gesture → reverse subject speaking/reaction → frontal two-shot laughter → isolated laugh-to-surprise progression → reverse shocked reaction. [E] |
| **58.27–67.37 s** | Skin/lighting emotional coda | Locked crying portrait → deeper sob → copy swap → gaze lift → face wipe → composure → tearful smile broadening to a grin. [E] |

**Structural rule [I]:** alternate spectacle with legible behavioral proof. Open on immediate motion, use graphics to announce the demonstration, let one or two long causal actions breathe, then close on an emotionally resolved face.

## 3. Shot and edit grammar

- **Hard chapter cuts** separate unrelated worlds; do not morph people or sets across them. Strong examples: F0250/F0251, F0677/F0678, F0854/F0855, F1025/F1026, F1397/F1398. [E]
- **Motivated graphic transitions** grow from physical occlusion or impact: vehicle proximity becomes smear/type at F0055+, and a white flash at F0250 resets the visual field. [E]
- **Within-shot semantic beats** are carried by causal progression, not extra cuts: noodle quantity diminishes; a skateboard compresses, rises, lands, and rolls out; laughter settles before surprise; tears persist through recovery. [E]
- **Reaction cutting** uses gaze-compatible reverse angles and emotional matching rather than continuous geography, especially F1250–F1397. [E]
- **Editorial acceleration** favors short capability samples from ~35.6–42.7 s; **performance proof** favors longer locked takes from ~28.2–35.6 s and ~58.3–67.4 s. [I]
- The 31-shot detector includes several one- or few-frame boundaries around F0185–F0190 and F0856; treat these as detector-level cuts/impact discontinuities, not a mandate for one-frame edits. [E/I]
- Cut on **impact, occlusion peak, completed gesture, gaze change, or emotional reversal**. Avoid arbitrary mid-trajectory cuts. [I]

## 4. Camera, lens, and motion families

1. **Ground-skimming action fisheye:** camera-bike mount, downed road camera, or board-level skate rig; strong edge bowing, foreground scale expansion, vibration, road texture, and directional blur. [E]
2. **Low automotive chase:** rear-three-quarter or side tracking close to the road; coherent wheel spin, yaw, smoke, lane parallax, and reflections. [E]
3. **Locked intimate close-up:** table-height food view or eye-level portrait; shallow depth, stable background, tiny blinks/breathing/hand movements do the work. [E]
4. **Adjacent-seat convertible portrait:** eye-level or slightly low, stable framing with mild vehicle vibration, lateral background flow, warm horizon, and hand proximity blur. [E]
5. **Centered exterior vehicle two-shot:** low frontal view over the hood, controlled windshield reflections, near symmetry, then a very slow lateral emphasis. [E]
6. **Smooth lifestyle track:** chest-height backward tracking with shallow parallax and restrained walking bob. [E]
7. **Graphic/studio lockoff:** frontal, centered, high-key or saturated set; live subject remains stable while input assets translate, scale, flare, or resolve. [E]
8. **Whip-pan/orbit bridge:** one fast, heavily smeared move that resolves onto a sharp foreground face; use sparingly as punctuation. [E]

**Lens rule [I]:** choose one family per shot. Do not mix fisheye edge stretch with telephoto compression, or a locked portrait with unexplained dolly/zoom drift.

## 5. Palette, lighting, and texture

- **Wet freeway:** cool concrete gray, charcoal asphalt, silver traffic, overcast haze, wet reflections; cyan/light-blue and red wardrobe accents; grain, moisture softness, fisheye stretch. [E]
- **White input studio:** shadowless white, hard black props/type, orange-red/yellow/blue wardrobe accents; clean commercial surfaces. [E]
- **Pink fashion room:** saturated fuchsia/hot pink, rectangular white ceiling panels, beige/denim/gray wardrobe, chrome eyewear; uniform frontal light plus magenta ambience. [E]
- **Food:** warm amber/orange food and skin against a dark brown/black background with rectangular bokeh; glossy sauce, ceramic ridges, moist detail, shallow focus. [E]
- **Kinetic montage:** bright hard daylight for fight/skate; cyan high-contrast sweaty phone close-up; blue-black night with red tail lamps and smoke; golden dappled lifestyle daylight. [E]
- **Convertible:** peach/pink sunset, cream/tan leather, dark navy/black trim, warm skin, cool windshield reflections; gentle rim/side light and soft fill. [E]
- **Emotional coda:** warm wood/amber bokeh, cream shirt, tear redness and moisture; progression from soft frontal modeling to stronger golden hair rim and low-key facial exposure. [E]

**Texture rule [I]:** polished commercial realism with selective grain/compression, physically motivated motion softness, readable skin/cloth/metal, and no uniform “AI gloss.” Preserve highlight behavior on tears, sauce, glass, wet pavement, jewelry, and painted vehicles.

## 6. Action physics and causal continuity

- Every action needs **setup → force/contact → consequence → recovery/hold**. The skateboard sequence is the clearest template: crouch F0984–F0992, rise F0993–F1000, contact/compression F1001–F1008, ride-out F1009–F1025. [E]
- Moving vehicles require consistent travel direction, wheel rotation, steering/yaw, smoke or spray origin, background parallax, and camera-relative speed. No wheel slip unrelated to yaw; no drifting livery. [I]
- Freeway scale changes must be monotonic during approach. Cars remain spatial anchors during the fall; do not teleport subjects around them. [E/I]
- Fight motion must preserve distinct bodies, occlusion order, limb count, contact implication, recoil timing, clothing inertia, and balance recovery. Blur follows the strike direction. [E/I]
- Food quantity only decreases. Noodles remain attached from chopsticks to mouth; cheeks, utensil grip, bowl residue, and the bowl's rigid geometry evolve causally. [E]
- Hands enter from an established body, keep five fingers, maintain left/right ownership, contact surfaces without penetration, and reveal the same underlying face after occlusion. [I]
- Hair, loose cloth, jewelry, smoke, tears, and liquid residue lag motion and retain history; they do not reset between beats. [I]

## 7. Naturalistic acting and microexpression rules

- Build expressions through **small ordered muscle changes**, not a single face swap: gaze locks → brows lift → eyelids widen → lips part → jaw lowers → shoulders/hands join. The passenger surprise at F1289–F1336 is the model. [E]
- Let laughter decay before listening or surprise: tooth display reduces, mouth closes, eyes reopen, gaze steadies, then a new reaction begins. [E]
- Conversation combines mouth articulation with eyebrow beats, head tilt, gaze toward an off-screen partner/road, and restrained hand pulses. Do not animate the mouth in isolation. [E/I]
- Shock can be broad but must remain anatomically stable: consistent teeth, jaw hinge, pupils, blink behavior, and head orientation. Add tiny modulation during a held pose. [E/I]
- Crying preserves emotional residue: reddened cheeks, existing tear paths, damp temple strands, pressed/quivering lips, shallow head dips, interrupted breathing. Recovery does not erase tears. [E]
- The crying-to-smile arc must pass through composure: gaze/chin lift → wipe → hand clears → lips relax → eyes reopen → mouth corners rise → cheeks lift → restrained tooth display. [E]
- Avoid beauty retouching that removes pores, moisture, asymmetry, under-eye tension, or transient redness. [I]
- Visible mouth motion is not evidence of exact words. Never infer dialogue from expression alone. [E]

## 8. Character, wardrobe, prop, and vehicle continuity states

All labels below are production handles, not identities.

| Handle | Locked visible state | Allowed evolution |
|---|---|---|
| **Rider-A / Freeway** | Long dark hair; glasses/red-framed appearance in close views; light-blue/cyan sleeveless top; red shorts; dark knee-high boots; black sport motorcycle. [E] | Hair wind, greeting hand rises/lowers, dismount/approach. Do not alter wardrobe, glasses, motorcycle color/geometry, or traffic direction. |
| **Road-Man-B** | Stocky older-presenting adult; dark overcoat, brimmed hat, dark sunglasses, gold chain. [E] | Approach, lens reach, face articulation, backward fall, ground writhing. Keep accessories through blur/fall. |
| **DJ-C** | Dark hair tied back; orange-red sleeveless top, layered yellow/blue short bottoms, red leg warmers/boots, pendant; later headphones, controller, and red neck detail. [E] | Input props become worn/usable; white room becomes pink; crowd joins. Preserve established garments across the transformation. |
| **Pink-Lineup** | Beige-clad dark-haired figure; pale blond figure in gray; dark-skinned figure in denim; dark-haired gray/patterned-trouser figure; colorful-top entrant. [E] | Layered entrances and fashion poses only; keep each track, screen order, scale, and wardrobe distinct. |
| **Food-D** | Long straight dark hair; light teal sleeveless top; chopsticks; off-white ribbed bowl with sauced noodles. [E] | Food decreases, tissue appears, bowl lifts, face reappears, subject exits. Plate/chopsticks/residue then remain fixed. |
| **Fight Group** | White-shirt/dark-trouser fighter; nearer dark-blue-suited figure; additional dark-suited figure. [E] | Grapple, reveal, kick/recoil. Never merge the two suited figures or swap wardrobe. |
| **Phone-E** | Short spiked/light-brown hair; white sleeveless tank; dark phone held to left ear; cyan interior. [E] | Angry mouth/eyebrow/head/hand beats; phone-ear contact remains continuous. |
| **Drift Car** | White modified coupe; large rear wing, wide wheels, red tail lamps, red/black side graphics. [E] | Rear-three-quarter drift becomes side reveal. Body kit, livery, wheels, and light shapes stay fixed. |
| **Walker-F** | Long voluminous dark curls; bright yellow strapless top; brown paper grocery bag with baguette and green/red produce; smartphone. [E] | Walk/scroll and natural bob only; preserve bag contents and phone-hand relationship. |
| **Skater-G** | Vivid pink long-sleeve top, loose black pants, dark shoes, one skateboard. [E] | Crouch, ollie-like arc, landing, ride-out; foot placement and board geometry remain stable. |
| **Convertible Passenger-H** | Long wavy/loose dark hair; dark sleeveless top; jewelry/bracelets; small snack in early close-up; cream/beige headrest. [E] | Knowing smile/gesture, later laughter, listening, surprise, hands-up reaction. Keep gaze toward driver/camera-left and consistent seat side. |
| **Convertible Occupant-I** | Medium-brown skin; very short/close-cropped hair; muscular arms; white sleeveless tank; tan/cream seat and dark windshield geometry. [E] | Recline → speech gestures → attention → astonishment → reach. Keep eye line toward companion and car geometry. |
| **Portrait-J** | Dark hair loosely tied back with damp temple strands; light cream crew-neck shirt; warm wooden-shelf background. [E] | Contained tears → sob → gaze lift → wipe → composure → smile. Tear history and hair state persist. |

The convertible analyses cautiously allow “a different convertible or a different seat/angle” at F1090; do not assert a single exact vehicle across every close-up. The frontal two-shot at F1180 establishes a dark blue/black vintage-style convertible with cream interior. [E]

## 9. Audio, dialogue, and ASR uncertainty

- Source audio is AAC, 44.1 kHz stereo, measured **−7.7 LUFS integrated** with **9.2 LU** loudness range: a loud, compressed social-video mix with sharp contrasts. [E]
- Contour: transient-led setup to ~11 s; dense broadband montage ~11–39 s; reduced upper-frequency density and amplitude ~39–50 s for dialogue/reaction room; pulsed rise ~50–58 s; loud plateaus and abrupt gaps ~58–64 s; short decay to 67.4 s. Boundaries are approximate. [E]
- Use sparse dialogue as an accent. Leave headroom around key lines and align reaction cuts to emotional meaning, not forced mouth movement. [I]
- Whisper detected English at ~0.90 language probability and only 19 word tokens, mostly ~28.76–53.67 s. Preserve raw ASR; do not silently “correct” it. [E]
- Raw uncertain phrases: “I beg no idea what you just did Ken” (28.76–32.58), “Strike those” (38.22–38.86), “We're doing good, we're doing pristine” (38.86–40.64), and “It's funny” (43.24–53.67). The last has an implausible ~9.6 s word gap; “funny” probability is ~0.407. “Strike” is ~0.038; early words and “Ken” are also low confidence. [E]
- Food, car, walking, and some convertible overlaps do not support reliable visible lip-sync; treat them as uncertain voice-over or unrelated audio. The phone subject visibly speaks, but exact wording is unconfirmed. [E]
- **Prompt rule:** request ambience, score contour, and concrete SFX first; request spoken words only when a script is supplied independently. Do not claim this bible establishes whether any specific Seedance endpoint generates synchronized audio. [I/O boundary]

## 10. Overlay, typography, and branding handling

- The source visibly contains promotional/title packages including “SEEDANCE 2.5,” “50 INPUTS,” “VIDEO2VIDEO,” “INPUT/OUTPUT,” “UP TO 30 SECONDS,” “LIMITED OFFER,” “CINEMATIC CAMERA MOVEMENTS,” “NATURALISTIC ACTING,” “NEXT-LEVEL SKIN SHADING & LIGHTING,” and Higgsfield/offer copy. [E]
- **Default for generated story footage:** exclude all marketing overlays, logos, watermarks, UI, subtitles, progress bars, product names, offer copy, and tiny legal text. They belong to the source's advertisement layer, not its diegetic worlds. [I]
- Generate typography as a separate editorial pass whenever possible. Text-to-video is not the continuity authority for exact spelling or stable lockups. [I]
- If reproducing a demo layout, lock panel geometry and gutters; render labels/branding downstream from approved vector assets. Never fabricate or approximate a third-party wordmark. [I]
- If an overlay is explicitly required inside generation, specify exact text, capitalization, screen coordinates, entry frame, hold duration, and exit behavior; reject letter morphing/flicker. This is an adapter request, not an official provider guarantee. [A]

## 11. Continuation modes

1. **Same-shot physical continuation:** start from a late clean frame; preserve camera/lens, spatial anchors, velocity, hand ownership, wardrobe, residue, and lighting. Add only the next causal beat. Best for riding, eating, skating, gestures, wipes, and emotional transitions. [I]
2. **Reaction reverse:** cut cleanly to the established partner's angle while matching eye line, time of day, vehicle/set state, and emotional timing. Do not morph faces or swap seat sides. [I]
3. **Chapter extension:** retain one camera/palette/texture family but introduce non-identical subjects and a new action. Use a hard cut or motivated occlusion; no unsupported identity continuity. [I]
4. **Capability-demo variant:** preserve the source/output logic, fixed panel positions, and causal motion correspondence, but replace source objects and actions. Add all labels later. [I]
5. **Emotional hold-and-resolve:** continue microexpression and tear/sweat/food history in a locked portrait; prefer a 2–4 beat arc over a sudden emotional flip. [I]
6. **Graphic bridge:** use impact, hand/bowl occlusion, whip blur, flare, or full-field color as the transition substrate; composite final typography separately. [I]

For any mode, define a **locked state ledger** before generation: subject handle, wardrobe, props, vehicle/set geometry, screen side, gaze target, action phase, residue/deformation state, camera family, light direction, and prohibited changes.

## 12. Exact prompt building blocks

Copy these verbatim and replace bracketed fields only.

**Core visual block**

> Polished cinematic social-film realism, [PALETTE FAMILY], physically accurate materials and skin, restrained fine grain, selective motion blur only where caused by movement, no synthetic gloss. [CAMERA FAMILY] with [LENS/PERSPECTIVE], [CAMERA MOTION]. Lighting remains [LIGHT DIRECTION AND QUALITY] for the entire shot.

**Continuity block**

> Begin from reference frame F[NUMBER]. Preserve [SUBJECT HANDLE]'s visible facial geometry without identity claims, [WARDROBE], [PROP/VEHICLE], [SCREEN SIDE], [GAZE TARGET], and [SET ANCHORS]. Continue from action phase [PHASE] into [NEXT PHASE] with no reset, teleport, costume change, side swap, or background rebuild.

**Physics block**

> Animate a causal sequence: setup [A], force/contact [B], consequence [C], recovery/hold [D]. Maintain gravity, inertia, contact, limb count, hand ownership, rigid-object geometry, material lag, coherent parallax, and persistent residue throughout.

**Naturalistic acting block**

> Performance is naturalistic and temporally layered: first [GAZE CHANGE], then [BROW/EYELID CHANGE], then [LIP/JAW CHANGE], followed by [BREATH/SHOULDER/HAND RESPONSE]. Preserve asymmetry, blinks, skin texture, moisture history, and tiny post-expression modulation; never replace the face with a new expression mask.

**Action-fisheye block**

> Very low ground-skimming action camera, pronounced but stable fisheye edge curvature, close foreground scale expansion, coherent road/building parallax, camera vibration tied to surface motion, directional blur tied to velocity; central subject geometry stays readable.

**Locked portrait block**

> Locked eye-level close-up, shallow depth of field, stable background bokeh and exposure, no dolly or digital zoom. Emotion changes through tiny gaze, eyelid, brow, lip, cheek, breath, and head movements while hair strands, tears, and highlights remain temporally continuous.

**Clean-output block**

> Diegetic story image only. No text, captions, logos, wordmarks, watermark, interface, progress indicator, promotional copy, split-screen border, or branding. Leave clean negative space only if a later editorial overlay is planned.

**Audio direction block (generator-neutral)**

> Audio direction: [AMBIENCE], [SPECIFIC PHYSICAL SFX], and [MUSIC ENERGY CURVE]. Keep dialogue sparse. No intelligible speech unless the supplied script is: “[EXACT APPROVED LINE].” Do not infer words from visible mouth movement.

**Adapter request block [A]**

> Requested output intent: duration [DURATION], aspect ratio [RATIO], resolution [RESOLUTION], reference images [FRAME FILES], plus explicitly documented provider extras only. Validate actual endpoint field names and capability support before submission.

## 13. Negative constraints

Apply as one consolidated block:

> No identity claims; no face drift, age drift, body merge, duplicate person, extra limb, extra finger, fused fingers, hand-face penetration, detached hand, rubber jaw, unstable teeth, wandering pupils, frozen blink, hair reset, tear reset, food reset, changing residue, prop morph, elastic bowl, warped phone, floating skateboard, foot-through-deck, impossible gravity, missing landing, wheel/body mismatch, livery drift, smoke from nowhere, incoherent steering, vehicle teleport, traffic discontinuity, seat-side swap, changing windshield or headrest, moving horizon, inconsistent reflections, random camera move, mixed lens grammar, arbitrary zoom, non-directional motion smear, texture swimming, over-smoothed skin, beauty-filter tears, flickering exposure, time-of-day shift, unmotivated morph, accidental split screen, text, logo, watermark, subtitles, UI, promotional overlay, misspelled branding, or fabricated dialogue.

## 14. Reference-frame recommendations

Use original extracted stills corresponding to these frame numbers; the recommendation concerns their distilled visual state, not reopening contact sheets.

| Purpose | Recommended frame(s) | Why / caution |
|---|---|---|
| Freeway rider continuity | **F0017, F0032** | Greeting onset/end with wardrobe, bike, lane side, wet-light state. Use F0041 separately for forward POV; do not blend side and forward rigs. [E/I] |
| Near-impact / graphic bridge | **F0054, F0058** | Last readable sedan scale and first smear/type takeover. Use only for transition studies; exclude title for clean story generation. [E/I] |
| White-studio DJ state | **F0251, F0321** | Full wardrobe card and established hands-on-controller state. [E/I] |
| Pink-room ensemble | **F0356, F0449, F0485** | DJ room, completed lineup, and resolved post-whip crowd portrait. Keep each as a distinct continuity state. [E/I] |
| Video-to-video geometry | **F0553, F0611** | Toy/vehicle correspondence and clean two-panel layout onset. Rebuild text downstream. [E/I] |
| Food causal action | **F0678, F0776, F0822, F0834, F0849** | Initial food volume, discomfort, bowl lift, face re-reveal, empty-dish end state. Do not use a later frame to seed an earlier food amount. [E/I] |
| Fight and phone | **F0855, F0879, F0896** | Two-person start, third-person depth reveal, stable phone-to-left-ear close-up. [E/I] |
| Automotive and street camera families | **F0929, F0945, F0957** | Rear drift, side-livery reveal, and smooth lifestyle track. Keep night/day looks separate. [E/I] |
| Skate physics | **F0984, F0993, F1001, F1009** | Setup, airborne, landing compression, ride-out. Use sequentially, not as interchangeable poses. [E/I] |
| Convertible portrait and two-shot | **F1026, F1090, F1180, F1250** | Passenger close-up, other occupant angle, exterior seating map, and laughter close-up. F1180 is the strongest seating/vehicle anchor. [E/I] |
| Surprise reaction | **F1289, F1297, F1313, F1349** | Neutral/listening baseline, onset, hands-up peak, reverse reaction. Avoid seeding the peak if gradual escalation is required. [E/I] |
| Cry-to-smile coda | **F1398, F1433, F1513, F1543, F1566, F1585, F1616** | Containment, deeper sob, gaze lift, wipe occlusion, revealed composure, smile onset, broad final grin. Crop or remove promotional text in a separate preprocessing/editorial step if authorized; do not ask generation to imitate it. [E/I] |

## 15. Three new sequence concepts

### A. Rain receipt chase — kinetic chapter extension
A standalone bicycle courier under a wet concrete overpass notices a paper receipt pulled from a delivery bag by crosswind. A ground-skimming fisheye tracks the receipt skittering between puddles; the courier brakes, plants one foot, and pins it with a gloved hand before it reaches traffic. End on a breath and small relieved look. New action, new subject, no motorcycle collision or greeting. Use cool freeway palette, wet reflections, causal wheel/brake/body physics, and no branding. [I]

### B. Laundromat button rescue — micro-action proof
Locked table-height close-up in a warm late-night laundromat: an unnamed person threads a loose shirt button with trembling fingers while machines rotate softly out of focus. The thread misses, catches, pulls through, knots, and the shoulders release; a tiny embarrassed smile follows. This echoes the source's patient food/portrait causality without copying eating, wiping, crying, or existing gestures. Emphasize hand topology, rigid button holes, thread tension, fabric deformation, sodium/amber practicals, and sparse room tone. [I]

### C. Dusk gas-station reconciliation — naturalistic reaction extension
At a quiet gas station beside the parked dark vintage-style convertible, two unnamed occupants stand on opposite sides of the hood. One slides a forgotten snack across the hood; the other watches it arrive, suppresses a laugh, then gives a small nod. Cut to a clean reverse close-up where tension leaves the jaw and eyes before the smile appears. Preserve cream interior glimpses, peach dusk, dark paint reflections, eye-line logic, and emotional asymmetry. This extends the convertible's tonal world but introduces a new action rather than repeating laughter-to-shock. [I]

## 16. Production checklist and provider boundary

Before generating, confirm:

- One continuation mode, one camera family, one action phase, and one locked-state ledger are specified.
- Reference frames are ordered by causal state; no later residue/emotion seeds an earlier beat.
- Wardrobe, props, vehicle/set anchors, eye line, screen side, light direction, and material history are explicit.
- Story footage requests the clean-output block; approved typography and branding are handled editorially.
- Dialogue is either omitted or supplied as exact approved copy; raw ASR is never treated as a script.
- “Seedance 2.5” is used only as the confirmed official product name/page fact. Duration, ratio, resolution, image-reference syntax, audio behavior, endpoint names, limits, and extras remain adapter/integration questions until verified against the real provider endpoint. [O/A]
- Final review checks physical causality frame by frame, expression order, hand/teeth continuity, vehicle geometry, text absence, and hard-cut cleanliness.
