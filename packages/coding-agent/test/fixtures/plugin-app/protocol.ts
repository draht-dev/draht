import { defineService, type RemoteState, type RpcOptions } from "./kernel.ts";

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

export type StateSnapshot = Record<string, Record<string, unknown>>;

export type SessionRequest = {
	type: "rpc";
	service: string;
	method: string;
	args: unknown[];
	rpcOptions?: true;
};

export type ClientWireMessage =
	| { type: "hello"; clientId: string }
	| { type: "request"; id: number; request: SessionRequest }
	| { type: "cancel"; id: number };

export type ServerWireMessage =
	| { type: "snapshot"; states: StateSnapshot }
	| { type: "state_update"; service: string; property: string; value: unknown }
	| { type: "response"; id: number; result?: unknown; error?: string };
