import { err, ok, type Result } from "../../types.ts";
import { isLegacyV3SessionHeader, type LegacyV3SessionHeader } from "./legacy-v3.ts";
import { JSONL_FORMAT_VERSION, type JsonlStorageHeader } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeInteger(value: unknown, field: string, minimum: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid JSONL ${field}`);
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}

export function isJsonlStorageHeader(value: unknown): value is JsonlStorageHeader {
	return (
		isRecord(value) &&
		value.kind === "header" &&
		value.v === JSONL_FORMAT_VERSION &&
		typeof value.id === "string" &&
		typeof value.cwd === "string" &&
		isSafeIntegerAtLeast(value.storageVersion, 1) &&
		isSafeIntegerAtLeast(value.createdAt, 0) &&
		(value.nextSeq === undefined || isSafeIntegerAtLeast(value.nextSeq, 1)) &&
		(value.parentSessionId === undefined || typeof value.parentSessionId === "string") &&
		(value.legacyParentSessionPath === undefined || typeof value.legacyParentSessionPath === "string")
	);
}

export type JsonlParsedSessionHeader =
	| { format: "v4"; header: JsonlStorageHeader }
	| { format: "v3-legacy"; header: LegacyV3SessionHeader };

export function parseJsonlSessionHeader(line: string): Result<JsonlParsedSessionHeader, Error> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return err(new Error("Invalid JSONL session header: not valid JSON", { cause: error }));
	}
	if (isJsonlStorageHeader(value)) return ok({ format: "v4", header: value });
	if (isLegacyV3SessionHeader(value)) return ok({ format: "v3-legacy", header: value });
	return err(new Error("Unsupported JSONL session header"));
}

export function parseJsonlStorageHeader(line: string): JsonlStorageHeader {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL header: not valid JSON", { cause: error });
	}
	if (!isRecord(value) || value.kind !== "header" || value.v !== JSONL_FORMAT_VERSION) {
		throw new Error("Invalid JSONL header");
	}
	if (typeof value.id !== "string") throw new Error("Invalid JSONL id");
	if (typeof value.cwd !== "string") throw new Error("Invalid JSONL cwd");
	requireSafeInteger(value.storageVersion, "storageVersion", 1);
	requireSafeInteger(value.createdAt, "createdAt", 0);
	if (value.nextSeq !== undefined) requireSafeInteger(value.nextSeq, "nextSeq", 1);
	return value as unknown as JsonlStorageHeader;
}
