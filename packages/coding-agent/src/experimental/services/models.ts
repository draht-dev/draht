import { type Context, defineService, type ReplicatedState, type ThinkingLevel } from "@draht/agent-core";

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

export interface Models {
	readonly state: ReplicatedState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	getThinkingLevels(context: Context): Promise<ThinkingLevel[]>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
	selectThinking(level: ThinkingLevel, context: Context): Promise<void>;
}

export const Models = defineService<Models>("pi.models");
