/**
 * Test-only `TtsProvider` that uses a committed real MP3 fixture
 * (`tone.mp3`, a short sine tone rendered once with the ffmpeg binary
 * `@remotion/compositor-*` ships — see repo history for the generating
 * command) instead of calling ElevenLabs. Lets integration proof render a
 * reel with real, playable audio without network access or an API key.
 */

import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { concatenateMp3, type TtsProvider } from "../../src/tts.ts";

const FIXTURE_MP3 = fileURLToPath(new URL("./tone.mp3", import.meta.url));
const FIXTURE_DURATION_MS = 500;

export const fixtureTtsProvider: TtsProvider = {
	async synthesize(scenes, outDir) {
		const audioPaths: string[] = [];
		const transcript = scenes.map((scene, sceneIndex) => {
			const audioPath = join(outDir, `scene-${sceneIndex}.mp3`);
			audioPaths.push(audioPath);
			return {
				sceneIndex,
				text: scene.narration,
				startMs: sceneIndex * FIXTURE_DURATION_MS,
				endMs: (sceneIndex + 1) * FIXTURE_DURATION_MS,
			};
		});

		await Promise.all(audioPaths.map((dest) => copyFile(FIXTURE_MP3, dest)));
		const audioPath =
			audioPaths.length > 0 ? await concatenateMp3(audioPaths, join(outDir, "narration.mp3")) : undefined;

		return {
			scenes: audioPaths.map((p) => ({ audioPath: p, durationMs: FIXTURE_DURATION_MS })),
			transcript,
			audioPath,
		};
	},
};

export function fixtureMp3Path(): string {
	return FIXTURE_MP3;
}

export function fixtureFixturesDir(): string {
	return dirname(FIXTURE_MP3);
}
