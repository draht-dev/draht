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
