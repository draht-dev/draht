import { JSONL_STORAGE_VERSION, type JsonlSessionMetadata } from "./types.ts";

export interface LegacyV3SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLegacyV3SessionHeader(value: unknown): value is LegacyV3SessionHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		value.version === 3 &&
		typeof value.id === "string" &&
		typeof value.cwd === "string" &&
		typeof value.timestamp === "string" &&
		Number.isFinite(Date.parse(value.timestamp)) &&
		(value.parentSession === undefined || typeof value.parentSession === "string")
	);
}

export function parseLegacyV3SessionHeader(line: string): LegacyV3SessionHeader {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid legacy v3 JSONL header: not valid JSON", { cause: error });
	}
	if (!isLegacyV3SessionHeader(value)) throw new Error("Invalid legacy v3 JSONL header");
	return value;
}

export function metadataFromLegacyV3Header(
	header: LegacyV3SessionHeader,
	path: string,
	modifiedAt: number,
): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: Date.parse(header.timestamp),
		storageVersion: JSONL_STORAGE_VERSION,
		cwd: header.cwd,
		path,
		modifiedAt,
		...(header.parentSession === undefined ? {} : { legacyParentSessionPath: header.parentSession }),
	};
}
