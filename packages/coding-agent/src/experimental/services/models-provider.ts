import {
	type AgentLane,
	BACKGROUND_CONTEXT,
	type Context,
	defineService,
	type MutableReplicatedState,
} from "@draht/agent-core";
import { getSupportedThinkingLevels } from "@draht/ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { defineFacet } from "../facets.ts";
import { Lane } from "./harness.ts";
import { Models, type Models as ModelsService, type ModelsState } from "./models.ts";

export interface ModelsRuntime {
	getAvailableSnapshot(): ReturnType<ModelRuntime["getAvailableSnapshot"]>;
	refresh(options?: Parameters<ModelRuntime["refresh"]>[0]): ReturnType<ModelRuntime["refresh"]> | undefined;
	getModel(...args: Parameters<ModelRuntime["getModel"]>): ReturnType<ModelRuntime["getModel"]>;
}
export const ModelsRuntime = defineService<ModelsRuntime>("pi.local.models-runtime", { rpc: false });

export function createModelsRuntime(runtime: ModelRuntime | undefined): ModelsRuntime {
	return (
		runtime ?? {
			getAvailableSnapshot: () => [],
			refresh: () => undefined,
			getModel: () => undefined,
		}
	);
}

export interface ModelsServiceRuntime {
	readonly service: ModelsService;
	activate(context: Context): Promise<void>;
}

export function createModelsService(
	lane: AgentLane,
	modelRuntime: ModelsRuntime,
	createState: (initial: ModelsState) => MutableReplicatedState<ModelsState>,
): ModelsServiceRuntime {
	let catalogRevision = 0;
	const state = createState({
		catalog: { revision: 0, availableModels: [] },
		configuration: { model: null, thinkingLevel: "off" },
		refresh: { status: "idle" },
	});
	const readConfiguration = async (context: Context): Promise<ModelsState["configuration"]> => {
		const [selected, thinkingLevel] = await Promise.all([lane.getModel(context), lane.getThinkingLevel(context)]);
		return {
			model: selected === undefined ? null : { provider: selected.provider, modelId: selected.id },
			thinkingLevel,
		};
	};
	const readCatalog = async (context: Context): Promise<ModelsState["catalog"]> => {
		const selected = await lane.getModel(context);
		const available = modelRuntime.getAvailableSnapshot();
		const catalog =
			selected === undefined || includesModel(available, selected) ? available : [...available, selected];
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			availableModels: catalog.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
			})),
		};
	};
	const service: ModelsService = {
		state,
		async cycleThinking(context) {
			const selected = await lane.getModel(context);
			if (selected === undefined) return;
			const levels = getSupportedThinkingLevels(selected);
			const current = await lane.getThinkingLevel(context);
			const index = levels.indexOf(current);
			const next = levels[(index + 1) % levels.length] ?? "off";
			await lane.setThinkingLevel(next, context);
			state.set({ ...state.value, configuration: await readConfiguration(context) }, context);
		},
		async refresh(context) {
			state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
			const refresh = modelRuntime.refresh({ signal: context.abortSignal });
			if (refresh === undefined) {
				state.set(
					{
						...state.value,
						catalog: await readCatalog(context),
						configuration: await readConfiguration(context),
						refresh: { status: "done" },
					},
					context,
				);
				return;
			}
			const result = await refresh;
			const errors = Object.fromEntries([...result.errors].map(([id, error]) => [id, error.message]));
			state.set(
				{
					...state.value,
					catalog: await readCatalog(context),
					configuration: await readConfiguration(context),
					refresh: Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors },
				},
				context,
			);
		},
		async select(model, context) {
			const selected = modelRuntime.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			await lane.setModel({ provider: selected.provider, modelId: selected.id }, context);
			state.set({ ...state.value, configuration: await readConfiguration(context) }, context);
		},
	};
	return {
		service,
		async activate(context) {
			const [catalog, configuration] = await Promise.all([readCatalog(context), readConfiguration(context)]);
			state.set({ catalog, configuration, refresh: { status: "idle" } }, context);
		},
	};
}

export const modelsServiceFacet = defineFacet({
	id: "@pi/models",
	setup(env) {
		const runtime = createModelsService(env.use(Lane), env.use(ModelsRuntime), env.remoteState);
		env.provide(Models, runtime.service);
		env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT));
	},
});

function includesModel(
	models: readonly { readonly provider: string; readonly id: string }[],
	selected: { readonly provider: string; readonly id: string },
): boolean {
	return models.some((model) => model.provider === selected.provider && model.id === selected.id);
}
