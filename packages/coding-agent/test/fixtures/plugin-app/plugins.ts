import { defineApp, definePlugin } from "./kernel.ts";
import type { ModelSelectorState, ModelSpec, ThinkingLevel } from "./protocol.ts";
import { type CodingAgentApi, type CodingAgentApp, type CodingAgentPlugin, createSessionInstance } from "./session.ts";

export const providersBuiltin = definePlugin<CodingAgentApi>({
	id: "@pi/providers-builtin",
	setup(pi) {
		pi.providers.add((draft) => {
			draft.native("acme", [{ provider: "acme", modelId: "base", name: "Base", reasoning: true }]);
			draft.native("unconfigured", [
				{ provider: "unconfigured", modelId: "hidden", name: "Hidden", reasoning: true },
			]);
		});
	},
});

export function providersCatalog(
	refreshCatalog: (signal: AbortSignal) => Promise<readonly ModelSpec[]>,
): CodingAgentPlugin {
	let catalog: readonly ModelSpec[] = [{ provider: "acme", modelId: "cached", name: "Cached", reasoning: true }];
	return definePlugin({
		id: "@pi/providers-catalog",
		setup(pi: CodingAgentApi) {
			pi.providers.add((draft) => {
				draft.models("acme", (models) => [...models, ...catalog]);
				draft.refresh("acme", "remote", async (signal) => {
					const next = await refreshCatalog(signal);
					signal.throwIfAborted();
					catalog = next.map((model) => ({ ...model, provider: "acme" }));
				});
			});
		},
	});
}

export const providersModelsJson = definePlugin<CodingAgentApi>({
	id: "@pi/providers-models-json",
	setup(pi) {
		pi.providers.add((draft) => {
			draft.models("acme", (models) =>
				models.map((model) => (model.modelId === "base" ? { ...model, name: "Base (models.json)" } : model)),
			);
		});
	},
});

export const auth = definePlugin<CodingAgentApi>({
	id: "@pi/auth",
	setup(pi) {
		pi.providers.add((draft) => draft.configured("acme"));
	},
});

export const thinkingControl = definePlugin<CodingAgentApi>({
	id: "@pi/thinking-control",
	setup(pi) {
		pi.actions.add((draft) => {
			draft.set("app.thinking.cycle", {
				description: "Cycle thinking level",
				async handler() {
					const current = pi.session.getConfiguration();
					const selected = current.model
						? pi.providers
								.snapshot()
								.availableModels.find(
									(model) =>
										model.provider === current.model?.provider && model.modelId === current.model.modelId,
								)
						: undefined;
					if (selected && !selected.reasoning) throw new Error("Current model does not support thinking");
					const levels: readonly ThinkingLevel[] = ["off", "low", "high"];
					const next = levels[(levels.indexOf(current.thinkingLevel) + 1) % levels.length] ?? "off";
					await pi.session.configure({ ...current, thinkingLevel: next });
				},
			});
		});
	},
});

type ModelSelectorMessage = { type: "cancel" } | { type: "select"; provider: string; modelId: string };

function isModelSelectorMessage(value: unknown): value is ModelSelectorMessage {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	const candidate = value as { type?: unknown; provider?: unknown; modelId?: unknown };
	return (
		candidate.type === "cancel" ||
		(candidate.type === "select" && typeof candidate.provider === "string" && typeof candidate.modelId === "string")
	);
}

export const modelSelection = definePlugin<CodingAgentApi>({
	id: "@pi/model-selection",
	setup(pi) {
		pi.commands.add((draft) => {
			draft.set("model", {
				argumentHint: "[provider/]model",
				description: "Select model",
				async handler(args, context) {
					const resolveExact = (query: string): ModelSpec | undefined => {
						const models = pi.providers.snapshot().availableModels;
						const canonical = models.find((model) => `${model.provider}/${model.modelId}` === query);
						if (canonical) return canonical;
						const bare = models.filter((model) => model.modelId === query);
						return bare.length === 1 ? bare[0] : undefined;
					};
					const select = async (model: ModelSpec): Promise<void> => {
						const current = pi.session.getConfiguration();
						await pi.session.configure({
							model: { provider: model.provider, modelId: model.modelId },
							thinkingLevel: model.reasoning ? current.thinkingLevel : "off",
						});
						await pi.settings.set("defaultModel", { provider: model.provider, modelId: model.modelId });
					};

					if (args) {
						let exact = resolveExact(args);
						if (!exact) {
							await pi.providers.refresh(context.signal);
							exact = resolveExact(args);
						}
						if (exact) {
							await select(exact);
							return;
						}
					}

					let refresh: ModelSelectorState["refresh"] = { status: "refreshing" };
					const createState = (): ModelSelectorState => ({
						schema: 1,
						query: args,
						catalogRevision: pi.providers.snapshot().revision,
						refresh,
					});
					const view = pi.view("model-selector", createState(), { to: [context.originatorClientId] });
					const stopRebuild = pi.providers.onRebuild(() => {
						view.state = createState();
					});
					view.on(async (message) => {
						if (!isModelSelectorMessage(message)) return;
						if (message.type === "cancel") {
							view.close();
							return;
						}
						const selected = pi.providers
							.snapshot()
							.availableModels.find(
								(model) => model.provider === message.provider && model.modelId === message.modelId,
							);
						if (!selected) return;
						await select(selected);
						view.close();
					});

					const refreshController = new AbortController();
					const refreshSignal = AbortSignal.any([context.signal, refreshController.signal]);
					void pi.providers
						.refresh(refreshSignal)
						.then((result) => {
							refresh =
								result.errors.size === 0
									? { status: "done" }
									: { status: "warning", errors: Object.fromEntries(result.errors) };
							view.state = createState();
						})
						.catch((error: unknown) => {
							if (refreshSignal.aborted) return;
							refresh = {
								status: "warning",
								errors: { refresh: error instanceof Error ? error.message : String(error) },
							};
							view.state = createState();
						});

					await view.done;
					refreshController.abort();
					stopRebuild();
				},
			});
		});
	},
});

export function createCodingAgentApp(
	refreshCatalog: (signal: AbortSignal) => Promise<readonly ModelSpec[]>,
): CodingAgentApp {
	return defineApp({
		id: "coding-agent",
		create: createSessionInstance,
		plugins: [
			providersBuiltin,
			providersCatalog(refreshCatalog),
			providersModelsJson,
			auth,
			thinkingControl,
			modelSelection,
		],
	});
}
