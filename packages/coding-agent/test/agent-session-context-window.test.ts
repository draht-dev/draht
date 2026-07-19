import { Agent } from "@draht/agent-core";
import { getModel } from "@draht/ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { formatContextWindow, getAvailableContextWindows } from "../src/core/context-windows.ts";
import { KEYBINDINGS } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader, userMsg } from "./utilities.ts";

const directModel = getModel("openai", "gpt-5.6-sol")!;
const codexModel = getModel("openai-codex", "gpt-5.6-sol")!;

async function createOpenAiRuntime(): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await modelRuntime.setRuntimeApiKey("openai", "test-key");
	return modelRuntime;
}

async function createDirectSession(): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: directModel,
				systemPrompt: "Test",
				tools: [],
				thinkingLevel: "medium",
			},
		}),
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRuntime: await createOpenAiRuntime(),
		resourceLoader: createTestResourceLoader(),
	});
	return { session, sessionManager };
}

describe("context-window profiles", () => {
	it("has a default shortcut", () => {
		expect(KEYBINDINGS["app.context.cycle"].defaultKeys).toBe("ctrl+shift+l");
	});

	it("offers provider-specific standard and extended windows for supported OpenAI models", () => {
		expect(getAvailableContextWindows(directModel)).toEqual([272000, 1050000]);
		expect(getAvailableContextWindows(codexModel)).toEqual([372000, 1050000]);
		expect(formatContextWindow(1050000)).toBe("1.05M");
	});

	it("cycles the active window and persists it in the session", async () => {
		const { session, sessionManager } = await createDirectSession();
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe((event) => events.push(event));

		try {
			expect(session.cycleContextWindow()).toBe(1050000);
			expect(session.model?.contextWindow).toBe(1050000);
			expect(sessionManager.buildSessionContext().model).toEqual({
				provider: "openai",
				modelId: "gpt-5.6-sol",
				contextWindow: 1050000,
			});
			expect(events.at(-1)).toEqual({
				type: "context_window_changed",
				contextWindow: 1050000,
				previousContextWindow: 272000,
			});

			expect(session.cycleContextWindow()).toBe(272000);
			expect(session.model?.contextWindow).toBe(272000);
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("restores an extended window when resuming a session", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("openai", "gpt-5.6-sol", 1050000);
		sessionManager.appendMessage(userMsg("continue"));

		const { session } = await createAgentSession({
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: await createOpenAiRuntime(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.model?.provider).toBe("openai");
			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.model?.contextWindow).toBe(1050000);
		} finally {
			session.dispose();
		}
	});
});
