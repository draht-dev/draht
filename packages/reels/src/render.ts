/**
 * Programmatic Remotion render: bundle once per run, then render each
 * reel's MP4 and poster frame from that bundle.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { REEL_COMPOSITION_ID, type ReelFrameProps } from "./remotion/props.ts";

const ENTRY_POINT = fileURLToPath(new URL("./remotion/index.tsx", import.meta.url));

export interface Bundle {
	/**
	 * Local directory Remotion serves the render from (what `bundle()`
	 * returns, despite the name — not a live HTTP URL). Writing files into it
	 * after bundling, e.g. via {@link publishAudioForRender}, makes them
	 * reachable the same way `public/` assets are: `@remotion/renderer`
	 * serves this directory from disk per render call, not a frozen snapshot.
	 */
	serveUrl: string;
}

export async function createBundle(): Promise<Bundle> {
	const serveUrl = await bundle({ entryPoint: ENTRY_POINT });
	return { serveUrl };
}

/** A safe path component: never a git object id (release/recap ids like `release-v1.2.3` are not shas), only
 * ever used to build a path under the bundle's served directory, never passed to `git`. */
const SAFE_RENDER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeRenderKey(key: string): string {
	if (!SAFE_RENDER_KEY_RE.test(key)) {
		throw new Error(`refusing to use "${key}" as a render key: not a safe filename`);
	}
	return key;
}

/**
 * Headless Chrome cannot load an absolute filesystem path as `<Audio src>`.
 * Copies a render's synthesized narration audio into the running bundle's
 * served directory and returns a root-relative URL (the same shape
 * `staticFile()` produces) that the browser can actually fetch. `renderKey`
 * is a path component, not necessarily a git sha (story drafts use one,
 * release/recap drafts use their `release-<tag>`/`recap-<tag>` id).
 */
export async function publishAudioForRender(
	bundle: Bundle,
	renderKey: string,
	sourceAudioPath: string,
): Promise<string> {
	assertSafeRenderKey(renderKey);
	const relativePath = `audio/${renderKey}.mp3`;
	const destination = join(bundle.serveUrl, relativePath);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(sourceAudioPath, destination);
	return `/${relativePath}`;
}

export interface RenderReelOptions {
	bundle: Bundle;
	props: ReelFrameProps;
	outVideoPath: string;
	outPosterPath: string;
	concurrency?: number | string;
}

export interface RenderReelResult {
	videoPath: string;
	posterPath: string;
	durationInFrames: number;
	fps: number;
}

export async function renderReel(options: RenderReelOptions): Promise<RenderReelResult> {
	const composition = await selectComposition({
		serveUrl: options.bundle.serveUrl,
		id: REEL_COMPOSITION_ID,
		inputProps: options.props,
	});

	await renderMedia({
		composition,
		serveUrl: options.bundle.serveUrl,
		codec: "h264",
		outputLocation: options.outVideoPath,
		inputProps: options.props,
		concurrency: options.concurrency,
	});

	await renderStill({
		composition,
		serveUrl: options.bundle.serveUrl,
		output: options.outPosterPath,
		inputProps: options.props,
		imageFormat: "jpeg",
		frame: Math.min(15, Math.max(0, composition.durationInFrames - 1)),
	});

	return {
		videoPath: options.outVideoPath,
		posterPath: options.outPosterPath,
		durationInFrames: composition.durationInFrames,
		fps: composition.fps,
	};
}
