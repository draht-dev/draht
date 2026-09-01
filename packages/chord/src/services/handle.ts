import { CallTracker } from "./calls.ts";

interface ResolvedValue {
	readonly value: unknown;
	readonly receiver: object;
	readonly calls: CallTracker;
}

interface ServiceTarget {
	readonly implementation: object;
	readonly calls: CallTracker;
}

type ValueResolver = () => ResolvedValue;

/** Host-owned mutable target with consumer-owned guarded views. */
export class ServiceSlot {
	readonly #serviceId: string;
	readonly #wrapObjects: boolean;
	#target: ServiceTarget | undefined;

	constructor(serviceId: string, wrapObjects: boolean) {
		this.#serviceId = serviceId;
		this.#wrapObjects = wrapObjects;
	}

	view<T>(assertAccess: () => void): T {
		return new ServiceView(this, assertAccess, this.#wrapObjects).proxy as T;
	}

	bind(implementation: object): Promise<void> {
		const previous = this.#target;
		this.#target = { implementation, calls: new CallTracker() };
		return previous?.calls.retire() ?? Promise.resolve();
	}

	unbind(): Promise<void> {
		const previous = this.#target;
		this.#target = undefined;
		return previous?.calls.retire() ?? Promise.resolve();
	}

	resolve(property: PropertyKey, assertAccess: () => void): ResolvedValue {
		assertAccess();
		const target = this.#target;
		if (target === undefined) throw new Error(`Service ${this.#serviceId} is disconnected`);
		return {
			value: Reflect.get(target.implementation, property, target.implementation),
			receiver: target.implementation,
			calls: target.calls,
		};
	}
}

class ServiceView {
	readonly #slot: ServiceSlot;
	readonly #assertAccess: () => void;
	readonly #wrapObjects: boolean;
	readonly #members = new Map<PropertyKey, ValueView>();
	readonly proxy: object;

	constructor(slot: ServiceSlot, assertAccess: () => void, wrapObjects: boolean) {
		this.#slot = slot;
		this.#assertAccess = assertAccess;
		this.#wrapObjects = wrapObjects;
		this.proxy = new Proxy(Object.create(null) as object, {
			get: (_target, property) => this.#getMember(property),
		});
	}

	#getMember(property: PropertyKey): unknown {
		const resolve = (): ResolvedValue => this.#slot.resolve(property, this.#assertAccess);
		const current = resolve().value;
		if (!isObject(current) || (typeof current !== "function" && !this.#wrapObjects)) return current;
		let member = this.#members.get(property);
		if (member === undefined) {
			member = new ValueView(resolve, typeof current === "function");
			this.#members.set(property, member);
		}
		return member.proxy;
	}
}

class ValueView {
	readonly #resolve: ValueResolver;
	readonly #children = new Map<PropertyKey, ValueView>();
	readonly proxy: object;

	constructor(resolve: ValueResolver, callable: boolean) {
		this.#resolve = resolve;
		const target: object = callable ? () => undefined : Object.create(null);
		this.proxy = new Proxy(target, {
			apply: (_target, _thisArg, args) => this.#invoke(args),
			get: (_target, property) => this.#get(property),
		});
	}

	#invoke(args: unknown[]): unknown {
		const { value, receiver, calls } = this.#resolve();
		if (typeof value !== "function") throw new TypeError("Service member is not callable");
		return calls.run(() => Reflect.apply(value, receiver, args));
	}

	#get(property: PropertyKey): unknown {
		const resolve = (): ResolvedValue => {
			const parent = this.#resolve();
			if (!isObject(parent.value)) throw new TypeError("Service member does not have properties");
			return {
				value: Reflect.get(parent.value, property, parent.value),
				receiver: parent.value,
				calls: parent.calls,
			};
		};
		const current = resolve().value;
		if (typeof current !== "function") return current;
		let child = this.#children.get(property);
		if (child === undefined) {
			child = new ValueView(resolve, true);
			this.#children.set(property, child);
		}
		return child.proxy;
	}
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}
