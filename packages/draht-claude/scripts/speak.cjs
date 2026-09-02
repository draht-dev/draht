#!/usr/bin/env node
/**
 * draht speak — ElevenLabs text-to-speech helper.
 *
 * Synthesizes text with the ElevenLabs /v1/text-to-speech API and plays it
 * on the local audio device. Self-contained: no dependencies beyond Node 18+
 * (global fetch) and a local audio player (afplay on macOS; mpv/ffplay/mpg123
 * elsewhere).
 *
 * Usage:
 *   node speak.cjs [options] "text to speak"
 *   echo "text" | node speak.cjs [options]
 *
 * Options:
 *   --voice <id>    ElevenLabs voice id (default: $DRAHT_SPEAK_VOICE_ID or George)
 *   --model <id>    model id (default: $DRAHT_SPEAK_MODEL_ID or eleven_flash_v2_5)
 *   --speed <n>     speaking speed 0.25–4.0 (default 1.0)
 *   --lang <code>   ISO 639-1 language hint (flash/turbo/v3 models only)
 *   --out <file>    also keep the mp3 at this path
 *   --no-play       synthesize only, do not play audio
 *   --force         bypass the character-count cost guard
 *
 * API key resolution order:
 *   1. $ELEVENLABS_API_KEY
 *   2. ELEVENLABS_API_KEY=... line in ./.env
 *   3. ~/.draht/keys/elevenlabs.key (file containing only the key)
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George — multilingual narrative
const DEFAULT_MODEL = "eleven_flash_v2_5"; // 32 languages, ~75ms latency, half price
const MAX_CHARS = Number(process.env.DRAHT_SPEAK_MAX_CHARS || 4000);

function fail(msg) {
	console.error(`speak: ${msg}`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { play: true, force: false, textParts: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--voice":
				opts.voice = argv[++i];
				break;
			case "--model":
				opts.model = argv[++i];
				break;
			case "--speed":
				opts.speed = Number(argv[++i]);
				break;
			case "--lang":
				opts.lang = argv[++i];
				break;
			case "--out":
				opts.out = argv[++i];
				break;
			case "--no-play":
				opts.play = false;
				break;
			case "--force":
				opts.force = true;
				break;
			case "-h":
			case "--help":
				console.log("usage: speak.cjs [--voice id] [--model id] [--speed n] [--lang code] [--out file] [--no-play] [--force] \"text\"");
				process.exit(0);
				break;
			default:
				opts.textParts.push(a);
		}
	}
	return opts;
}

function readEnvFileKey(path) {
	if (!existsSync(path)) return undefined;
	try {
		const line = readFileSync(path, "utf-8")
			.split("\n")
			.find((l) => l.trim().startsWith("ELEVENLABS_API_KEY="));
		if (!line) return undefined;
		const value = line.slice(line.indexOf("=") + 1).trim();
		return value.replace(/^["']|["']$/g, "") || undefined;
	} catch {
		return undefined;
	}
}

function resolveApiKey() {
	if (process.env.ELEVENLABS_API_KEY?.trim()) return process.env.ELEVENLABS_API_KEY.trim();
	const fromDotenv = readEnvFileKey(join(process.cwd(), ".env"));
	if (fromDotenv) return fromDotenv;
	const keyFile = join(homedir(), ".draht", "keys", "elevenlabs.key");
	if (existsSync(keyFile)) {
		const value = readFileSync(keyFile, "utf-8").trim();
		if (value) return value;
	}
	return undefined;
}

function readStdin() {
	try {
		return readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

function findPlayer() {
	if (process.platform === "darwin") return { cmd: "afplay", args: [] };
	for (const candidate of [
		{ cmd: "mpv", args: ["--no-video", "--really-quiet"] },
		{ cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] },
		{ cmd: "mpg123", args: ["-q"] },
	]) {
		const probe = spawnSync(candidate.cmd, ["--version"], { stdio: "ignore" });
		if (!probe.error) return candidate;
	}
	return undefined;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	let text = opts.textParts.join(" ").trim();
	if (!text && !process.stdin.isTTY) text = readStdin().trim();
	if (!text) fail("no text given (pass as argument or on stdin)");

	if (text.length > MAX_CHARS && !opts.force) {
		fail(
			`text is ${text.length} chars (> ${MAX_CHARS} guard, billed per character). ` +
				"Shorten it for the ear, or pass --force / set DRAHT_SPEAK_MAX_CHARS.",
		);
	}

	const apiKey = resolveApiKey();
	if (!apiKey) {
		fail(
			"no ElevenLabs API key found. Set ELEVENLABS_API_KEY, add it to ./.env, " +
				"or write it to ~/.draht/keys/elevenlabs.key",
		);
	}

	const voice = opts.voice || process.env.DRAHT_SPEAK_VOICE_ID || DEFAULT_VOICE;
	const model = opts.model || process.env.DRAHT_SPEAK_MODEL_ID || DEFAULT_MODEL;

	const body = { text, model_id: model };
	if (opts.lang) body.language_code = opts.lang;
	const speed = opts.speed ?? (process.env.DRAHT_SPEAK_SPEED ? Number(process.env.DRAHT_SPEAK_SPEED) : undefined);
	if (speed !== undefined) {
		if (!(speed >= 0.25 && speed <= 4)) fail("--speed must be between 0.25 and 4.0");
		body.voice_settings = { speed };
	}

	const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 400);
		const hint =
			res.status === 401
				? " (invalid or missing API key)"
				: res.status === 422
					? " (check voice/model id)"
					: res.status === 429
						? " (rate limited — retry shortly)"
						: "";
		fail(`ElevenLabs API error ${res.status}${hint}: ${detail}`);
	}

	const audio = Buffer.from(await res.arrayBuffer());
	const mp3 = opts.out || join(mkdtempSync(join(tmpdir(), "draht-speak-")), "speech.mp3");
	await writeFile(mp3, audio);

	const chars = res.headers.get("x-character-count") || String(text.length);
	console.log(`spoke ${chars} chars · voice ${voice} · model ${model} · ${mp3}`);

	if (opts.play) {
		const player = findPlayer();
		if (!player) {
			console.error("speak: no audio player found (afplay/mpv/ffplay/mpg123) — audio saved but not played");
			process.exit(2);
		}
		try {
			execFileSync(player.cmd, [...player.args, mp3], { stdio: "ignore" });
		} catch (err) {
			fail(`playback failed via ${player.cmd}: ${err.message}`);
		}
	}
}

main().catch((err) => fail(err?.message || String(err)));
