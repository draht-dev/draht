/**
 * Every child spawned for a session gets DRAHT_PERMISSION_MODE set to the
 * session's current permission mode at spawn time, via `AgentRunContext.env` (the seam
 * `child-process.ts` already merges into the child's environment).
 */

import type { Api, Model } from "@draht/ai";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { KeybindingsManager, setKeybindings } from "@draht/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import duetBuiltin from "../../src/core/builtins/duet.ts";
import {
	createSubagentExtension,
	PERMISSION_MODE_ENV,
	permissionEnv,
	runParallelTasks,
	seedPermissionMode,
} from "../../src/core/builtins/subagent.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	TerminalInputHandler,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { AgentLimiter } from "../../src/core/polyphase/limiter.ts";
import type { PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import { getPolyphaseSession, type PolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentRunner } from "../../src/core/polyphase/types.ts";
import { WORKFLOW_TOOL_NAME } from "../../src/core/polyphase/types.ts";
import { createWorkflowToolDefinition } from "../../src/core/polyphase/workflow/tool.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { createScriptedRunner, type RecordedCall } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

function agentScript(call: RecordedCall) {
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantStart("faux", "faux-1"),
			wire.assistantEnd({ text: `done: ${call.task}`, usage: wire.usage(5, 5, 0) }),
			wire.settled(),
		],
	};
}

function modeOf(call: RecordedCall | undefined): string | undefined {
	const env = call?.run?.env;
	const resolved = typeof env === "function" ? env() : env;
	return resolved?.[PERMISSION_MODE_ENV];
}

const harnesses: Harness[] = [];

// A developer's or CI's own shell can export DRAHT_PERMISSION_MODE; the subagent extension seeds
// its session mode from it at factory-creation time, so a stale "yolo" would make the mode
// assertions below fail for a reason unrelated to the behaviour under test.
beforeEach(() => {
	vi.stubEnv(PERMISSION_MODE_ENV, "");
});

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	vi.unstubAllEnvs();
});

