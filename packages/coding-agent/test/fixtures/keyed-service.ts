import { type Context, defineRemoteService, type RemoteState } from "@draht/agent-core";

export interface KeyedProbeService {
	readonly state: RemoteState<{ value: string }>;
	replace(value: string, context: Context): Promise<void>;
	wait(context: Context): Promise<void>;
}

export const KeyedProbe = defineRemoteService<KeyedProbeService>("test.keyed-probe");
