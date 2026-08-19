import {
	type AgentHarness,
	BACKGROUND_CONTEXT,
	type Context,
	type RemoteServiceProvider,
	remoteState,
} from "@draht/agent-core";
import { getSupportedThinkingLevels } from "@draht/ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { Models, type ModelsState } from "./models.ts";

export async function provideModelsService(
	provider: RemoteServiceProvider,
	harness: AgentHarness,
	modelRuntime: ModelRuntime | undefined,
): Promise<void> {
	let catalogRevision = 0;
	const readConfiguration = async (context: Context = BACKGROUND_CONTEXT): Promise<ModelsState["configuration"]> => {
		const [selected, thinkingLevel] = await Promise.all([
			harness.getModel(context),
			harness.getThinkingLevel(context),
		]);
		return {
			model: selected === undefined ? null : { provider: selected.provider, modelId: selected.id },
			thinkingLevel,
		};
	};
	const readCatalog = async (context: Context = BACKGROUND_CONTEXT): Promise<ModelsState["catalog"]> => {
		const selected = await harness.getModel(context);
		const available = modelRuntime?.getAvailableSnapshot() ?? (selected === undefined ? [] : [selected]);
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			availableModels: available.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
			})),
		};
	};
	const state = remoteState<ModelsState>({
		catalog: await readCatalog(),
		configuration: await readConfiguration(),
		refresh: { status: "idle" },
	});
	provider.provide(Models, {
		state,
		async cycleThinking(context) {
			const selected = await harness.getModel(context);
			if (selected === undefined) return;
			const levels = getSupportedThinkingLevels(selected);
			const current = await harness.getThinkingLevel(context);
			const index = levels.indexOf(current);
			const next = levels[(index + 1) % levels.length] ?? "off";
			await harness.setThinkingLevel(next, context);
			state.set({ ...state.value, configuration: await readConfiguration(context) }, context);
		},
		async refresh(context) {
			state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
			if (modelRuntime === undefined) {
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
			const result = await modelRuntime.refresh({ signal: context.abortSignal });
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
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			await harness.setModel(selected, context);
			state.set({ ...state.value, configuration: await readConfiguration(context) }, context);
		},
	});
}