describe("subagent tool inherits the session's permission mode", () => {
	async function createSubagentHarness(runner: AgentRunner): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [createSubagentExtension({ runner })] });
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		return harness;
	}

	it("passes auto mode to a single-mode run when neither /yolo nor /permissions was used", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("auto");
	});

	it("switches /yolo off to the mode it replaced, not to a fixed one", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/permissions ask");
		await harness.session.prompt("/yolo");
		await harness.session.prompt("/yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("ask");
	});

	it("switches /yolo off to auto when the session started in yolo", async () => {
		vi.stubEnv(PERMISSION_MODE_ENV, "yolo");
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("auto");
	});

	it("passes yolo mode to a single-mode run after /yolo", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("yolo");
	});

	it("passes ask mode to every parallel task after /permissions ask", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/permissions ask");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "reviewer", task: "look at a.ts" },
							{ agent: "reviewer", task: "look at b.ts" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(2);
		for (const call of scripted.calls) expect(modeOf(call)).toBe("ask");
	});

	it("passes ask mode to every chain step after /permissions ask", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/permissions ask");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						chain: [
							{ agent: "reviewer", task: "look at a.ts" },
							{ agent: "reviewer", task: "look at b.ts" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(2);
		for (const call of scripted.calls) expect(modeOf(call)).toBe("ask");
	});

	it("passes explicit ask mode after /permissions ask, even with a stale yolo env var", async () => {
		vi.stubEnv(PERMISSION_MODE_ENV, "yolo");
		const scripted = createScriptedRunner(agentScript);
		const harness = await createSubagentHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/permissions ask");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("ask");
	});
});

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("the footer names a permission mode other than the one sessions start in", () => {
	async function createStatusHarness(
		factory = createSubagentExtension({ runner: createScriptedRunner(agentScript).runner }),
	) {
		const statuses: (string | undefined)[] = [];
		const warnings: string[] = [];
		const setStatus = (key: string, text: string | undefined) => {
			if (key === "permissions") statuses.push(text);
		};
		const notify = (message: string, type?: "info" | "warning" | "error") => {
			if (type === "warning") warnings.push(message);
		};
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ setStatus, notify }), mode: "tui" });
		return { harness, statuses, warnings };
	}

	it("shows nothing in auto and names every other mode", async () => {
		const { harness, statuses } = await createStatusHarness();
		expect(statuses).toEqual([undefined]);

		await harness.session.prompt("/permissions ask");
		expect(statuses.at(-1)).toBe("perms: ask");
		await harness.session.prompt("/yolo");
		expect(statuses.at(-1)).toBe("perms: yolo");
		await harness.session.prompt("/yolo");
		expect(statuses.at(-1)).toBe("perms: ask");
		await harness.session.prompt("/permissions auto");
		expect(statuses.at(-1)).toBeUndefined();
	});

	it("names a mode seeded from DRAHT_PERMISSION_MODE before any command runs", async () => {
		vi.stubEnv(PERMISSION_MODE_ENV, "ask");
		const { statuses, warnings } = await createStatusHarness();
		expect(statuses).toEqual(["perms: ask"]);
		expect(warnings).toEqual([]);
	});

	it("starts an unknown DRAHT_PERMISSION_MODE, like the old name default, in ask, and says so", async () => {
		vi.stubEnv(PERMISSION_MODE_ENV, "default");
		const { statuses, warnings } = await createStatusHarness();
		expect(statuses).toEqual(["perms: ask"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('DRAHT_PERMISSION_MODE="default"');
	});

	it("keeps a chosen mode across a runtime rebuild only where it asks more than the start mode", async () => {
		// The same factory run again is what /new, /resume, /fork and /reload do.
		const factory = createSubagentExtension({ runner: createScriptedRunner(agentScript).runner });
		const first = await createStatusHarness(factory);
		await first.harness.session.prompt("/permissions ask");
		const rebuilt = await createStatusHarness(factory);
		expect(rebuilt.statuses).toEqual(["perms: ask"]);

		await rebuilt.harness.session.prompt("/yolo");
		const rebuiltAgain = await createStatusHarness(factory);
		expect(rebuiltAgain.statuses).toEqual([undefined]);
	});

	it("never lets a chosen mode relax a stricter DRAHT_PERMISSION_MODE on a rebuild", async () => {
		vi.stubEnv(PERMISSION_MODE_ENV, "ask");
		const factory = createSubagentExtension({ runner: createScriptedRunner(agentScript).runner });
		const first = await createStatusHarness(factory);
		await first.harness.session.prompt("/permissions auto");
		expect(first.statuses.at(-1)).toBeUndefined();
		const rebuilt = await createStatusHarness(factory);
		expect(rebuilt.statuses).toEqual(["perms: ask"]);
	});
});

describe("app.permissions.cycle steps the session's permission mode", () => {
	beforeAll(() => {
		setKeybindings(new KeybindingsManager(KEYBINDINGS));
	});

	async function createKeyHarness(mode: "tui" | "rpc") {
		const handlers: TerminalInputHandler[] = [];
		const statuses: (string | undefined)[] = [];
		const notices: string[] = [];
		const uiContext = createTestUiContext({
			onTerminalInput: (handler) => {
				handlers.push(handler);
				return () => {
					handlers.splice(handlers.indexOf(handler), 1);
				};
			},
			setStatus: (key, text) => {
				if (key === "permissions") statuses.push(text);
			},
			notify: (message) => notices.push(message),
		});
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: createScriptedRunner(agentScript).runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext, mode });
		const press = (data: string) => handlers.map((handler) => handler(data)).find((result) => result !== undefined);
		return { handlers, statuses, notices, press };
	}

	it("goes from auto to ask to yolo and back on alt+m, and leaves other keys alone", async () => {
		const { statuses, notices, press } = await createKeyHarness("tui");

		expect(press("m")).toBeUndefined();
		expect(press("\x1bm")).toEqual({ consume: true });
		expect(statuses.at(-1)).toBe("perms: ask");
		expect(press("\x1bm")).toEqual({ consume: true });
		expect(statuses.at(-1)).toBe("perms: yolo");
		expect(press("\x1bm")).toEqual({ consume: true });
		expect(statuses.at(-1)).toBeUndefined();
		expect(notices.at(-1)).toContain("Permission mode: auto");
	});

	it("listens for the key only in the TUI", async () => {
		const { handlers } = await createKeyHarness("rpc");
		expect(handlers).toHaveLength(0);
	});
});

