# og-video

Motion cards rendered with [Remotion](https://www.remotion.dev) into an
`og:video` clip for every public page of this site.

- `src/site.ts`: origin, sitemaps, section labels, brand colours and fonts
- `src/cards.tsx`: the home clip and the per-page card
- `src/kit/`: shared motion primitives (text wrapping, reveals, the looping slate)
- `pages.json`: pages with their own clip (written by `collect`)

```sh
cd og-video
bun install
bun run collect          # sitemap → pages.json (add --origin=http://localhost:4321 for a local preview)
bun run render           # pages.json → public/og/video/*.mp4 + the layout's manifest
bun run render home      # re-render specific composition ids
bun run studio           # preview and tweak the cards in Remotion Studio
```

Re-run `collect` and `render` after adding pages or changing titles. The site
layout reads the manifest. Pages without their own clip (legal pages, pages
behind sign-in, per-user pages) fall back to the home clip, so every page
carries an `og:video`.

Clips are 6 s, 1200×630, muted H.264 with faststart. A brand slate opens and
closes each clip so it loops without a seam.

On NixOS, Remotion's bundled Chrome needs nss, nspr, expat, libstdc++ and
zlib (and a few X/GL libraries) on `LD_LIBRARY_PATH`.

Remotion is free for individuals and companies with up to three people.
Larger companies need a [company licence](https://www.remotion.pro); set
`REMOTION_LICENSE_KEY` and the render script passes it through.
