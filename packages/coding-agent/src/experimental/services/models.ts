import { type Context, defineRemoteService, type RemoteState, type ThinkingLevel } from "@draht/agent-core";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSummary extends ModelRef {
	name: string;
	reasoning: boolean;
}

export interface ModelsState {
	catalog: {
		revision: number;
		availableModels: ModelSummary[];
	};
	configuration: {
		model: ModelRef | null;
		thinkingLevel: ThinkingLevel;
	};
	refresh: { status: "idle" | "refreshing" | "done" } | { status: "warning"; errors: Record<string, string> };
}

export interface ModelsService {
	readonly state: RemoteState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
}

export const Models = defineRemoteService<ModelsService>("models");
