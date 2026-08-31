import type { JsonRepresentation, JsonValue } from "./types.ts";

/** Return whether a value is finite strict JSON with plain objects and no cycles. */
export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set<object>(), 0);
}

function check(value: unknown, ancestors: Set<object>, depth: number): boolean {
	if (depth > 512) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		if (ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					!("value" in descriptor) ||
					!check(descriptor.value, ancestors, depth + 1)
				) {
					return false;
				}
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor) || !check(descriptor.value, ancestors, depth + 1)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}

/** Clone one finite plain JavaScript value as strict JSON, omitting undefined object properties. */
export function cloneJsonValue<T>(value: T): JsonRepresentation<T> {
	return clone(value, new Set<object>()) as JsonRepresentation<T>;
}

function clone(value: unknown, ancestors: Set<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("JSON values must contain only finite numbers");
		return value;
	}
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
			throw new TypeError("JSON arrays must not contain extra properties");
		}
		if (ancestors.has(value)) throw new TypeError("JSON values must not contain cycles");
		ancestors.add(value);
		try {
			const result: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined) throw new TypeError("JSON arrays must not contain empty slots");
				if (!descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("JSON arrays must contain only data properties");
				}
				if (descriptor.value === undefined) throw new TypeError("JSON arrays must not contain undefined values");
				result.push(clone(descriptor.value, ancestors));
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value === "object" && value !== null) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("JSON values must contain only plain objects");
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new TypeError("JSON objects must not contain symbol properties");
		}
		if (ancestors.has(value)) throw new TypeError("JSON values must not contain cycles");
		ancestors.add(value);
		try {
			const result: { [key: string]: JsonValue } = {};
			for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
				if (!descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("JSON objects must contain only enumerable data properties");
				}
				if (descriptor.value !== undefined) result[key] = clone(descriptor.value, ancestors);
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	}
	throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}
