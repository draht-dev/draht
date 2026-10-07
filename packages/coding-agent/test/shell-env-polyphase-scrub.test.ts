import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

describe("getShellEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("scrubs the polyphase child-mode markers so a nested draht never inherits them", () => {
		vi.stubEnv("DRAHT_POLYPHASE_DEPTH", "1");
		vi.stubEnv("DRAHT_POLYPHASE_SCHEMA_FILE", "/tmp/schema.json");

		const env = getShellEnv();

		expect(env).not.toHaveProperty("DRAHT_POLYPHASE_DEPTH");
		expect(env).not.toHaveProperty("DRAHT_POLYPHASE_SCHEMA_FILE");
	});

	it("leaves other environment variables untouched", () => {
		vi.stubEnv("DRAHT_POLYPHASE_DEPTH", "1");
		vi.stubEnv("SOME_OTHER_VAR", "kept");

		const env = getShellEnv();

		expect(env.SOME_OTHER_VAR).toBe("kept");
	});
});
