import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@draht/ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@draht/mcp";
import { createInMemoryTransportPair } from "@draht/mcp/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import subagentBuiltin from "../../../src/core/builtins/subagent.ts";
import type {
	ExtensionFactory,
	ExtensionUIDialogOptions,
	ToolAnnotations,
} from "../../../src/core/extensions/types.ts";
import type { PermissionMode } from "../../../src/core/multi-agent/permission-gate.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { SourceInfo, SourceScope } from "../../../src/core/source-info.ts";
import type { McpServerEntry } from "../../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "../harness.ts";

/**
 * An MCP server over an in-memory transport with one read-only tool, `lookup`, and one resource.
 * Records the calls and reads it receives as `<server>:<tool or uri>`.
 */
function createReadOnlyServer(name: string, calls: string[]) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name, version: "1.0.0" },
				};
			case "tools/list":
				return {
					tools: [
						{
							name: "lookup",
							description: "Looks a term up.",
							inputSchema: { type: "object", properties: { term: { type: "string" } } },
							annotations: { readOnlyHint: true, openWorldHint: false },
						},
					],
				};
			case "tools/call":
				calls.push(`${name}:${(request.params as { name: string }).name}`);
				return { content: [{ type: "text", text: "found" }] };
			case "resources/list":
				return { resources: [{ uri: `${name}://intro`, name: "intro", mimeType: "text/plain" }] };
			case "resources/templates/list":
				return { resourceTemplates: [] };
			case "resources/read": {
				const { uri } = request.params as { uri: string };
				calls.push(`${name}:${uri}`);
				return { contents: [{ uri, mimeType: "text/plain", text: "intro" }] };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) }));
	});
	void pair.server.start();
	return pair.client;
}

