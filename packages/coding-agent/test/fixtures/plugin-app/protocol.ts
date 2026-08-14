import type { AppKeybinding } from "../../../src/core/keybindings.ts";

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

export interface CodingAgentSnapshot {
	actions: ReadonlyArray<{ id: AppKeybinding; description: string }>;
	commands: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>;
	configuration: LaneConfiguration;
	providers: ProviderSnapshot;
}

export type CodingAgentEvent =
	| { type: "config_update"; previous: LaneConfiguration; value: LaneConfiguration }
	| { type: "providers_changed"; providers: ProviderSnapshot };

export interface ModelSelectorState {
	schema: 1;
	query: string;
	catalogRevision: number;
	refresh:
		| { status: "refreshing" }
		| { status: "done" }
		| { status: "warning"; errors: Readonly<Record<string, string>> };
}

export interface WireView {
	id: string;
	component: string;
	state: unknown;
}

export interface ClientSnapshot {
	app: CodingAgentSnapshot;
	views: readonly WireView[];
}

export type SessionRequest =
	| { type: "submit"; input: string }
	| { type: "invoke_action"; id: AppKeybinding }
	| { type: "view_message"; viewId: string; message: unknown };

export type ClientWireMessage =
	| { type: "hello"; clientId: string }
	| { type: "request"; id: number; request: SessionRequest };

export type ServerWireMessage =
	| { type: "snapshot"; snapshot: ClientSnapshot }
	| { type: "event"; event: CodingAgentEvent }
	| { type: "view_updated"; view: WireView }
	| { type: "view_closed"; viewId: string }
	| { type: "response"; id: number; error?: string };
