import type { JsonRepresentation } from "@draht/chord";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type Stored<T> = JsonRepresentation<T>;

export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export type Id = number;
export type Seq = number;
