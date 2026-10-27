#!/usr/bin/env bun
/**
 * Builds pages.json: every public page that gets its own og:video clip, with
 * the title and description its own <head> already declares.
 *
 *   bun run collect                                 # from production
 *   bun run collect --origin=http://localhost:4321  # from a local preview
 *
 * Pages come from the site's sitemap(s) plus `extraPaths` in src/site.ts.
 * Pages matched by `exclude` keep the site's default clip. An optional
 * scripts/enrich.ts can attach extra per-page data (read from the site's own
 * content files) as `page.data`.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PageEntry } from "../src/kit/types";
import { site } from "../src/site";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originArg = process.argv.find((arg) => arg.startsWith("--origin="))?.slice("--origin=".length);
const origin = (originArg ?? site.origin).replace(/\/$/, "");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·" };

function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(pathname: string): string {
  const trimmed = pathname.replace(/\/index\.html$/, "").replace(/\.html$/, "").replace(/\/+$/, "");
  return trimmed || "/";
}

function meta(html: string, key: string): string | undefined {
  // Attribute order and quote style vary between sites. Match the closing
  // quote to the opening one so an apostrophe inside "..." survives.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = `(?:"([^"]*)"|'([^']*)')`;
  const nameFirst = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*?content=${value}`, "i").exec(html);
  const contentFirst = new RegExp(`<meta[^>]+?content=${value}[^>]*(?:property|name)=["']${escaped}["']`, "i").exec(html);
  const match = nameFirst ?? contentFirst;
  const raw = match?.[1] ?? match?.[2];
  return raw ? decode(raw) : undefined;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": "og-video-collector" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

async function sitemapPaths(url: string): Promise<string[]> {
  const xml = await fetchText(url.startsWith("http") ? url : `${origin}${url}`);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => decode(match[1]));
  if (/<sitemapindex/i.test(xml)) {
    const nested = await Promise.all(locs.map((loc) => sitemapPaths(new URL(new URL(loc).pathname, origin).toString())));
    return nested.flat();
  }
  return locs.map((loc) => normalise(new URL(loc).pathname));
}

function idFor(pagePath: string): string {
  return pagePath === "/" ? "home" : pagePath.slice(1).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

type Enrich = (page: PageEntry) => PageEntry["data"] | Promise<PageEntry["data"]>;

async function main() {
  const enrichPath = path.join(ROOT, "scripts/enrich.ts");
  const enrich: Enrich | undefined = existsSync(enrichPath) ? (await import(enrichPath)).enrich : undefined;

  const fromSitemaps = (await Promise.all(site.sitemaps.map(sitemapPaths))).flat();
  const paths = [...new Set([...fromSitemaps, ...(site.extraPaths ?? []).map(normalise)])]
    .filter((pagePath) => !(site.exclude ?? []).some((pattern) => pattern.test(pagePath)))
    .sort();

  const pages: PageEntry[] = [];
  const queue = [...paths];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let pagePath = queue.shift(); pagePath; pagePath = queue.shift()) {
        try {
          const html = await fetchText(`${origin}${pagePath === "/" ? "/" : pagePath}`);
          const rawTitle = meta(html, "og:title") ?? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "");
          const lang = (/<html[^>]*\slang=["']([a-z]{2})/i.exec(html)?.[1] ?? "en").toLowerCase();
          pages.push({
            id: idFor(pagePath),
            path: pagePath,
            section: site.section(pagePath, lang),
            title: site.cleanTitle ? site.cleanTitle(rawTitle) : rawTitle,
            description: meta(html, "og:description") ?? meta(html, "description") ?? "",
            lang,
            image: meta(html, "og:image"),
          });
        } catch (error) {
          console.warn(`[og-video] skip ${pagePath}: ${(error as Error).message}`);
        }
      }
    }),
  );

  pages.sort((a, b) => a.path.localeCompare(b.path));
  if (enrich) {
    for (const page of pages) page.data = (await enrich(page)) ?? undefined;
  }
  const ids = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id)) throw new Error(`Duplicate clip id ${page.id} (${page.path})`);
    ids.add(page.id);
  }

  writeFileSync(path.join(ROOT, "pages.json"), `${JSON.stringify({ pages }, null, 2)}\n`);
  console.log(`[og-video] ${pages.length} pages → pages.json`);
}

main().catch((error: unknown) => {
  console.error("[og-video] Collect failed:", error);
  process.exitCode = 1;
});
