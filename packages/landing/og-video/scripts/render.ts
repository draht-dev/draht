#!/usr/bin/env bun
/**
 * Renders the og:video clip for every page in pages.json, plus the site's
 * home clip, and writes the manifest the site's layout reads.
 *
 *   bun run render              # every clip
 *   bun run render home blog    # only these composition ids
 *
 * Clips are muted, looping, 6 s, 1200×630 H.264 MP4s with the moov atom up
 * front, so link-preview crawlers can play them while they download. Pages
 * without a clip fall back to the home clip in the manifest.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import pagesFile from "../pages.json";
import type { PageEntry } from "../src/kit/types";
import { site } from "../src/site";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.resolve(ROOT, site.publicDir);
const VIDEO_DIR = path.join(PUBLIC_DIR, "og/video");
const pages: PageEntry[] = pagesFile.pages;

const clipUrl = (id: string) => `/og/video/${id}.mp4`;
const posterUrl = (id: string) => `/og/video/${id}.jpg`;
/** The frame used as poster: fully built, before the closing slate. */
const POSTER_FRAME = 150;

function writeManifest() {
  const entries = pages
    .filter((page) => existsSync(path.join(VIDEO_DIR, `${page.id}.mp4`)))
    .map((page) => [page.path, clipUrl(page.id)] as const);
  const manifest: Record<string, unknown> = { default: clipUrl("home"), pages: Object.fromEntries(entries) };
  if (site.posters) {
    manifest.defaultPoster = posterUrl("home");
    manifest.posters = Object.fromEntries(
      pages
        .filter((page) => existsSync(path.join(VIDEO_DIR, `${page.id}.jpg`)))
        .map((page) => [page.path, posterUrl(page.id)] as const),
    );
  }
  const manifestPath = path.resolve(ROOT, site.manifest);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[og-video] manifest: ${entries.length} page clips → ${path.relative(process.cwd(), manifestPath)}`);
}

async function main() {
  const allIds = ["home", ...pages.filter((page) => page.path !== "/").map((page) => page.id)];
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const unknown = only.filter((id) => !allIds.includes(id));
  if (unknown.length) throw new Error(`Unknown composition id(s): ${unknown.join(", ")}`);
  const queue = only.length ? only : allIds;

  console.log("[og-video] Bundling compositions…");
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, "src/index.ts"), publicDir: PUBLIC_DIR });

  mkdirSync(VIDEO_DIR, { recursive: true });
  const browser = await openBrowser("chrome");
  let totalBytes = 0;
  try {
    for (const [index, id] of queue.entries()) {
      const output = path.join(VIDEO_DIR, `${id}.mp4`);
      const partial = `${output}.partial.mp4`;
      const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser });
      await renderMedia({
        serveUrl,
        composition,
        puppeteerInstance: browser,
        outputLocation: partial,
        codec: "h264",
        crf: 24,
        x264Preset: "slow",
        pixelFormat: "yuv420p",
        imageFormat: "jpeg",
        jpegQuality: 95,
        muted: true,
        overwrite: true,
        licenseKey: process.env["REMOTION_LICENSE_KEY"] ?? null,
      });
      renameSync(partial, output);
      if (site.posters) {
        await renderStill({ serveUrl, composition, puppeteerInstance: browser, frame: POSTER_FRAME, output: path.join(VIDEO_DIR, `${id}.jpg`), imageFormat: "jpeg", jpegQuality: 90, overwrite: true });
      }
      const bytes = statSync(output).size;
      totalBytes += bytes;
      console.log(`[og-video] ${index + 1}/${queue.length} ${id}.mp4 (${(bytes / 1024).toFixed(0)} KB)`);
    }
  } finally {
    await browser.close({ silent: true });
  }

  if (!only.length) {
    // Full render: drop clips for pages that left the sitemap.
    const keep = new Set(allIds.flatMap((id) => [`${id}.mp4`, `${id}.jpg`]));
    for (const file of readdirSync(VIDEO_DIR)) {
      if (/\.(mp4|jpg)$/.test(file) && !keep.has(file)) {
        rmSync(path.join(VIDEO_DIR, file));
        console.log(`[og-video] removed stale ${file}`);
      }
    }
  }

  writeManifest();
  console.log(`[og-video] Done. ${queue.length} clips, ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);
}

main().catch((error: unknown) => {
  console.error("[og-video] Render failed:", error);
  process.exitCode = 1;
});
