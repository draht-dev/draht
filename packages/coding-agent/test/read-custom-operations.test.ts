import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as hostFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReadPathAsync } from "../src/core/tools/path-utils.ts";
import { createReadTool } from "../src/core/tools/read.ts";

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof hostFs>();
	return { ...fs, access: vi.fn(fs.access) };
});

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("custom read filesystem ownership", () => {
	it.each([
		{ requested: "exact.txt", stored: "exact.txt" },
		{ requested: "Screenshot at 7.03.05 PM.png", stored: "Screenshot at 7.03.05\u202fPM.png" },
		{ requested: "café.txt", stored: "café.txt".normalize("NFD") },
		{ requested: "capture d'écran.txt", stored: "capture d’écran.txt" },
		{ requested: "café d'écran.txt", stored: "café d’écran.txt".normalize("NFD") },
	])("resolves $requested using only the custom backend", async ({ requested, stored }) => {
		const accesses: string[] = [];
		const hostAccess = vi.spyOn(hostFs, "access");
		const tool = createReadTool("/remote-workspace", {
			operations: {
				access: async (path) => {
					accesses.push(path);
					if (path !== join("/remote-workspace", stored)) throw new Error("Remote file does not exist");
				},
				readFile: async (path) => {
					expect(path).toBe(join("/remote-workspace", stored));
					return Buffer.from("remote contents");
				},
			},
		});
		const result = await tool.execute("read", { path: requested });
		expect(result.content).toEqual([{ type: "text", text: "remote contents" }]);
		expect(accesses).toContain(join("/remote-workspace", requested));
		expect(accesses.at(-1)).toBe(join("/remote-workspace", stored));
		expect(hostAccess).not.toHaveBeenCalled();
	});

	it("does not probe host-existing outside paths before a custom denial", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-custom-outside-"));
		directories.push(directory);
		const outside = join(directory, "private.txt");
		writeFileSync(outside, "host-only contents");
		const hostAccess = vi.spyOn(hostFs, "access");
		const backendRead = vi.fn(async () => Buffer.from("must not be read"));
		const tool = createReadTool("/fixture", {
			operations: {
				access: async () => {
					throw new Error("Outside fixture access denied");
				},
				readFile: backendRead,
			},
		});
		await expect(tool.execute("outside", { path: outside })).rejects.toThrow("Outside fixture access denied");
		expect(backendRead).not.toHaveBeenCalled();
		expect(hostAccess).not.toHaveBeenCalled();
	});

	it("preserves local default path normalization without a custom backend", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-local-path-"));
		directories.push(directory);
		const stored = "café d’écran.txt".normalize("NFD");
		writeFileSync(join(directory, stored), "local contents");
		expect(await resolveReadPathAsync("café d'écran.txt", directory)).toBe(join(directory, stored));
		const result = await createReadTool(directory).execute("local", { path: "café d'écran.txt" });
		expect(result.content).toEqual([{ type: "text", text: "local contents" }]);
	});
});
