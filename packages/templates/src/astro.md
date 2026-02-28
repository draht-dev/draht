# AGENTS.md — Astro

## Stack
- **Framework:** Astro 5.x
- **Runtime:** Node.js 20+
- **Styling:** Tailwind CSS 4.x
- **Package Manager:** npm
- **Deployment:** Static / SSR (adapter-dependent)

## Project Structure
```
├── src/
│   ├── components/        # .astro and framework components
│   ├── layouts/           # Page layouts
│   ├── pages/             # File-based routing (.astro, .md, .mdx)
│   ├── content/           # Content collections (if using)
│   ├── styles/            # Global styles
│   └── utils/             # Shared utilities
├── public/                # Static assets (served as-is)
├── astro.config.mjs       # Astro configuration
├── tailwind.config.mjs    # Tailwind configuration
└── tsconfig.json
```

## Rules

### Astro Components
- Use `.astro` files for static/server components — they ship zero JS by default
- Use framework components (React, Svelte, Vue) only when client interactivity is needed
- Add `client:*` directives explicitly: `client:load`, `client:visible`, `client:idle`
- Prefer `client:visible` over `client:load` for below-the-fold interactive components

### Content Collections
- Define schemas in `src/content/config.ts` using Zod
- Use `getCollection()` and `getEntry()` for type-safe content access
- Markdown/MDX files go in `src/content/<collection>/`

### Routing
- File-based routing in `src/pages/`
- Dynamic routes: `[slug].astro`, `[...slug].astro`
- API routes: `src/pages/api/*.ts` (SSR mode only)

### Styling
- Tailwind CSS as primary styling approach
- Scoped styles in `.astro` files via `<style>` tags
- Global styles in `src/styles/global.css`
- No CSS-in-JS libraries

### TypeScript
- Strict mode enabled
- Use Astro's built-in TypeScript support
- Define Props interface for component props:
  ```astro
  ---
  interface Props {
    title: string;
    description?: string;
  }
  const { title, description } = Astro.props;
  ---
  ```

### Performance
- Astro ships zero JS by default — keep it that way where possible
- Use `<Image />` component from `astro:assets` for optimized images
- Prefer static generation over SSR unless dynamic data is required
- Use `ViewTransitions` for smooth page transitions

### i18n
- Use Astro's built-in i18n routing if multi-language
- Dictionary pattern for translations — no heavy i18n libraries
- Locale files in `src/i18n/` as TypeScript objects

### Testing
- Unit tests with Vitest for utility functions
- Component tests with Astro's testing utilities
- E2E tests with Playwright (if needed)

### Git
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`
- Never commit `dist/`, `.astro/`, or `node_modules/`

### Commands
```bash
npm run dev          # astro dev — local development
npm run build        # astro build — production build
npm run preview      # astro preview — preview production build
npm run check        # astro check + tsc --noEmit
```

## Testing (TDD)
- **Philosophy:** Write tests BEFORE implementation. Red → Green → Refactor.
- **Every task:** Write failing test first, then implement until green, then refactor.
- **No untested code:** If you write to `src/`, there must be a corresponding test.
- **Runner:** vitest
- **Pattern:** `*.test.ts` in `test/` or co-located with source
- **Component testing:** @testing-library for interactive components
- **Coverage:** Target 80% for new code