describe("seedPermissionMode", () => {
	it("starts in auto when the variable is unset or blank", () => {
		expect(seedPermissionMode(undefined)).toEqual({ mode: "auto" });
		expect(seedPermissionMode("")).toEqual({ mode: "auto" });
		expect(seedPermissionMode("  ")).toEqual({ mode: "auto" });
	});

	it("reads a mode name in any letter case and with surrounding whitespace", () => {
		expect(seedPermissionMode("Ask")).toEqual({ mode: "ask" });
		expect(seedPermissionMode(" AUTO ")).toEqual({ mode: "auto" });
		expect(seedPermissionMode("yolo\n")).toEqual({ mode: "yolo" });
	});

	it("starts in ask, the strictest, when the value names no mode, the old name default included", () => {
		expect(seedPermissionMode("default")).toEqual({ mode: "ask", unrecognized: "default" });
		expect(seedPermissionMode("strict")).toEqual({ mode: "ask", unrecognized: "strict" });
	});
});

describe("permissionEnv resolves at spawn time, not queue time", () => {
	it("gives a queued agent the mode current when its slot is granted, not when it was queued", async () => {
		const limiter = new AgentLimiter(1);
		let mode: "ask" | "auto" | "yolo" = "yolo";
		const session = { permissionMode: () => mode };
		const items = [
			{ agent: { name: "first", description: "d", systemPrompt: "s", source: "user" as const }, task: "t1" },
			{ agent: { name: "second", description: "d", systemPrompt: "s", source: "user" as const }, task: "t2" },
		];
		const gate = createDeferred<void>();
		const seenModes: Record<string, string | undefined> = {};

		const runner: AgentRunner = async (_cwd, agent, task, _signal, _step, _onProgress, run) => {
			const resolvedEnv = typeof run?.env === "function" ? run.env() : run?.env;
			seenModes[agent.name] = resolvedEnv?.[PERMISSION_MODE_ENV];
			if (agent.name === "first") await gate.promise;
			return { agent: agent.name, task, exitCode: 0, output: "ok", stderr: "" };
		};

		const resultPromise = runParallelTasks("/fake/cwd", items, {
			runner,
			limiter,
			perItem: () => ({ run: { env: permissionEnv(session) } }),
		});

		// `acquire()`'s fast path still returns a promise, so "first"'s runner only runs once the
		// pending microtasks drain, even though the lease itself was granted synchronously above.
		await new Promise((resolve) => setImmediate(resolve));

		// Capacity 1: "first" acquired its lease and is parked on `gate.promise` inside the runner
		// (seenModes.first already set); "second" is still queued, its env thunk unread.
		expect(limiter.stats().queued).toBe(1);
		expect(seenModes.first).toBe("yolo");
		expect(seenModes.second).toBeUndefined();

		// The session's mode changes while "second" is still queued. A mode baked in at queue time
		// would freeze it at "yolo"; the fix reads it only once "second" is actually granted a slot.
		mode = "ask";
		gate.resolve();
		await resultPromise;

		expect(seenModes.second).toBe("ask");
	});
});

// ── duet ─────────────────────────────────────────────────────────────────────

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

const leadModel = makeModel("openai", "lead-model");
const helperModel = makeModel("anthropic", "helper-model");
const duetAvailableModels = [leadModel, helperModel];

interface FakeDuetPiState {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	activeTools: string[];
}

function createDuetFakePi(runner: AgentRunner): { pi: ExtensionAPI; state: FakeDuetPiState } {
	const state: FakeDuetPiState = { tools: new Map(), commands: new Map(), activeTools: [] };
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		registerTool: (definition: ToolDefinition) => {
			state.tools.set(definition.name, definition);
		},
		registerCommand: (name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			state.commands.set(name, definition);
		},
		on: () => {},
		getAllTools: () => [...state.tools.values()].map((tool) => ({ name: tool.name })),
		getActiveTools: () => state.activeTools,
		setActiveTools: (names: string[]) => {
			state.activeTools = names;
		},
		setModel: async () => true,
		setThinkingLevel: () => {},
		appendEntry: () => {},
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;

	duetBuiltin(pi, { runner });
	return { pi, state };
}

