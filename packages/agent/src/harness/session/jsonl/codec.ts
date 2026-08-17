import { JSONL_FORMAT_VERSION, type JsonlStorageHeader } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeInteger(value: unknown, field: string, minimum: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid JSONL ${field}`);
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
