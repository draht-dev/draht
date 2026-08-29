import type { RemoteServiceConnection } from "../src/index.ts";
import type { RemoteServiceProvider } from "../src/services/provider.ts";
import { serviceDeliveryContext } from "../src/services/state.ts";

export function createLoopbackServiceConnection(provider: RemoteServiceProvider): RemoteServiceConnection {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, (update) =>
				listener(update, serviceDeliveryContext()),
			);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
