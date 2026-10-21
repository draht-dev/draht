import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@draht/agent-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const extensionPath = fileURLToPath(new URL("../eval/drahtbank/isolated-tools.ts", import.meta.url));
const originalCwd = process.cwd();
let root: string;
let workspace: string;
let outside: string;
let loaded: LoadExtensionsResult;
const receipts: unknown[] = [];

const text = (result: AgentToolResult<unknown>) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

async function execute(
	name: string,
	args: object,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult<unknown>) => void,
) {
	const registered = loaded.extensions[0]?.tools.get(name);
	if (!registered) throw new Error(`Missing isolated ${name} tool: ${JSON.stringify(loaded.errors)}`);
	return wrapToolDefinition(registered.definition).execute(`test-${name}`, args, signal, onUpdate);
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "drahtbank-extension-"));
	workspace = join(root, "fixture");
	outside = join(root, "outside.txt");
	mkdirSync(workspace);
	writeFileSync(outside, "outside secret");
	writeFileSync(join(workspace, "source.txt"), "alpha\nneedle\nomega\n");
	writeFileSync(join(workspace, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(workspace, "ignored.txt"), "needle ignored");
	symlinkSync(outside, join(workspace, "escape"));
	const stdout = vi.spyOn(fs, "writeSync").mockImplementation((fd, value) => {
		expect(fd).toBe(1);
		receipts.push(JSON.parse(String(value)));
		return Buffer.byteLength(String(value));
	});
	syncBuiltinESMExports();
	try {
		process.chdir(workspace);
		loaded = await loadExtensions([extensionPath], workspace);
	} finally {
		process.chdir(originalCwd);
		stdout.mockRestore();
		syncBuiltinESMExports();
	}
}, 30000);

