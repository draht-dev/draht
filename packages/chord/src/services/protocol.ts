import type { Context } from "../context.ts";
import type { JsonValue } from "../json.ts";
import type { ServiceMode } from "./contracts.ts";

// TODO: check if this should be part of Chord.
export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly value: JsonValue };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly value: JsonValue;
	  }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	/** Borrowed immutable values. Chord validates but does not clone them. */
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

/**
 * Pluggable wire boundary consumed by a remote service binding.
 *
 * Implementations choose transport, framing, routing, and envelope encoding. Values crossing this
 * boundary must remain strict JSON. Chord does not clone values or require a particular application wire protocol;
 * adapters own serialization and any isolation copies they require.
 */
export interface RemoteServiceConnection {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}
