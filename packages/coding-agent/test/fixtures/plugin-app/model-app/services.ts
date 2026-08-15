import { defineService, type RemoteState, type RpcOptions } from "../lib/index.ts";

export type ThinkingLevel = "off" | "low" | "high";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSpec extends ModelRef {
	name: string;
	reasoning: boolean;
}

export interface LaneConfiguration {
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
}

export interface ProviderSnapshot {
	revision: number;
	availableModels: readonly ModelSpec[];
	models: readonly ModelSpec[];
}

export type RefreshState =
	| { status: "idle" }
	| { status: "refreshing" }
	| { status: "done" }
	| { status: "warning"; errors: Readonly<Record<string, string>> };

export interface ModelsState {
	catalog: ProviderSnapshot;
	configuration: LaneConfiguration;
	refresh: RefreshState;
}

export interface ModelsService {
	state: RemoteState<ModelsState>;
	cycleThinking(): Promise<void>;
	refresh(options?: RpcOptions): Promise<void>;
	select(model: ModelRef): Promise<void>;
}

export const Models = defineService<ModelsService>("models");