function fakeDuetContext(sessionManager: object, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/fake/cwd",
		hasUI: false,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager,
		model: leadModel,
		thinkingLevel: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => duetAvailableModels, getRegisteredProviderIds: () => [] },
		signal: undefined,
		mode: "print",
		ui: { notify: () => {}, setStatus: () => {} },
		...overrides,
	} as unknown as ExtensionContext;
}

describe("duet teammates inherit the session's permission mode", () => {
	it("defaults to ask mode when nothing set the session's permission-mode provider", async () => {
		const scripted = createScriptedRunner(agentScript);
		const { state } = createDuetFakePi(scripted.runner);
		const ctx = fakeDuetContext({});

		const duetCommand = state.commands.get("duet");
		if (!duetCommand) throw new Error("duet command was not registered");
		await duetCommand.handler(
			"triage lead=openai/lead-model,helper=anthropic/helper-model",
			ctx as unknown as ExtensionCommandContext,
		);

		const delegate = state.tools.get("duet_delegate");
		if (!delegate) throw new Error("duet_delegate tool was not registered");
		const result = await delegate.execute(
			"call-1",
			{ assignments: [{ participant: "helper", task: "investigate X" }] },
			undefined,
			undefined,
			ctx as unknown as Parameters<NonNullable<typeof delegate>["execute"]>[4],
		);

		expect(result.isError).toBeFalsy();
		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("ask");
	});

	it("passes yolo mode to teammates once the session's permission mode is yolo", async () => {
		const scripted = createScriptedRunner(agentScript);
		const { state } = createDuetFakePi(scripted.runner);
		const sessionManager = {};
		const ctx = fakeDuetContext(sessionManager);

		const duetCommand = state.commands.get("duet");
		if (!duetCommand) throw new Error("duet command was not registered");
		await duetCommand.handler(
			"triage lead=openai/lead-model,helper=anthropic/helper-model",
			ctx as unknown as ExtensionCommandContext,
		);

		getPolyphaseSession(sessionManager, undefined).setPermissionModeProvider(() => "yolo");

		const delegate = state.tools.get("duet_delegate");
		if (!delegate) throw new Error("duet_delegate tool was not registered");
		const result = await delegate.execute(
			"call-1",
			{ assignments: [{ participant: "helper", task: "investigate X" }] },
			undefined,
			undefined,
			ctx as unknown as Parameters<NonNullable<typeof delegate>["execute"]>[4],
		);

		expect(result.isError).toBeFalsy();
		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("yolo");
		// A teammate's asks go to this session like any other child's.
		expect(typeof scripted.calls[0]?.run?.onPermissionAsk).toBe("function");
	});
});

// ── workflow agent() ─────────────────────────────────────────────────────────

async function createWorkflowHarness(
	runner: AgentRunner,
	configureSession?: (session: PolyphaseSession) => void,
): Promise<Harness> {
	const renderDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24 };
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async (_event, ctx) => {
					const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
					renderDeps.getStore = () => session.store;
					configureSession?.(session);
					pi.registerTool(createWorkflowToolDefinition({ getSession: () => session, runner, renderDeps }));
					pi.setActiveTools([...pi.getActiveTools(), WORKFLOW_TOOL_NAME]);
				});
			},
		],
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	return harness;
}

const WORKFLOW_SCRIPT = `export const meta = { name: "demo", description: "Demo workflow", phases: [{ title: "Only" }] };
	const result = await agent("task one");
	return { result };`;

describe("workflow agent() inherits the session's permission mode", () => {
	it("defaults to ask mode when nothing set the session's permission-mode provider", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script: WORKFLOW_SCRIPT }, { id: "wf-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);
		await harness.session.prompt("run the workflow");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("ask");
	});

	it("passes auto mode to agent() once the session's permission mode is auto", async () => {
		const scripted = createScriptedRunner(agentScript);
		const harness = await createWorkflowHarness(scripted.runner, (session) =>
			session.setPermissionModeProvider(() => "auto"),
		);
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script: WORKFLOW_SCRIPT }, { id: "wf-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);
		await harness.session.prompt("run the workflow");

		expect(scripted.calls).toHaveLength(1);
		expect(modeOf(scripted.calls[0])).toBe("auto");
	});
});
