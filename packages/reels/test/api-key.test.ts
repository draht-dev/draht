import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { elevenLabsKeyFilePath, resolveElevenLabsApiKey } from "../src/api-key.ts";

const homes: string[] = [];

function homeWithKeyFile(contents: string, mode = 0o600): string {
	const home = mkdtempSync(join(tmpdir(), "reels-api-key-"));
	homes.push(home);
	const path = elevenLabsKeyFilePath(home);
	mkdirSync(join(home, ".draht", "keys"), { recursive: true });
	writeFileSync(path, contents);
	chmodSync(path, mode);
	return home;
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("resolveElevenLabsApiKey", () => {
	test("prefers $ELEVENLABS_API_KEY over the key file", () => {
		const home = homeWithKeyFile("from-file");
		expect(resolveElevenLabsApiKey({ env: { ELEVENLABS_API_KEY: " from-env \n" }, homeDir: home })).toEqual({
			key: "from-env",
			source: "env",
		});
	});

	test("falls back to ~/.draht/keys/elevenlabs.key, trimming the trailing newline", () => {
		const home = homeWithKeyFile("from-file\n");
		expect(resolveElevenLabsApiKey({ env: {}, homeDir: home })).toEqual({ key: "from-file", source: "key-file" });
	});

	test("returns undefined when neither the variable nor the file is set", () => {
		const home = mkdtempSync(join(tmpdir(), "reels-api-key-"));
		homes.push(home);
		expect(resolveElevenLabsApiKey({ env: {}, homeDir: home })).toBeUndefined();
	});

	test("treats an empty key file as missing", () => {
		const home = homeWithKeyFile("  \n");
		expect(resolveElevenLabsApiKey({ env: {}, homeDir: home })).toBeUndefined();
	});

	test("warns about a key file other users can read, without including the key", () => {
		const home = homeWithKeyFile("secret-value", 0o644);
		const resolved = resolveElevenLabsApiKey({ env: {}, homeDir: home });
		expect(resolved?.key).toBe("secret-value");
		expect(resolved?.warning).toContain("chmod 600");
		expect(resolved?.warning).not.toContain("secret-value");
	});
});