afterAll(() => {
	process.chdir(originalCwd);
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("Drahtbank isolated native tool extension", () => {
	it("loads through the real extension loader and emits one ready receipt", () => {
		expect(loaded.errors).toEqual([]);
		expect([...loaded.extensions[0].tools.keys()].sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"write",
		]);
		expect(receipts).toEqual([
			expect.objectContaining({
				type: "drahtbank_isolation",
				schemaVersion: 1,
				policy: "fixture-root-v1",
				toolOperationsVersion: "fixture-operations-v1",
				workspace,
				evidence: expect.objectContaining({ workspace, inheritedEnvironment: false, hostProc: false }),
			}),
		]);
	});

	it("emits readiness on JSON stdout before agent events despite startup output redirection", () => {
		const loader = new URL("../src/core/extensions/loader.ts", import.meta.url).href;
		const guard = new URL("../src/core/output-guard.ts", import.meta.url).href;
		const script = `
			import { loadExtensions } from ${JSON.stringify(loader)};
			import { takeOverStdout, writeRawStdout, flushRawStdout } from ${JSON.stringify(guard)};
			takeOverStdout();
			console.log("STARTUP_DIAGNOSTIC");
			process.chdir(${JSON.stringify(workspace)});
			const loaded = await loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(workspace)});
			if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
			writeRawStdout(JSON.stringify({ type: "agent_start" }) + "\\n");
			await flushRawStdout();
		`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
			cwd: originalCwd,
			encoding: "utf8",
			timeout: 30000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const events = child.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events).toEqual([
			expect.objectContaining({ type: "drahtbank_isolation", policy: "fixture-root-v1", workspace }),
			{ type: "agent_start" },
		]);
		expect(child.stderr).toContain("STARTUP_DIAGNOSTIC");
		expect(child.stderr).not.toContain("drahtbank_isolation");
	}, 30000);

	it("preserves native read offsets and write/edit behavior within the fixture", async () => {
		expect(text(await execute("read", { path: "source.txt", offset: 2, limit: 1 }))).toContain("needle");
		await execute("write", { path: "nested/new.txt", content: "before\n" });
		await execute("edit", { path: "nested/new.txt", edits: [{ oldText: "before", newText: "after" }] });
		expect(readFileSync(join(workspace, "nested/new.txt"), "utf8")).toBe("after\n");
		expect(text(await execute("ls", {}))).toContain("nested/");
	});

	it("preserves regex, context, glob and ignore behavior in grep and find", async () => {
		const grep = text(await execute("grep", { pattern: "^needle$", context: 1, glob: "*.txt" }));
		expect(grep).toContain("source.txt:2: needle");
		expect(grep).toContain("source.txt-1- alpha");
		expect(grep).toContain("source.txt-3- omega");
		expect(grep).not.toContain("ignored.txt");
		const find = text(await execute("find", { pattern: "*.txt" }));
		expect(find).toContain("source.txt");
		expect(find).not.toContain("ignored.txt");
	});

	it.each(["read", "edit", "write", "ls", "find", "grep"])("blocks outside access through %s", async (name) => {
		const args = {
			path: outside,
			content: "changed",
			edits: [{ oldText: "outside", newText: "changed" }],
			pattern: "secret",
		};
		await expect(execute(name, args)).rejects.toThrow();
		expect(readFileSync(outside, "utf8")).toBe("outside secret");
	});

	it("blocks native file operations through an escaping symlink", async () => {
		await expect(execute("read", { path: "escape" })).rejects.toThrow();
		await expect(execute("write", { path: "escape", content: "changed" })).rejects.toThrow();
		expect(readFileSync(outside, "utf8")).toBe("outside secret");
	});

	it("runs verification and exposes its native exit code", async () => {
		const success = await execute("bash", { command: "node -e 'console.log(\"CHECK:PASS\")'" });
		expect(text(success)).toContain("CHECK:PASS");
		expect(success.structuredContent).toMatchObject({ exit_code: 0 });
		const failed = await execute("bash", { command: "node -e 'process.exitCode=7'" });
		expect(failed).toMatchObject({ isError: true, structuredContent: { exit_code: 7 } });
	});

	it("blocks shell outside reads and temporary writes without relying on final snapshots", async () => {
		const script = `const fs=require("node:fs");for(const p of ${JSON.stringify([outside, join(workspace, "escape"), "/proc/self/environ"])}){try{fs.readFileSync(p);process.exit(7)}catch{}}try{fs.writeFileSync(${JSON.stringify(join(root, "temporary"))},"escaped");fs.unlinkSync(${JSON.stringify(join(root, "temporary"))});process.exit(8)}catch{}console.log("BLOCKED");`;
		const command = `node -e '${script.replaceAll("'", "'\\''")}'`;
		expect(text(await execute("bash", { command }))).toContain("BLOCKED");
		expect(readFileSync(outside, "utf8")).toBe("outside secret");
	});

	it("retains native image reading using confined bytes", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(join(workspace, "pixel.png"), png);
		const result = await execute("read", { path: "pixel.png" });
		expect(
			result.content.some((part) => part.type === "image" && part.mimeType === "image/png"),
			JSON.stringify(result),
		).toBe(true);
	});

	it("honors aborts without falling back to an unconfined tool", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(execute("bash", { command: "touch should-not-exist" }, controller.signal)).rejects.toThrow(/abort/i);
		expect(existsSync(join(workspace, "should-not-exist"))).toBe(false);
	});

	it("preserves native timeout errors", async () => {
		await expect(execute("bash", { command: "node -e 'setInterval(()=>{},1000)'", timeout: 0.05 })).rejects.toThrow(
			"Command timed out after 0.05 seconds",
		);
	});

	it("makes complete captured output readable as a readonly artifact", async () => {
		const updates: AgentToolResult<unknown>[] = [];
		const result = await execute(
			"bash",
			{
				command:
					'node -e \'for(let i=0;i<2500;i++)console.log("line-"+i+" "+"x".repeat(600));setTimeout(()=>console.log("FINAL-LINE"),250)\'',
			},
			undefined,
			(update) => updates.push(update),
		);
		const details = result.details;
		if (!details || typeof details !== "object" || !("fullOutputPath" in details))
			throw new Error("No output capture");
		const path = details.fullOutputPath;
		expect(path).toMatch(/^\/\.drahtbank\/artifacts\//);
		expect(text(result)).toContain(`Full output: ${path}`);
		expect(result.structuredContent).toMatchObject({ truncated: true, full_output_path: path });
		expect(updates.length).toBeGreaterThan(1);
		expect(JSON.stringify(updates)).not.toContain("/pi-bash-");
		expect(text(await execute("read", { path, offset: 1, limit: 2 }))).toContain("line-0 ");
		expect(text(await execute("read", { path, offset: 2501, limit: 1 }))).toContain("FINAL-LINE");
		expect(text(await execute("bash", { command: `tail -n 1 '${path}'` }))).toContain("FINAL-LINE");
		await expect(execute("write", { path, content: "replacement" })).rejects.toThrow();
		const denied = await execute("bash", { command: `printf replacement > '${path}'` });
		expect(denied.isError).toBe(true);
		expect(text(await execute("read", { path, offset: 1, limit: 1 }))).toContain("line-0");
	});

	it("retains complete captured output when the command times out", async () => {
		let failure = "";
		try {
			await execute("bash", {
				command: "node -e 'for(let i=0;i<2500;i++)console.log(\"line-\"+i);setInterval(()=>{},1000)'",
				timeout: 1,
			});
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		expect(failure).toContain("Command timed out after 1 seconds");
		expect(failure).not.toContain("/pi-bash-");
		const path = failure.match(/Full output: (\/\.drahtbank\/artifacts\/[^\]\s]+)/)?.[1];
		expect(path).toBeDefined();
		expect(text(await execute("read", { path, offset: 2500, limit: 1 }))).toContain("line-2499");
	});

	it("registers no tools and emits no receipt when confinement cannot be established", async () => {
		const stdout = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);
		syncBuiltinESMExports();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("startup terminated");
		});
		try {
			process.chdir(tmpdir());
			const failed = await loadExtensions([extensionPath], tmpdir());
			expect(failed.extensions).toEqual([]);
			expect(failed.errors).toHaveLength(1);
			expect(exit).toHaveBeenCalledWith(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("isolation unavailable"));
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			process.chdir(originalCwd);
			stdout.mockRestore();
			syncBuiltinESMExports();
			stderr.mockRestore();
			exit.mockRestore();
		}
	});

	it("terminates before tool initialization when the configured runtime lacks the required operations", async () => {
		const sdk = VIRTUAL_MODULES["@draht/coding-agent"];
		if (!sdk || typeof sdk !== "object") throw new Error("Missing SDK virtual module");
		const stdout = vi.spyOn(fs, "writeSync").mockImplementation(() => 0);
		syncBuiltinESMExports();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("startup terminated");
		});
		try {
			VIRTUAL_MODULES["@draht/coding-agent"] = { ...sdk, DRAHTBANK_TOOL_OPERATIONS_VERSION: undefined };
			process.chdir(workspace);
			const failed = await loadExtensions([extensionPath], workspace);
			expect(failed.extensions).toEqual([]);
			expect(exit).toHaveBeenCalledWith(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("fixture-operations-v1"));
			expect(stdout).not.toHaveBeenCalled();
		} finally {
			VIRTUAL_MODULES["@draht/coding-agent"] = sdk;
			process.chdir(originalCwd);
			stdout.mockRestore();
			syncBuiltinESMExports();
			stderr.mockRestore();
			exit.mockRestore();
		}
	});

	it.each(["old-runtime", "preflight"] as const)(
		"exits a real loader process before a provider could start after %s failure",
		(reason) => {
			const loader = new URL("../src/core/extensions/loader.ts", import.meta.url).href;
			const virtualModules = new URL("../src/core/extensions/virtual-modules.ts", import.meta.url).href;
			const cwd = reason === "preflight" ? tmpdir() : workspace;
			const script = `
				import { loadExtensions } from ${JSON.stringify(loader)};
				import { VIRTUAL_MODULES } from ${JSON.stringify(virtualModules)};
				if (${JSON.stringify(reason)} === "old-runtime") {
					VIRTUAL_MODULES["@draht/coding-agent"] = {
						...VIRTUAL_MODULES["@draht/coding-agent"],
						DRAHTBANK_TOOL_OPERATIONS_VERSION: undefined,
					};
				}
				process.chdir(${JSON.stringify(cwd)});
				await loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(cwd)});
				console.log("PROVIDER_WOULD_START");
			`;
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
				cwd: originalCwd,
				encoding: "utf8",
				timeout: 30000,
			});
			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(1);
			expect(child.stderr).toContain("Drahtbank isolated tools unavailable:");
			expect(child.stdout).not.toContain("PROVIDER_WOULD_START");
			expect(child.stdout).not.toContain("drahtbank_isolation");
		},
		30000,
	);
});
