import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { LoopbackTransport, SessionClient, SessionRuntime } from "./fixtures/plugin-app/lib/index.ts";
import { createCodingAgentPlugins, Settings } from "./fixtures/plugin-app/model-app/plugins.ts";
import { type ModelSpec, Models } from "./fixtures/plugin-app/model-app/services.ts";
import { MinimalCodingAgentTui } from "./fixtures/plugin-app/model-app/tui/app.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("app-as-plugins model service", () => {
	it("replicates RemoteState and invokes typed methods over a serializable boundary", async () => {
		const catalogue = createDeferred<readonly ModelSpec[]>();
		let refreshCalls = 0;
		const plugins = createCodingAgentPlugins(() => {
			refreshCalls++;
			return catalogue.promise;
		});
		const runtime = new SessionRuntime(plugins);
		await runtime.start();
		const client = new SessionClient(new LoopbackTransport(runtime.driver, "tui-1"));
		await client.ready;
		const models = client.use(Models);

		expect(plugins.map((plugin) => plugin.id)).toEqual([
			"@pi/providers-builtin",
			"@pi/providers-catalog",
			"@pi/providers-models-json",
			"@pi/auth",
			"@pi/thinking-control",
			"@pi/model-selection",
		]);
		expect(models.state.value.catalog.availableModels.map((model) => model.modelId)).toEqual(["base", "cached"]);
		expect(models.state.value.catalog.models.map((model) => model.modelId)).toEqual(["base", "cached", "hidden"]);

		const observed: string[] = [];
		const unsubscribe = models.state.subscribe((state) => observed.push(state.refresh.status));
		expect(observed).toEqual(["idle"]);
		const refresh = models.refresh();
		await vi.waitFor(() => expect(models.state.value.refresh).toEqual({ status: "refreshing" }));
		expect(refreshCalls).toBe(1);

		catalogue.resolve([{ provider: "ignored", modelId: "fresh", name: "Fresh", reasoning: false }]);
		await refresh;
		expect(models.state.value.refresh).toEqual({ status: "done" });
		expect(models.state.value.catalog.availableModels.map((model) => model.modelId)).toEqual(["base", "fresh"]);
		await models.select({ provider: "acme", modelId: "fresh" });
		expect(models.state.value.configuration).toEqual({
			model: { provider: "acme", modelId: "fresh" },
			thinkingLevel: "off",
		});
		expect(runtime.driver.use(Settings).get("defaultModel")).toEqual({ provider: "acme", modelId: "fresh" });
		expect(observed).toEqual(["idle", "refreshing", "refreshing", "done", "done"]);
		expect(runtime.driver.trace).toEqual(["rpc:models.refresh", "rpc:models.select"]);
		unsubscribe();
		client.close();
		runtime.close();
	});

	it("keeps the client model feature removable without changing the session", async () => {
		const complete = createCodingAgentPlugins(async () => []);
		const runtime = new SessionRuntime(complete);
		await runtime.start();
		const client = new SessionClient(new LoopbackTransport(runtime.driver, "headless"));
		await client.ready;
		const terminal = new VirtualTerminal(80, 24);
		const app = new MinimalCodingAgentTui(
			terminal,
			client,
			complete.filter((plugin) => plugin.id !== "@pi/model-selection"),
		);
		app.start();
		app.submit("/model");
		await vi.waitFor(async () => {
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Unknown command: model");
		});
		expect(client.use(Models).state.value.catalog.availableModels).toHaveLength(2);
		app.stop();
		runtime.close();
	});

	it("keeps the cached catalogue when refresh fails", async () => {
		const runtime = new SessionRuntime(
			createCodingAgentPlugins(async () => {
				throw new Error("catalogue offline");
			}),
		);
		await runtime.start();
		const client = new SessionClient(new LoopbackTransport(runtime.driver, "failure"));
		await client.ready;
		const models = client.use(Models);
		await models.refresh();
		expect(models.state.value.refresh).toEqual({
			status: "warning",
			errors: { "@pi/providers-catalog:remote": "catalogue offline" },
		});
		expect(models.state.value.catalog.availableModels.map((model) => model.modelId)).toEqual(["base", "cached"]);
		client.close();
		runtime.close();
	});
});
