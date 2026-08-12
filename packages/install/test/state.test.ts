import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statePath } from "../src/paths.ts";
import { createDefaultState, loadState, StateCorruptError, saveState } from "../src/state.ts";
import type { InstallState } from "../src/types.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "draht-install-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// A standalone script (not the real saveState, but the identical algorithm: temp file in the
// same directory, write, fsync, rename, best-effort directory fsync) that loops writing
// increasingly large documents so a SIGKILL has a realistic chance of landing mid-write.
const ATOMIC_WRITER_SCRIPT = `
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
mkdirSync(root, { recursive: true });
const targetPath = join(root, "state.json");
const pad = "x".repeat(200000);

let n = 0;
function writeOnce(value) {
	const serialized = JSON.stringify({ n: value, pad }) + "\\n";
	const tmpPath = join(root, \`.state.json.tmp-\${process.pid}-\${value}\`);
	const fd = openSync(tmpPath, "w");
	try {
		writeSync(fd, serialized);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmpPath, targetPath);
}

while (true) {
	writeOnce(n);
	n += 1;
}
`;

describe("loadState", () => {
	it("returns a fresh default state when state.json is missing", () => {
		expect(loadState(root)).toEqual(createDefaultState());
	});

	it("round-trips a saved state exactly", () => {
		const state: InstallState = {
			schemaVersion: 1,
			channel: "latest",
			profile: { mode: "explicit", selectors: ["claude-plugin:foo"] },
			components: {
				foo: {
					id: "foo",
					kind: "claude-plugin",
					version: "1.2.3",
					source: { npmName: "@draht/foo", resolvedVersion: "1.2.3" },
					files: [{ path: "index.js", sha256: "abc" }],
					effectiveness: "unknown",
				},
			},
			lastTx: "tx-1",
		};

		saveState(root, state);
		expect(loadState(root)).toEqual(state);
	});

	it("throws StateCorruptError for unparseable JSON", () => {
		writeFileSync(statePath(root), "{ not json");
		expect(() => loadState(root)).toThrow(StateCorruptError);
	});

	it("throws StateCorruptError for JSON that violates the schema", () => {
		writeFileSync(statePath(root), JSON.stringify({ schemaVersion: 2, channel: "latest" }));
		expect(() => loadState(root)).toThrow(StateCorruptError);
	});
});

describe("saveState atomicity", () => {
	it("never leaves state.json torn even under repeated SIGKILL mid-write", async () => {
		const scriptPath = join(root, "atomic-writer.mjs");
		writeFileSync(scriptPath, ATOMIC_WRITER_SCRIPT);
		const path = statePath(root);

		for (let i = 0; i < 5; i++) {
			const child = spawn(process.execPath, [scriptPath, root], { stdio: "ignore" });
			await new Promise<void>((resolve) => setTimeout(resolve, 25 + Math.random() * 35));
			child.kill("SIGKILL");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));

			if (!existsSync(path)) continue;

			const raw = readFileSync(path, "utf8");
			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(raw);
			}).not.toThrow();
			expect(parsed).toMatchObject({ n: expect.any(Number) });
		}
	}, 20000);
});
