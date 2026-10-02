import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_RENDER_ATTEMPTS,
	type ReelsState,
	readState,
	recordFailure,
	recordSuccess,
	shouldSkip,
	writeState,
} from "../src/state.ts";

describe("state", () => {
	test("readState returns an empty state when no file exists yet", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-state-test-"));
		try {
			const state = await readState(outDir, "demo");
			expect(state).toEqual({ failed: {} });
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("recordFailure increments attempts; shouldSkip trips after MAX_RENDER_ATTEMPTS", () => {
		let state: ReelsState = { failed: {} };
		for (let i = 0; i < MAX_RENDER_ATTEMPTS - 1; i++) {
			state = recordFailure(state, "sha1", "boom", "2024-01-01T00:00:00Z");
			expect(shouldSkip(state, "sha1")).toBe(false);
		}
		state = recordFailure(state, "sha1", "boom", "2024-01-01T00:00:00Z");
		expect(state.failed.sha1.attempts).toBe(MAX_RENDER_ATTEMPTS);
		expect(shouldSkip(state, "sha1")).toBe(true);
	});

	test("recordSuccess clears a prior failure record", () => {
		let state: ReelsState = { failed: {} };
		state = recordFailure(state, "sha1", "boom", "2024-01-01T00:00:00Z");
		state = recordSuccess(state, "sha1");
		expect(state.failed.sha1).toBeUndefined();
		expect(shouldSkip(state, "sha1")).toBe(false);
	});

	test("writeState/readState round-trips to disk", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-state-test-"));
		try {
			const state = recordFailure({ failed: {} }, "sha1", "boom", "2024-01-01T00:00:00Z");
			await writeState(outDir, "demo", state);
			const reloaded = await readState(outDir, "demo");
			expect(reloaded).toEqual(state);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("C7: readState treats invalid JSON as empty state instead of throwing", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-state-test-"));
		try {
			await writeState(outDir, "demo", { failed: {} });
			writeFileSync(join(outDir, "demo", ".reels-state.json"), "{not valid json");
			const state = await readState(outDir, "demo");
			expect(state).toEqual({ failed: {} });
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("C7: readState treats a null or non-object JSON payload as empty state instead of throwing", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-state-test-"));
		try {
			await writeState(outDir, "demo", { failed: {} });
			writeFileSync(join(outDir, "demo", ".reels-state.json"), "null");
			expect(await readState(outDir, "demo")).toEqual({ failed: {} });

			writeFileSync(join(outDir, "demo", ".reels-state.json"), '"a string"');
			expect(await readState(outDir, "demo")).toEqual({ failed: {} });

			writeFileSync(join(outDir, "demo", ".reels-state.json"), "42");
			expect(await readState(outDir, "demo")).toEqual({ failed: {} });
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
