export class ServiceHandle {
	readonly #serviceId: string;
	readonly #assertAccess: () => void;
	readonly #members = new Map<PropertyKey, unknown>();
	readonly proxy: object;
	#implementation: object | undefined;

	constructor(serviceId: string, assertAccess: () => void) {
		this.#serviceId = serviceId;
		this.#assertAccess = assertAccess;
		this.proxy = new Proxy(
			{},
			{
				get: (_target, property) => {
					const value = this.#getMember(property);
					if (typeof value !== "function") return value;
					let member = this.#members.get(property);
					if (member === undefined) {
						const invoke = (...args: unknown[]): unknown => {
							const implementation = this.#implementation;
							const current = this.#getMember(property);
							if (typeof current !== "function") {
								throw new TypeError(`Service ${this.#serviceId}.${String(property)} is not callable`);
							}
							return Reflect.apply(current, implementation, args);
						};
						member = new Proxy(invoke, {
							get: (_target, memberProperty) => {
								const current = this.#getMember(property);
								if (typeof current !== "function") {
									throw new TypeError(`Service ${this.#serviceId}.${String(property)} is not callable`);
								}
								return Reflect.get(current, memberProperty, current);
							},
						});
						this.#members.set(property, member);
					}
					return member;
				},
			},
		);
	}

	bind(implementation: object): void {
		this.#implementation = implementation;
	}

	unbind(): void {
		this.#implementation = undefined;
	}

	#getMember(property: PropertyKey): unknown {
		this.#assertAccess();
		if (this.#implementation === undefined) throw new Error(`Service ${this.#serviceId} is disconnected`);
		return Reflect.get(this.#implementation, property, this.#implementation);
	}
}
