import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { LlamaClient, type LlamaModelInfo, normalizeLlamaServerUrl } from "./client.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "./provider.ts";
import { type LlamaUi, runWithProgress, showLlamaUi } from "./ui.ts";

function modelIsLoaded(model: LlamaModelInfo): boolean {
	return model.status.value === "loaded" || model.status.value === "sleeping";
}

function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = `${error.name} ${error.message}`.toLowerCase();
	return message.includes("fetch failed") || message.includes("timeout") || message.includes("network");
}

function connectionErrorMessage(error: unknown): string {
	if (isConnectionError(error)) return "Could not connect to the server.";
	return error instanceof Error ? error.message : String(error);
}

async function configuredClient(ctx: ExtensionCommandContext): Promise<LlamaClient | undefined> {
	const result = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
	if (!result) {
		ctx.ui.notify(`Configure llama.cpp with /login ${LLAMA_PROVIDER_ID}`, "warning");
		return undefined;
	}
	const configuredUrl = result.env?.LLAMA_BASE_URL;
	const serverUrl = normalizeLlamaServerUrl(
		typeof configuredUrl === "string" && configuredUrl ? configuredUrl : (result.auth.baseUrl ?? ""),
	);
	return new LlamaClient(serverUrl, result.auth.apiKey);
}

export default function llamaExtension(pi: ExtensionAPI): void {
	const provider = createLlamaProvider();
	pi.registerProvider(provider.provider);

	const syncCatalog = async (
		ctx: ExtensionCommandContext,
		client: LlamaClient,
		catalog?: LlamaModelInfo[],
	): Promise<LlamaModelInfo[]> => {
		const current = catalog ?? (await client.list());
		provider.setCatalog(current, client.serverUrl);
		await ctx.modelRegistry.refresh();
		return current;
	};

	const loadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		catalog: LlamaModelInfo[],
		target: LlamaModelInfo,
	): Promise<void> => {
		const loaded = catalog.filter((model) => model.id !== target.id && modelIsLoaded(model));
		let replace = false;
		if (loaded.length > 0) {
			const choice = await ui.select(`${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`, [
				"Unload all and load",
				"Keep loaded and load",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			replace = choice === "Unload all and load";
		}

		const restoreLoaded = async (): Promise<void> => {
			ctx.ui.notify("Restoring previously loaded models");
			for (const model of loaded) await client.loadAndWait(model.id, () => {});
			await syncCatalog(ctx, client);
		};
		if (replace) {
			for (const model of loaded) await client.unloadAndWait(model.id);
		}

		try {
			const result = await runWithProgress(ui, {
				title: "Loading model",
				model: target.id,
				initialMessage: "Starting…",
				cancelTitle: "Stop loading?",
				cancelMessage: `Stop loading ${target.id}?`,
				run: (signal, update) => client.loadAndWait(target.id, update, signal),
				cancel: () => client.unload(target.id),
			});
			if (result.cancelled) {
				if (replace) await restoreLoaded();
				return;
			}
			const refreshed = await syncCatalog(ctx, client);
			const loadedModel = refreshed.find((model) => model.id === target.id);
			ctx.ui.notify(
				loadedModel?.status.value === "loaded" ? `Loaded ${target.id}` : `Load started for ${target.id}`,
			);
		} catch (error) {
			if (replace) {
				try {
					await restoreLoaded();
				} catch {
					// Preserve the original load error.
				}
			}
			throw error;
		}
	};

	const unloadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		model: LlamaModelInfo,
	): Promise<void> => {
		if (!(await ui.confirm("Unload model?", `Unload ${model.id}?`))) return;
		await client.unloadAndWait(model.id);
		await syncCatalog(ctx, client);
		ctx.ui.notify(`Unloaded ${model.id}`);
	};

	const downloadModel = async (ctx: ExtensionCommandContext, ui: LlamaUi, client: LlamaClient): Promise<void> => {
		const model = (await ui.input("Download llama.cpp model", "owner/repository[:quant]"))?.trim();
		if (!model) return;
		if (/\s/u.test(model) || !model.includes("/")) {
			ctx.ui.notify("Use owner/repository[:quant]", "error");
			return;
		}
		const result = await runWithProgress(ui, {
			title: "Downloading model",
			model,
			initialMessage: "Starting…",
			cancelTitle: "Stop download?",
			cancelMessage: `Stop downloading ${model}?`,
			run: (signal, update) => client.downloadAndWait(model, update, signal),
			cancel: () => client.unload(model),
		});
		if (result.cancelled) return;
		await syncCatalog(ctx, client, result.value);
		ctx.ui.notify(`Downloaded ${model}`);
	};

	pi.registerCommand("llama", {
		description: "Manage llama.cpp router models",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				return;
			}
			const client = await configuredClient(ctx);
			if (!client) return;
			await showLlamaUi(ctx, async (ui) => {
				const readCatalog = async (): Promise<LlamaModelInfo[] | undefined> => {
					while (true) {
						try {
							return await syncCatalog(ctx, client);
						} catch (error) {
							if ((await ui.connectionError(client.serverUrl, connectionErrorMessage(error))) === "close") {
								return undefined;
							}
						}
					}
				};

				let catalog = await readCatalog();
				if (!catalog) return;
				while (true) {
					const action = await ui.showModels(client.serverUrl, catalog);
					if (action.type === "close") return;
					let actionError: unknown;
					try {
						if (action.type === "download") await downloadModel(ctx, ui, client);
						else if (modelIsLoaded(action.model)) await unloadModel(ctx, ui, client, action.model);
						else if (action.model.status.value === "unloaded")
							await loadModel(ctx, ui, client, catalog, action.model);
						else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, "warning");
					} catch (error) {
						actionError = error;
					}
					const refreshed = await readCatalog();
					if (!refreshed) return;
					catalog = refreshed;
					if (actionError && !isConnectionError(actionError)) {
						ctx.ui.notify(actionError instanceof Error ? actionError.message : String(actionError), "error");
					}
				}
			});
		},
	});
}
