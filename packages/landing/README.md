# @draht/landing

Landing page for [draht.dev](https://draht.dev), built with Astro and deployed via SST.

## Development

```bash
cd packages/landing
bun install
bun run dev      # Start dev server
bun run build    # Build static site
bun run preview  # Preview production build
```

## Deployment

Deployed to AWS (S3 + CloudFront) via SST. See `sst.config.ts`.

⚠️ **Do not run `sst deploy` manually** — deployments are managed via CI/CD.
