import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * whisper.cpp voice wiring (spec §6 ASR row: "whisper.cpp turbo/small"; §7's
 * `whisper.cpp (DE/EN)` sibling box under the geist bridge; §16 M1).
 *
 * Spawns the `whisper-cli` binary directly via `node:child_process` — no npm
 * dependency — and reads back the JSON result file it writes via `--output-json`.
 *
 * DE transcription and the turbo/small models are not available in this sandbox
 * (only ggml-base.en.bin is installed) — this wiring is model-agnostic by design
 * so swapping in a DE model on Oskar's machine is a config change, not a code
 * change. Verified here against English only.
 */

export interface TranscribeOptions {
	/** Path to the ggml model file. Defaults to `~/.whisper-models/ggml-base.en.bin`. */
	modelPath?: string;
	/** Spoken language code `whisper-cli` expects (e.g. "en", "de", "auto"). Defaults to "en". */
	language?: string;
	/** Milliseconds to wait for `whisper-cli` before killing it and rejecting. Defaults to 60s. */
	timeoutMs?: number;
}

export interface TranscribeResult {
	text: string;
	language: string;
}

/** Shape of the JSON `whisper-cli --output-json` writes (fields we rely on). */
interface WhisperCliJsonOutput {
	result?: { language?: string };
	transcription?: Array<{ text: string }>;
}

const DEFAULT_MODEL_PATH = join(homedir(), ".whisper-models", "ggml-base.en.bin");
const DEFAULT_LANGUAGE = "en";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Transcribes `audioFilePath` by spawning a `whisper-cli` subprocess and reading
 * back its JSON result file.
 *
 * Runs: `whisper-cli -m <modelPath> -f <audioFilePath> -l <language>
 * --output-json --no-prints -of <tempOutputBase>`, then reads and parses the
 * `<tempOutputBase>.json` whisper.cpp writes, joining segment text into one
 * transcript string.
 *
 * Rejects with a descriptive error if `whisper-cli` is missing, times out, or
 * exits non-zero — never swallows a failed transcription silently.
 */
export async function transcribe(audioFilePath: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
	const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
	const language = options.language ?? DEFAULT_LANGUAGE;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const outputBase = join(tmpdir(), `geist-voice-${randomUUID()}`);
	const outputJsonPath = `${outputBase}.json`;

	try {
		await runWhisperCli({ modelPath, audioFilePath, language, outputBase, timeoutMs });

		const raw = await readFile(outputJsonPath, "utf8");
		const parsed = JSON.parse(raw) as WhisperCliJsonOutput;
		const text = (parsed.transcription ?? [])
			.map((segment) => segment.text)
			.join("")
			.trim();
		const detectedLanguage = parsed.result?.language ?? language;

		return { text, language: detectedLanguage };
	} finally {
		await unlink(outputJsonPath).catch(() => {});
	}
}

interface RunWhisperCliArgs {
	modelPath: string;
	audioFilePath: string;
	language: string;
	outputBase: string;
	timeoutMs: number;
}

/** Spawns `whisper-cli`, resolving once it exits 0 and rejecting on error/timeout/non-zero exit. */
function runWhisperCli(args: RunWhisperCliArgs): Promise<void> {
	const { modelPath, audioFilePath, language, outputBase, timeoutMs } = args;

	return new Promise((resolve, reject) => {
		const child = spawn(
			"whisper-cli",
			["-m", modelPath, "-f", audioFilePath, "-l", language, "--output-json", "--no-prints", "-of", outputBase],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		let stderr = "";
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle(() => reject(new Error(`whisper-cli timed out after ${timeoutMs}ms transcribing "${audioFilePath}"`)));
		}, timeoutMs);

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			settle(() => reject(new Error(`failed to spawn whisper-cli: ${error.message}`)));
		});

		child.on("close", (code) => {
			settle(() => {
				if (code !== 0) {
					reject(
						new Error(`whisper-cli exited with code ${code} transcribing "${audioFilePath}": ${stderr.trim()}`),
					);
				} else {
					resolve();
				}
			});
		});
	});
}
