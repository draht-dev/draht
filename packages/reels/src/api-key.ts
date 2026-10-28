/**
 * ElevenLabs API key lookup, shared with the `speak` helper's convention:
 * `$ELEVENLABS_API_KEY` first, then `~/.draht/keys/elevenlabs.key` (a file
 * holding only the key). The key file lets agents run narration without the
 * key ever passing through a shell environment, a command line, or a
 * transcript. Nothing here ever prints the key.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApiKeySource = "env" | "key-file";

export interface ResolvedApiKey {
	key: string;
	source: ApiKeySource;
	/** Set when the key file is readable by group or others. */
	warning?: string;
}

export interface ResolveApiKeyOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

export function elevenLabsKeyFilePath(homeDir: string = homedir()): string {
	return join(homeDir, ".draht", "keys", "elevenlabs.key");
}

export function resolveElevenLabsApiKey(options: ResolveApiKeyOptions = {}): ResolvedApiKey | undefined {
	const env = options.env ?? process.env;
	const fromEnv = env.ELEVENLABS_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };

	const path = elevenLabsKeyFilePath(options.homeDir);
	let contents: string;
	let mode: number;
	try {
		contents = readFileSync(path, "utf-8");
		mode = statSync(path).mode;
	} catch {
		return undefined;
	}
	const key = contents.trim();
	if (!key) return undefined;

	const warning = (mode & 0o077) !== 0 ? `${path} is readable by other users; run: chmod 600 ${path}` : undefined;
	return { key, source: "key-file", warning };
}
