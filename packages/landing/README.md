# @draht/landing

Landing page for [draht.dev](https://draht.dev), built with Astro and deployed via SST.

## Development

[Bun](https://bun.sh) is recommended but any package manager works (npm, pnpm, etc.).

```bash
cd packages/landing
bun install
bun run dev      # Start dev server
bun run build    # Build static site
bun run preview  # Preview production build
```

## Deployment target

The internal site is configured for AWS (S3 + CloudFront) through SST; see
`sst.config.ts`. Source configuration is not evidence that a production site is
active. Deployment ownership and active-state evidence are tracked through the
[product support map](../../.planning/PRODUCT-MAP.md).

Do not run `sst deploy` manually. CI/CD manages deployments.