describe("regression #31: the permission gate trusts read-only hints of trusted sources and tool globs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: { mode: PermissionMode; extensions: ExtensionFactory[]; rules?: string }) {
		const confirm = vi.fn(async (_title: string, _message: string, _options?: ExtensionUIDialogOptions) => false);
		const harness = await createHarness({
			extensionFactories: [{ name: "multi-agent", factory: subagentBuiltin }, ...options.extensions],
		});
		harnesses.push(harness);
		if (options.rules !== undefined) {
			mkdirSync(join(harness.tempDir, ".draht"), { recursive: true });
			writeFileSync(join(harness.tempDir, ".draht", "permissions.yml"), options.rules);
		}
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }) });
		await harness.session.prompt(`/permissions ${options.mode}`);
		return { harness, confirm };
	}

	async function call(harness: Harness, name: string, args: JsonObject) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Call the tool");
	}

	/** T3 Code's extension, loaded with `-e`: it registers an MCP server's tools itself, with their hints. */
	function probeExtension(annotations: ToolAnnotations | undefined, execute: () => void): ExtensionFactory {
		return (pi) =>
			pi.registerTool({
				name: "mcp__t3-code__echo_probe",
				label: "echo_probe",
				description: "Echoes its input",
				parameters: Type.Object({ text: Type.String() }),
				...(annotations ? { annotations } : {}),
				execute: async () => {
					execute();
					return { content: [{ type: "text" as const, text: "echoed" }], details: {} };
				},
			});
	}

	for (const mode of ["supervised", "ask", "auto"] as const) {
		it(`${mode}: runs a read-only tool of an extension from outside the project without asking`, async () => {
			const execute = vi.fn();
			const { harness, confirm } = await setup({
				mode,
				extensions: [probeExtension({ readOnlyHint: true, openWorldHint: false }, execute)],
			});
			await call(harness, "mcp__t3-code__echo_probe", { text: "hi" });
			expect(confirm).not.toHaveBeenCalled();
			expect(execute).toHaveBeenCalledOnce();
			expect(getToolResult(harness, "mcp__t3-code__echo_probe").isError).toBe(false);
		});
	}

	it("asks in ask mode for a read-only tool that may reach an open world, and runs it in auto", async () => {
		for (const [mode, asks] of [
			["ask", true],
			["auto", false],
		] as const) {
			const execute = vi.fn();
			const { harness, confirm } = await setup({
				mode,
				extensions: [probeExtension({ readOnlyHint: true }, execute)],
			});
			await call(harness, "mcp__t3-code__echo_probe", { text: "hi" });
			expect(confirm.mock.calls.length, mode).toBe(asks ? 1 : 0);
			if (asks) expect(confirm.mock.calls[0][1]).toContain("open world");
			expect(execute.mock.calls.length, mode).toBe(asks ? 0 : 1);
		}
	});

	it("asks in supervised mode before a file change inside the project, which ask mode allows", async () => {
		for (const [mode, asks] of [
			["supervised", true],
			["ask", false],
		] as const) {
			const { harness, confirm } = await setup({ mode, extensions: [] });
			await call(harness, "write", { path: "notes.md", content: "hi" });
			expect(confirm.mock.calls.length, mode).toBe(asks ? 1 : 0);
			if (asks) expect(confirm.mock.calls[0][1]).toContain("supervised mode");
			expect(existsSync(join(harness.tempDir, "notes.md")), mode).toBe(!asks);
		}
	});

	it("still asks for the same tool without the hint", async () => {
		const execute = vi.fn();
		const { harness, confirm } = await setup({ mode: "auto", extensions: [probeExtension(undefined, execute)] });
		await call(harness, "mcp__t3-code__echo_probe", { text: "hi" });
		expect(confirm).toHaveBeenCalledOnce();
		expect(confirm.mock.calls[0][1]).toContain('no rule matched for tool "mcp__t3-code__echo_probe"');
		expect(execute).not.toHaveBeenCalled();
	});

	it("runs every tool of an integration that a glob allow rule names, hint or not", async () => {
		const execute = vi.fn();
		const { harness, confirm } = await setup({
			mode: "ask",
			extensions: [probeExtension(undefined, execute)],
			rules: 'rules:\n  - tool: "mcp__t3-code__*"\n    action: allow\n',
		});
		await call(harness, "mcp__t3-code__echo_probe", { text: "hi" });
		expect(confirm).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledOnce();
	});

	it("trusts the hints of the user's own extensions, but not of a project's, as the resource loader settles them", async () => {
		const root = mkdtempSync(join(tmpdir(), "issue-31-loader-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		/** An extension file registering the read-only tool `name`, which records each run in `<root>/<name>.ran`. */
		const extension = (name: string) => `import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerTool({
		name: ${JSON.stringify(name)},
		label: ${JSON.stringify(name)},
		description: "Reads nothing",
		parameters: { type: "object", properties: {} },
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute() {
			writeFileSync(${JSON.stringify(join(root, `${name}.ran`))}, "");
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	});
}
`;
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(join(project, ".draht", "extensions"), { recursive: true });
		// A project package named like the built-in extensions' source must not pass for one.
		mkdirSync(join(project, ".draht", "builtin", "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "user.ts"), extension("user_lookup"));
		writeFileSync(join(project, ".draht", "extensions", "project.ts"), extension("project_lookup"));
		writeFileSync(join(project, ".draht", "builtin", "extensions", "spoof.ts"), extension("spoof_lookup"));
		writeFileSync(join(project, ".draht", "settings.json"), JSON.stringify({ packages: ["builtin"] }));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		try {
			const asked: string[] = [];
			for (const name of ["user_lookup", "project_lookup", "spoof_lookup"]) {
				const loader = new DefaultResourceLoader({
					cwd: project,
					agentDir,
					settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: true }),
					extensionFactories: [{ name: "multi-agent", factory: subagentBuiltin }],
				});
				await loader.reload();
				expect(loader.getExtensions().errors).toEqual([]);
				const harness = await createHarness({ resourceLoader: loader });
				harnesses.push(harness);
				const confirm = vi.fn(async (_title: string, _message: string) => false);
				await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }) });
				await harness.session.prompt("/permissions ask");
				await call(harness, name, {});
				if (confirm.mock.calls.length > 0) asked.push(name);
				expect(existsSync(join(root, `${name}.ran`)), name).toBe(confirm.mock.calls.length === 0);
			}
			expect(asked).toEqual(["project_lookup", "spoof_lookup"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks a read-only tool that a glob deny rule names, without asking", async () => {
		const execute = vi.fn();
		const { harness, confirm } = await setup({
			mode: "ask",
			extensions: [probeExtension({ readOnlyHint: true }, execute)],
			rules: 'rules:\n  - tool: "MCP__T3-CODE__*"\n    action: deny\n',
		});
		await call(harness, "mcp__t3-code__echo_probe", { text: "hi" });
		expect(confirm).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(getToolResult(harness, "mcp__t3-code__echo_probe").isError).toBe(true);
	});

	describe("MCP servers", () => {
		const REGISTRAR_PATH = join(tmpdir(), "issue-31-project", ".draht", "extensions", "register.ts");

		/**
		 * The built-in MCP extension in `ask` mode with `entries` from `mcp.json`. With `registeredBy`, an
		 * extension also registers the server `docs` while it loads, and the resource loader then settles
		 * that extension's source to `registeredBy`, as `applyExtensionSourceInfo` does after factories ran.
		 */
		async function setupServers(entries: McpServerEntry[], registeredBy?: SourceInfo, mode: PermissionMode = "ask") {
			const calls: string[] = [];
			const confirm = vi.fn(async (_title: string, _message: string, _options?: ExtensionUIDialogOptions) => false);
			const register: ExtensionFactory = (pi) =>
				pi.registerMcpServer("docs", { url: "http://unused.invalid", exposure: "direct" });
			const extensionsResult = await createTestExtensionsResult([
				{ name: "multi-agent", factory: subagentBuiltin },
				...(registeredBy ? [{ path: REGISTRAR_PATH, factory: register }] : []),
				createMcpExtension({
					loadConfig: () => ({ servers: entries, errors: [] }),
					createTransport: (entry) => createReadOnlyServer(entry.name, calls),
				}),
			]);
			const registrar = extensionsResult.extensions.find((extension) => extension.path === REGISTRAR_PATH);
			if (registrar && registeredBy) registrar.sourceInfo = registeredBy;
			const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }) });
			await harness.session.prompt(`/permissions ${mode}`);
			const names = [...entries.map((entry) => entry.name), ...(registeredBy ? ["docs"] : [])];
			await vi.waitFor(() => {
				const tools = harness.session.getAllTools();
				for (const name of names) expect(tools.some((tool) => tool.name === `mcp__${name}__lookup`)).toBe(true);
				expect(tools.some((tool) => tool.name === "read_mcp_resource" && tool.exposure === "direct")).toBe(true);
			});
			return { harness, confirm, calls };
		}

		const configured = (name: string, scope: "global" | "project"): McpServerEntry => ({
			name,
			config: { url: "http://unused.invalid", exposure: "direct" },
			source: `${scope}/mcp.json`,
			scope,
		});
		const registrar = (scope: SourceScope): SourceInfo => ({
			path: REGISTRAR_PATH,
			source: scope === "project" ? "auto" : "cli",
			scope,
			origin: "top-level",
		});
		const annotationsScopeOf = (harness: Harness, name: string) =>
			harness.session.getAllTools().find((tool) => tool.name === name)?.annotationsScope;

		it("runs a read-only tool of a server in the global mcp.json without asking", async () => {
			const { harness, confirm, calls } = await setupServers([configured("docs", "global")]);
			expect(harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__lookup")).toMatchObject({
				annotations: { readOnlyHint: true },
				annotationsScope: "user",
			});
			await call(harness, "mcp__docs__lookup", { term: "gate" });
			expect(confirm).not.toHaveBeenCalled();
			expect(calls).toEqual(["docs:lookup"]);
		});

		it("still asks for a read-only tool of a server in the project mcp.json", async () => {
			const { harness, confirm, calls } = await setupServers([configured("docs", "project")]);
			await call(harness, "mcp__docs__lookup", { term: "gate" });
			expect(confirm).toHaveBeenCalledOnce();
			expect(calls).toEqual([]);
		});

		it("runs a read-only tool of a server an extension from outside the project registered", async () => {
			const { harness, confirm, calls } = await setupServers([], registrar("temporary"));
			expect(annotationsScopeOf(harness, "mcp__docs__lookup")).toBe("temporary");
			await call(harness, "mcp__docs__lookup", { term: "gate" });
			expect(confirm).not.toHaveBeenCalled();
			expect(calls).toEqual(["docs:lookup"]);
		});

		it("asks for a read-only tool of a server a project extension registered while it loaded", async () => {
			const { harness, confirm, calls } = await setupServers([], registrar("project"));
			expect(annotationsScopeOf(harness, "mcp__docs__lookup")).toBe("project");
			await call(harness, "mcp__docs__lookup", { term: "gate" });
			expect(confirm).toHaveBeenCalledOnce();
			expect(calls).toEqual([]);
		});

		it("auto: runs the resource tools without asking while every server they reach is trusted", async () => {
			const { harness, confirm, calls } = await setupServers([configured("docs", "global")], undefined, "auto");
			expect(annotationsScopeOf(harness, "read_mcp_resource")).toBe("user");
			await call(harness, "read_mcp_resource", { server: "docs", uri: "docs://intro" });
			expect(confirm).not.toHaveBeenCalled();
			expect(calls).toEqual(["docs:docs://intro"]);
		});

		it("auto: asks for the resource tools once they reach a server in the project mcp.json", async () => {
			const { harness, confirm, calls } = await setupServers(
				[configured("docs", "global"), configured("notes", "project")],
				undefined,
				"auto",
			);
			await vi.waitFor(() => expect(annotationsScopeOf(harness, "read_mcp_resource")).toBe("project"));
			await call(harness, "read_mcp_resource", { server: "docs", uri: "docs://intro" });
			expect(confirm).toHaveBeenCalledOnce();
			expect(calls).toEqual([]);
		});
	});
});
