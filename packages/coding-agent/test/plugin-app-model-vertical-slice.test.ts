import { describe, expect, it, vi } from "vitest";
import { SessionClient } from "./fixtures/plugin-app/client.ts";
import { defineApp, TestAppRuntime } from "./fixtures/plugin-app/kernel.ts";
import { createCodingAgentApp } from "./fixtures/plugin-app/plugins.ts";
import type { ModelSelectorState, ModelSpec, WireView } from "./fixtures/plugin-app/protocol.ts";
import { LoopbackTransport } from "./fixtures/plugin-app/transport.ts";
import { modelSelectorTui } from "./fixtures/plugin-app/tui/model-selector.ts";
import type { ViewRenderer } from "./fixtures/plugin-app/tui/shared.ts";

interface Deferred<T> {
	promise: Promise<T>;
	reject(error: unknown): void;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let rejectPromise!: (error: unknown) => void;
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function modelView(client: SessionClient): WireView & { state: ModelSelectorState } {
	const view = client.store.views.find((candidate) => candidate.component === "model-selector");
	if (!view || typeof view.state !== "object" || view.state === null || !("schema" in view.state)) {
		throw new Error("Model selector view is not open");
	}
	return view as WireView & { state: ModelSelectorState };
}

describe("app-as-plugins /model vertical slice", () => {
	it("builds the session from plugins and runs /model over a serializable client boundary", async () => {
		const catalogue = createDeferred<readonly ModelSpec[]>();
		let refreshCalls = 0;
		const definition = createCodingAgentApp((_signal) => {
			refreshCalls++;
			return catalogue.promise;
		});
		const runtime = new TestAppRuntime(definition);
		await runtime.start();
		const client = new SessionClient(new LoopbackTransport(runtime.driver, "tui-1"));
		await client.ready;

		expect(definition.plugins.map((plugin) => plugin.id)).toEqual([
			"@pi/providers-builtin",
			"@pi/providers-catalog",
			"@pi/providers-models-json",
			"@pi/auth",
			"@pi/thinking-control",
			"@pi/model-selection",
		]);
		expect(client.store.app.actions).toEqual([{ id: "app.thinking.cycle", description: "Cycle thinking level" }]);
		expect(client.store.app.commands).toEqual([
			{ name: "model", argumentHint: "[provider/]model", description: "Select model" },
		]);
		expect(client.store.app.providers.availableModels.map((model) => model.modelId)).toEqual(["base", "cached"]);
		expect(client.store.app.providers.models.map((model) => model.modelId)).toEqual(["base", "cached", "hidden"]);

		const invocation = client.submit("/model");
		expect(modelView(client).state.refresh).toEqual({ status: "refreshing" });
		expect(refreshCalls).toBe(1);

		catalogue.resolve([{ provider: "ignored", modelId: "fresh", name: "Fresh", reasoning: false }]);
		await vi.waitFor(() => expect(modelView(client).state.refresh).toEqual({ status: "done" }));
		expect(client.store.app.providers.availableModels.map((model) => model.modelId)).toEqual(["base", "fresh"]);

		await client.sendView(modelView(client).id, { type: "select", provider: "acme", modelId: "fresh" });
		await invocation;
		expect(client.store.views).toEqual([]);
		expect(runtime.driver.getConfiguration()).toEqual({
			model: { provider: "acme", modelId: "fresh" },
			thinkingLevel: "off",
		});
		expect(runtime.driver.settings.get("defaultModel")).toEqual({ provider: "acme", modelId: "fresh" });
		expect(client.store.events.filter((event) => event.type === "config_update")).toHaveLength(1);
		expect(runtime.driver.trace).toEqual([
			"command:model",
			"view:open:model-selector",
			"config:acme/fresh",
			"setting:defaultModel",
		]);

		const openedViews = runtime.driver.openedViewCount;
		await client.submit("/model acme/base");
		expect(runtime.driver.openedViewCount).toBe(openedViews);
		expect(refreshCalls).toBe(1);
		expect(runtime.driver.getConfiguration().model).toEqual({ provider: "acme", modelId: "base" });
		client.close();
		runtime.close();
	});

	it("keeps command and TUI renderer plugins independently removable", async () => {
		const complete = createCodingAgentApp(async () => []);
		const commandless = new TestAppRuntime(
			defineApp({
				...complete,
				plugins: complete.plugins.filter((plugin) => plugin.id !== "@pi/model-selection"),
			}),
		);
		await commandless.start();
		const commandlessClient = new SessionClient(new LoopbackTransport(commandless.driver, "commandless"));
		await commandlessClient.ready;
		expect(commandlessClient.store.app.commands).toEqual([]);
		await expect(commandlessClient.submit("/model")).rejects.toThrow("Unknown command: model");
		commandlessClient.close();
		commandless.close();

		const headless = new TestAppRuntime(complete);
		await headless.start();
		const headlessClient = new SessionClient(new LoopbackTransport(headless.driver, "headless"));
		await headlessClient.ready;
		const invocation = headlessClient.submit("/model");
		expect(modelView(headlessClient).component).toBe("model-selector");
		const renderers = new Map<string, ViewRenderer>();
		expect(renderers.has("model-selector")).toBe(false);
		modelSelectorTui.setup(renderers);
		expect(renderers.has("model-selector")).toBe(true);
		headless.close();
		await invocation;
		headlessClient.close();
	});

	it("keeps the cached catalogue when refresh fails", async () => {
		const runtime = new TestAppRuntime(
			createCodingAgentApp(async () => {
				throw new Error("catalogue offline");
			}),
		);
		await runtime.start();
		const client = new SessionClient(new LoopbackTransport(runtime.driver, "failure"));
		await client.ready;

		const invocation = client.submit("/model");
		await vi.waitFor(() =>
			expect(modelView(client).state.refresh).toEqual({
				status: "warning",
				errors: { "@pi/providers-catalog:remote": "catalogue offline" },
			}),
		);
		expect(client.store.app.providers.availableModels.map((model) => model.modelId)).toEqual(["base", "cached"]);
		await client.sendView(modelView(client).id, { type: "cancel" });
		await invocation;
		client.close();
		runtime.close();
	});
});
