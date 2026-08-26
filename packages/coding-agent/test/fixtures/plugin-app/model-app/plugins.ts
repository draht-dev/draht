import { type AppPlugin, definePlugin, defineService, type SessionContext } from "../lib/index.ts";
import { ProviderRegistry } from "./providers.ts";
import { type ModelSpec, Models, type ModelsState, type ThinkingLevel } from "./services.ts";
import { registerModelTui } from "./tui/model-selector.ts";
import type { TuiContext } from "./tui/shared.ts";

export type CodingAgentPlugin = AppPlugin<SessionContext, TuiContext>;

const Providers = defineService<ProviderRegistry>("providers");
export const Settings = defineService<{
	get(key: string): unknown;
	set(key: string, value: unknown): Promise<void>;
}>("settings");

export const providersBuiltin = definePlugin<SessionContext, TuiContext>({
	id: "@pi/providers-builtin",
	session(context) {
		const providers = new ProviderRegistry();
		const values = new Map<string, unknown>();
		const settings = {
			get: (key: string) => values.get(key),
			async set(key: string, value: unknown) {
				values.set(key, structuredClone(value));
			},
		};
		const state = context.replicatedState<ModelsState>({
			catalog: providers.snapshot(),
			configuration: { model: undefined, thinkingLevel: "high" },
			refresh: { status: "idle" },
		});
		const sessionController = new AbortController();
		const stop = providers.subscribe((catalog) => state.set({ ...state.value, catalog }));
		const models: Models = {
			state,
			async cycleThinking() {
				const current = state.value.configuration;
				const selected = current.model
					? state.value.catalog.availableModels.find(
							(model) => model.provider === current.model?.provider && model.modelId === current.model.modelId,
						)
					: undefined;
				if (selected && !selected.reasoning) throw new Error("Current model does not support thinking");
				const levels: readonly ThinkingLevel[] = ["off", "low", "high"];
				const thinkingLevel = levels[(levels.indexOf(current.thinkingLevel) + 1) % levels.length] ?? "off";
				state.set({ ...state.value, configuration: { ...current, thinkingLevel } });
			},
			async refresh(options) {
				const previousRefresh = state.value.refresh;
				state.set({ ...state.value, refresh: { status: "refreshing" } });
				const signal = options?.signal
					? AbortSignal.any([sessionController.signal, options.signal])
					: sessionController.signal;
				try {
					const errors = await providers.refresh(signal);
					signal.throwIfAborted();
					state.set({
						...state.value,
						refresh:
							errors.size === 0 ? { status: "done" } : { status: "warning", errors: Object.fromEntries(errors) },
					});
				} catch (error) {
					if (signal.aborted) state.set({ ...state.value, refresh: previousRefresh });
					throw error;
				}
			},
			async select(model) {
				const selected = state.value.catalog.availableModels.find(
					(candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId,
				);
				if (!selected) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
				const configuration = {
					model: { provider: selected.provider, modelId: selected.modelId },
					thinkingLevel: selected.reasoning ? state.value.configuration.thinkingLevel : ("off" as const),
				};
				state.set({ ...state.value, configuration });
				await settings.set("defaultModel", configuration.model);
			},
		};
		context.provide(Providers, providers);
		context.provide(Settings, settings);
		context.provide(Models, models);
		providers.add("@pi/providers-builtin", (draft) => {
			draft.native("acme", [{ provider: "acme", modelId: "base", name: "Base", reasoning: true }]);
			draft.native("unconfigured", [
				{ provider: "unconfigured", modelId: "hidden", name: "Hidden", reasoning: true },
			]);
		});
		context.onActivate(() => providers.rebuild());
		context.onClose(() => {
			stop();
			sessionController.abort();
		});
	},
});

export function providersCatalog(
	refreshCatalog: (signal: AbortSignal) => Promise<readonly ModelSpec[]>,
): CodingAgentPlugin {
	let catalog: readonly ModelSpec[] = [{ provider: "acme", modelId: "cached", name: "Cached", reasoning: true }];
	return definePlugin({
		id: "@pi/providers-catalog",
		session(context: SessionContext) {
			context.use(Providers).add("@pi/providers-catalog", (draft) => {
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

export const providersModelsJson: CodingAgentPlugin = definePlugin({
	id: "@pi/providers-models-json",
	session(context) {
		context.use(Providers).add("@pi/providers-models-json", (draft) => {
			draft.models("acme", (models) =>
				models.map((model) => (model.modelId === "base" ? { ...model, name: "Base (models.json)" } : model)),
			);
		});
	},
});

export const auth: CodingAgentPlugin = definePlugin({
	id: "@pi/auth",
	session(context) {
		context.use(Providers).add("@pi/auth", (draft) => draft.configured("acme"));
	},
});

export const thinkingControl: CodingAgentPlugin = definePlugin({
	id: "@pi/thinking-control",
	client(context) {
		context.actions.register("app.thinking.cycle", () => context.use(Models).cycleThinking());
	},
});

export const modelSelection: CodingAgentPlugin = definePlugin({
	id: "@pi/model-selection",
	client(context) {
		registerModelTui(context, context.use(Models));
	},
});

export function createCodingAgentPlugins(
	refreshCatalog: (signal: AbortSignal) => Promise<readonly ModelSpec[]>,
): readonly CodingAgentPlugin[] {
	return [
		providersBuiltin,
		providersCatalog(refreshCatalog),
		providersModelsJson,
		auth,
		thinkingControl,
		modelSelection,
	];
}
