export class ServiceHandle {
	readonly #serviceId: string;
	readonly #assertAccess: () => void;
	readonly #methods = new Map<PropertyKey, unknown>();
	readonly proxy: object;
	#implementation: object | undefined;
	#remote = false;

	constructor(serviceId: string, assertAccess: () => void) {
		this.#serviceId = serviceId;
		this.#assertAccess = assertAccess;
		this.proxy = new Proxy(
			{},
			{
				get: (_target, property) => {
					this.#assertAccess();
					if (this.#implementation === undefined) throw new Error(`Service ${this.#serviceId} is disconnected`);
					const value: unknown = Reflect.get(this.#implementation, property, this.#implementation);
					if (this.#remote || typeof value !== "function") return value;
					let method = this.#methods.get(property);
					if (method === undefined) {
						method = (...args: unknown[]) => {
							this.#assertAccess();
							if (this.#implementation === undefined) {
								throw new Error(`Service ${this.#serviceId} is disconnected`);
							}
							const current: unknown = Reflect.get(this.#implementation, property, this.#implementation);
							if (typeof current !== "function") {
								throw new TypeError(`Service ${this.#serviceId}.${String(property)} is not a method`);
							}
							return Reflect.apply(current, this.#implementation, args);
						};
						this.#methods.set(property, method);
					}
					return method;
				},
			},
		);
	}

	bind(implementation: object, remote = false): void {
		this.#implementation = implementation;
		this.#remote = remote;
	}

	unbind(): void {
		this.#implementation = undefined;
		this.#remote = false;
	}
}
