/** One public page that gets its own og:video clip. Written by scripts/collect.ts. */
export interface PageEntry {
  /** Remotion composition id, also the clip's file stem. */
  id: string;
  /** Normalised URL path: leading slash, no trailing slash ("/" for home). */
  path: string;
  /** Short uppercase label for the page's area of the site, e.g. "BLOG". */
  section: string;
  title: string;
  description: string;
  /** Page language from <html lang>, e.g. "en" or "de". */
  lang: string;
  /** The page's own og:image (absolute URL), if it declares one. */
  image?: string;
  /** Extra per-page data from the site's optional scripts/enrich.ts. */
  data?: Record<string, string | string[] | undefined>;
}

export interface FontSpec {
  family: string;
  url: string;
  weight: string;
  style?: "normal" | "italic";
}

export interface SiteConfig {
  /** Production origin, e.g. "https://draht.dev". */
  origin: string;
  /** Sitemap URLs (absolute or origin-relative). Sitemap indexes are followed. */
  sitemaps: string[];
  /** Public pages missing from the sitemap. */
  extraPaths?: string[];
  /** Paths that keep the site's default clip instead of their own. */
  exclude?: RegExp[];
  /** Remove brand suffixes like " — draht" from page titles. */
  cleanTitle?: (title: string) => string;
  /** Label for a page's section of the site. */
  section: (path: string, lang: string) => string;
  /** Site's static asset dir, relative to the og-video dir. Clips go in <publicDir>/og/video. */
  publicDir: string;
  /** Path (relative to the og-video dir) of the JSON manifest the site's layout imports. */
  manifest: string;
  /**
   * Also write a JPEG poster (the settled card) next to each clip, for sites
   * that have no og:image of their own. The manifest then lists them too.
   */
  posters?: boolean;
}
