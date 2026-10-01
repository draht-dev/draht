import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("config security", () => {
	test("loadConfig rejects path traversal attempts", () => {
		// Attempt to traverse outside project root
		expect(() => loadConfig("../../etc")).toThrow();
		expect(() => loadConfig("/etc/passwd")).toThrow();
		expect(() => loadConfig("../../../../../../../etc")).toThrow();
	});

	test("saveConfig rejects path traversal attempts in projectRoot", () => {
		// Attempt to write outside project root
		expect(() => saveConfig(DEFAULT_CONFIG, "project", "../../tmp")).toThrow();
		expect(() => saveConfig(DEFAULT_CONFIG, "project", "/etc/passwd")).toThrow();
	});

	test("loadConfig accepts valid relative paths", () => {
		// Valid paths within bounds should not throw path validation errors
		// (they may fail with file not found, which is fine)
		const testDir = join(tmpdir(), `router-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			// Should not throw path validation error - just won't find config
			const result = loadConfig(testDir);
			expect(result).toEqual(DEFAULT_CONFIG);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("loadConfig accepts absolute paths within safe boundaries", () => {
		const testDir = join(tmpdir(), `router-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			// Absolute paths should work if they're safe
			const result = loadConfig(testDir);
			expect(result).toEqual(DEFAULT_CONFIG);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("saveConfig prevents writing outside project boundaries", () => {
		const testDir = join(tmpdir(), `router-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		try {
			// Valid path should work
			saveConfig(DEFAULT_CONFIG, "project", testDir);

			// Path traversal should fail. Climb all the way out so the target lands in a
			// system directory no matter how deep the temp dir sits (test.sh nests it
			// two levels under /tmp, where "../../evil" would still count as temp).
			const climb = "../".repeat(testDir.split("/").length);
			expect(() => saveConfig(DEFAULT_CONFIG, "project", join(testDir, climb, "usr/evil"))).toThrow();
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
