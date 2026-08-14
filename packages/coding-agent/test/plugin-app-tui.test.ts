import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SessionClient } from "./fixtures/plugin-app/client.ts";
import { TestAppRuntime } from "./fixtures/plugin-app/kernel.ts";
import { createCodingAgentApp } from "./fixtures/plugin-app/plugins.ts";
import type { ModelSelectorState, ModelSpec, WireView } from "./fixtures/plugin-app/protocol.ts";
import { LoopbackTransport, SessionTcpServer, TcpClientTransport } from "./fixtures/plugin-app/transport.ts";
import { MinimalCodingAgentTui } from "./fixtures/plugin-app/tui/app.ts";
import { modelSelectorTui } from "./fixtures/plugin-app/tui/model-selector.ts";

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

function modelView(client: SessionClient): WireView & { state: ModelSelectorState } {
	const view = client.store.views.find((candidate) => candidate.component === "model-selector");
	if (!view) throw new Error("Model selector view is not open");
	return view as WireView & { state: ModelSelectorState };
}

async function viewportText(terminal: VirtualTerminal): Promise<string> {
	await terminal.waitForRender();
	return terminal.getViewport().join("\n");
}

describe("remote plugin app TUI", () => {
	it("renders and controls a session over a real TCP transport", async () => {
		const catalogue = createDeferred<readonly ModelSpec[]>();
		const runtime = new TestAppRuntime(createCodingAgentApp(() => catalogue.promise));
		await runtime.start();
		const server = new SessionTcpServer(runtime.driver, { host: "127.0.0.1", port: 0 });
		const address = await server.start();
		const transport = await TcpClientTransport.connect({ ...address, clientId: "tui" });
		const client = new SessionClient(transport);
		await client.ready;
		const closeClient = vi.spyOn(client, "close");
		const terminal = new VirtualTerminal(80, 24);
		const app = new MinimalCodingAgentTui(terminal, client, [modelSelectorTui]);

		try {
			app.start();
			expect(app.tui.mode).toBe("fullscreen");
			const initial = await viewportText(terminal);
			expect(initial).toContain("pi plugin application");
			expect(initial).toContain("Remote session connected");
			expect(initial).toContain("events 0 · catalogue r1");
			expect(initial).toContain("no-model");

			terminal.sendInput("\x1b[Z");
			await vi.waitFor(() => expect(client.store.app.configuration.thinkingLevel).toBe("off"));
			expect(await viewportText(terminal)).toContain("Thinking level: off");

			terminal.sendInput("/");
			await vi.waitFor(async () => {
				const autocomplete = await viewportText(terminal);
				expect(autocomplete).toContain("model");
				expect(autocomplete).toContain("[provider/]model — Select model");
				expect(autocomplete).toContain("quit");
			});
			terminal.sendInput("\t");
			await vi.waitFor(async () => expect(await viewportText(terminal)).toContain("/model "));
			terminal.sendInput("\r");
			await vi.waitFor(() => expect(modelView(client).state.refresh.status).toBe("refreshing"));
			const refreshing = await viewportText(terminal);
			expect(refreshing).toContain("Only showing models from configured providers");
			expect(refreshing).toContain("base [acme]");
			expect(refreshing).toContain("Refreshing model catalogs");

			catalogue.resolve([{ provider: "acme", modelId: "fresh", name: "Fresh", reasoning: false }]);
			await vi.waitFor(() => expect(modelView(client).state.refresh.status).toBe("done"));
			const refreshed = await viewportText(terminal);
			expect(refreshed).toContain("events 2 · catalogue r2");
			expect(refreshed).toContain("fresh [acme]");
			expect(refreshed).toContain("Model catalogs refreshed");

			await client.sendView(modelView(client).id, { type: "select", provider: "acme", modelId: "fresh" });
			await vi.waitFor(() => expect(client.store.views).toEqual([]));
			const selected = await viewportText(terminal);
			expect(selected).toContain("Model: fresh");
			expect(selected).toContain("events 3 · catalogue r2");
			expect(selected).toContain("(acme) fresh");

			terminal.sendInput("\x03");
			expect(closeClient).not.toHaveBeenCalled();
			terminal.sendInput("\x03");
			await app.done;
			expect(closeClient).toHaveBeenCalledOnce();
		} finally {
			app.stop();
			await server.close();
			runtime.close();
		}
	});

	it("applies events buffered after the connection snapshot", async () => {
		const runtime = new TestAppRuntime(createCodingAgentApp(async () => []));
		await runtime.start();
		const transport = new LoopbackTransport(runtime.driver, "buffered");
		await runtime.driver.submit("buffered", "/model acme/base");
		const client = new SessionClient(transport);
		await client.ready;

		expect(client.store.app.configuration).toEqual({
			model: { provider: "acme", modelId: "base" },
			thinkingLevel: "high",
		});
		expect(client.store.events).toEqual([
			{
				type: "config_update",
				previous: { model: undefined, thinkingLevel: "high" },
				value: {
					model: { provider: "acme", modelId: "base" },
					thinkingLevel: "high",
				},
			},
		]);
		client.close();
		runtime.close();
	});
});
