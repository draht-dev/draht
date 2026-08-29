const instanceKeys = new WeakMap<object, string>();

export function registerServiceInstance(service: object, key: string): void {
	instanceKeys.set(service, key);
}

/** Return the application key for a keyed service proxy, or undefined for a singleton. */
export function getServiceInstanceKey(service: object): string | undefined {
	return instanceKeys.get(service);
}
