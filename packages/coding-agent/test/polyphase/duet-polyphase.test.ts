import type { Api, Model } from "@draht/ai";
import { describe, expect, it, vi } from "vitest";
import duetBuiltin from "../../src/core/builtins/duet.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";
import { getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import { createScriptedRunner } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

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
const availableModels = [leadModel, helperModel];

interface FakePiState {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	activeTools: string[];
}

function createFakePi(runner: ReturnType<typeof createScriptedRunner>["runner"]): {
	pi: ExtensionAPI;
	state: FakePiState;
} {
	const state: FakePiState = { tools: new Map(), commands: new Map(), activeTools: [] };
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
		setModel: vi.fn(async () => true),
		setThinkingLevel: vi.fn(),
		appendEntry: () => {},
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;

	duetBuiltin(pi, { runner });
	return { pi, state };
}

function fakeContext(sessionManager: object, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/fake/cwd",
		hasUI: false,
		isIdle: () => true,
		isProjectTrusted: () => true,
		sessionManager,
		model: leadModel,
		thinkingLevel: undefined,
		scopedModels: [],
		modelRegistry: { getAvailable: () => availableModels, getRegisteredProviderIds: () => [] },
		signal: undefined,
		mode: "print",
		ui: { notify: () => {}, setStatus: () => {} },
		...overrides,
	} as unknown as ExtensionContext;
}

describe("duet delegate on polyphase", () => {
	it("registers a duet: run with one LiveAgent per teammate and exercises the session limiter", async () => {
		const scripted = createScriptedRunner((call) => ({
			records: [
				wire.sessionHeader(),
				wire.agentStart(),
				wire.assistantStart("anthropic", "helper-model"),
				wire.assistantEnd({ text: `found: ${call.task}`, usage: wire.usage(5, 5, 0) }),
				wire.settled(),
			],
		}));
		const { state } = createFakePi(scripted.runner);

		const sessionManager = {};
		const ctx = fakeContext(sessionManager);

		const duetCommand = state.commands.get("duet");
		if (!duetCommand) throw new Error("duet command was not registered");
		await duetCommand.handler(
			"triage lead=openai/lead-model,helper=anthropic/helper-model",
			ctx as unknown as ExtensionCommandContext,
		);

		const delegate = state.tools.get("duet_delegate");
		expect(delegate).toBeDefined();

		const session = getPolyphaseSession(sessionManager, undefined);
		let limiterChanges = 0;
		const unsubscribe = session.limiter.onChange(() => {
			limiterChanges++;
		});

		const result = await delegate?.execute(
			"call-1",
			{ assignments: [{ participant: "helper", task: "investigate X" }] },
			undefined,
			undefined,
			ctx as unknown as Parameters<NonNullable<typeof delegate>["execute"]>[4],
		);
		unsubscribe();

		expect(result?.isError).toBeFalsy();
		expect(scripted.calls).toHaveLength(1);
		expect(limiterChanges).toBeGreaterThan(0);

		const duetRun = session.store.runs().find((run) => run.kind === "duet");
		expect(duetRun).toBeDefined();
		expect(duetRun?.origin).toBe("tool");
		expect(duetRun?.id).toBe("duet:call-1");
		expect(duetRun?.agents.map((agent) => agent.label)).toEqual(["helper"]);
		expect(duetRun?.status).toBe("done");
	});
});
