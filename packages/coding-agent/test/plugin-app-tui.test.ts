import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	definePlugin,
	LoopbackTransport,
	SessionClient,
	SessionRuntime,
	SessionTcpServer,
	TcpClientTransport,
} from "./fixtures/plugin-app/lib/index.ts";
import { type CodingAgentPlugin, createCodingAgentPlugins } from "./fixtures/plugin-app/model-app/plugins.ts";
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

async function viewportText(terminal: VirtualTerminal): Promise<string> {
	await terminal.waitForRender();
	return terminal.getViewport().join("\n");
}

describe("remote plugin app TUI", () => {
	it("renders and controls typed session services over real TCP", async () => {
		const catalogue = createDeferred<readonly ModelSpec[]>();
		const plugins = createCodingAgentPlugins(() => catalogue.promise);
		const runtime = new SessionRuntime(plugins);
		await runtime.start();
		const server = new SessionTcpServer(runtime.driver, { host: "127.0.0.1", port: 0 });
		const address = await server.start();
		const transport = await TcpClientTransport.connect({ ...address, clientId: "tui" });
		const client = new SessionClient(transport);
		await client.ready;
		const models = client.use(Models);
		const closeClient = vi.spyOn(client, "close");
		const terminal = new VirtualTerminal(80, 24);
		const app = new MinimalCodingAgentTui(terminal, client, plugins);

		try {
			app.start();
			expect(app.tui.mode).toBe("fullscreen");
			const initial = await viewportText(terminal);
			expect(initial).toContain("pi plugin application");
			expect(initial).toContain("Remote session connected");
			expect(initial).toContain("updates 0 · catalogue r1");
			expect(initial).toContain("no-model");

			terminal.sendInput("\x1b[Z");
			await vi.waitFor(() => expect(models.state.value.configuration.thinkingLevel).toBe("off"));
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
			await vi.waitFor(() => expect(models.state.value.refresh.status).toBe("refreshing"));
			const refreshing = await viewportText(terminal);
			expect(refreshing).toContain("Only showing models from configured providers");
			expect(refreshing).toContain("base [acme]");
			expect(refreshing).toContain("Refreshing model catalogs");

			catalogue.resolve([{ provider: "acme", modelId: "fresh", name: "Fresh", reasoning: false }]);
			await vi.waitFor(() => expect(models.state.value.refresh.status).toBe("done"));
			const refreshed = await viewportText(terminal);
			expect(refreshed).toContain("fresh [acme]");
			expect(refreshed).toContain("Model catalogs refreshed");

			terminal.sendInput("fresh");
			await vi.waitFor(async () => expect(await viewportText(terminal)).toContain("Fresh"));
			terminal.sendInput("\r");
			await vi.waitFor(() =>
				expect(models.state.value.configuration.model).toEqual({ provider: "acme", modelId: "fresh" }),
			);
			const selected = await viewportText(terminal);
			expect(selected).toContain("Model: fresh");
			expect(selected).toContain("(acme) fresh");

			app.submit("/model acme/base");
			await vi.waitFor(() =>
				expect(models.state.value.configuration.model).toEqual({ provider: "acme", modelId: "base" }),
			);
			expect(await viewportText(terminal)).toContain("Model: base");

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

	it("cancels the session refresh when the model dialog is dismissed", async () => {
		let markAborted!: () => void;
		const aborted = new Promise<void>((resolve) => {
			markAborted = resolve;
		});
		const plugins = createCodingAgentPlugins(
			(signal) =>
				new Promise<readonly ModelSpec[]>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							markAborted();
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		);
		const runtime = new SessionRuntime(plugins);
		await runtime.start();
		const server = new SessionTcpServer(runtime.driver, { host: "127.0.0.1", port: 0 });
		const address = await server.start();
		const client = new SessionClient(await TcpClientTransport.connect({ ...address, clientId: "cancel" }));
		await client.ready;
		const models = client.use(Models);
		const terminal = new VirtualTerminal(80, 24);
		const app = new MinimalCodingAgentTui(terminal, client, plugins);

		try {
			app.start();
			app.submit("/model");
			await vi.waitFor(() => expect(models.state.value.refresh.status).toBe("refreshing"));
			terminal.sendInput("\x1b");
			await aborted;
			await vi.waitFor(() => expect(models.state.value.refresh.status).toBe("idle"));
			expect(await viewportText(terminal)).not.toContain("Refreshing model catalogs");
		} finally {
			app.stop();
			await server.close();
			runtime.close();
		}
	});

	it("reports session disconnects to both sides", async () => {
		let disconnectedClient: string | undefined;
		const lifecycle: CodingAgentPlugin = definePlugin({
			id: "lifecycle-test",
			session(context) {
				context.onClientDisconnect((clientId) => {
					disconnectedClient = clientId;
				});
			},
		});
		const runtime = new SessionRuntime([...createCodingAgentPlugins(async () => []), lifecycle]);
		await runtime.start();
		const server = new SessionTcpServer(runtime.driver, { host: "127.0.0.1", port: 0 });
		const address = await server.start();
		const client = new SessionClient(await TcpClientTransport.connect({ ...address, clientId: "disconnect-test" }));
		await client.ready;
		const models = client.use(Models);

		await server.close();
		await vi.waitFor(() => expect(client.store.connection.value.status).toBe("disconnected"));
		await vi.waitFor(() => expect(disconnectedClient).toBe("disconnect-test"));
		await expect(models.cycleThinking()).rejects.toThrow("Session connection closed");
		client.close();
		runtime.close();
	});

	it("applies state updates buffered after the connection snapshot", async () => {
		const runtime = new SessionRuntime(createCodingAgentPlugins(async () => []));
		await runtime.start();
		const transport = new LoopbackTransport(runtime.driver, "buffered");
		await runtime.driver.use(Models).select({ provider: "acme", modelId: "base" });
		const client = new SessionClient(transport);
		await client.ready;
		const models = client.use(Models);

		expect(models.state.value.configuration).toEqual({
			model: { provider: "acme", modelId: "base" },
			thinkingLevel: "high",
		});
		expect(client.store.updates).toBe(1);
		const observed: string[] = [];
		models.state.subscribe((state) => observed.push(state.configuration.model?.modelId ?? "none"));
		expect(observed).toEqual(["base"]);
		client.close();
		runtime.close();
	});
});
