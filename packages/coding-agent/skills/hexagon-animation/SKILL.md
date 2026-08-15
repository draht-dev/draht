---
name: hexagon-animation
description: Generates a randomized 3D hexagon animation as a single self-contained HTML file - an isometric field of hexagonal prisms pulsing with seeded noise-driven waves, random palette, camera drift, and lighting. Use when the user asks for a hexagon animation, 3D hex grid, hex wave loop, generative background, or a similar abstract animation demo.
---

# Hexagon Animation

Generates a self-contained HTML file (no dependencies, no network) that renders an
isometric field of 3D hexagonal prisms. Heights are driven by seeded 3D value noise
plus a traveling wave; palette, camera rotation, lighting, and motion parameters are
randomized per page load unless pinned.

## Usage

```bash
node generate.mjs                     # writes ./hexagon-animation.html, fully random
node generate.mjs --open              # also opens it in the default browser
node generate.mjs --out demo.html     # custom output path
```

Pin parameters for reproducible output:

```bash
node generate.mjs --seed 12345 --palette 3 --radius 10 --speed 1.5
```

| Option | Meaning |
|--------|---------|
| `--out <file>` | Output path (default `./hexagon-animation.html`) |
| `--seed <n>` | Pin the random seed; omit for a new look on every page load |
| `--palette <n>` | Palette index 0-7 (abyss, magma, acid, synth, royal, ember, mono, teal) |
| `--radius <n>` | Hex grid radius 3-16 (cell count grows quadratically) |
| `--speed <n>` | Motion speed multiplier |
| `--open` | Open the result in the default browser |

## In the browser

- `r` or click: new random seed
- `p`: cycle palette
- `space`: pause
- URL params `?seed=&palette=&radius=&speed=` override everything and are kept in
  sync with the current state, so the URL is always shareable.

## Customizing

For variations beyond the flags (different palettes, bloom, taller prisms, more
octaves), copy `template.html` to the user's project and edit it directly - all
rendering lives in one inline script with the tunables grouped in `buildWorld()`
and the `PALETTES` array. Do not edit the template inside the skill directory.
