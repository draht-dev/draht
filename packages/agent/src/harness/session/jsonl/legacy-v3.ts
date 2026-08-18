import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import type { CommittedWrite } from "../commit.ts";
import { laneLeaf, laneState } from "../values.ts";
import { JSONL_FORMAT_VERSION, JSONL_STORAGE_VERSION, type JsonlStorageHeader } from "./types.ts";

export interface LegacyV3SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

interface LegacyV3MessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

export interface NormalizedLegacyV3 {
	header: JsonlStorageHeader;
	writes: CommittedWrite[];
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

export function normalizeLegacyV3Header(header: LegacyV3SessionHeader): JsonlStorageHeader {
	return {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		id: header.id,
		storageVersion: JSONL_STORAGE_VERSION,
		createdAt: Date.parse(header.timestamp),
		cwd: header.cwd,
		...(header.parentSession === undefined ? {} : { legacyParentSessionPath: header.parentSession }),
	};
}

function parseLegacyV3MessageEntry(line: string, lineNumber: number): LegacyV3MessageEntry {
	let entry: LegacyV3MessageEntry;
	try {
		entry = JSON.parse(line) as LegacyV3MessageEntry;
	} catch (error) {
		throw new Error(`Invalid legacy v3 JSONL record at line ${lineNumber}: not valid JSON`, { cause: error });
	}
	// TODO: Support the remaining legacy v3 record types as their normalization slices are implemented.
	if (entry.type !== "message") {
		throw new Error(`Unsupported legacy v3 record type at line ${lineNumber}: ${String(entry.type)}`);
	}
	return entry;
}

/** Normalize the currently supported message-only v3 slice without touching its source file. */
export function normalizeLegacyV3(header: LegacyV3SessionHeader, recordLines: readonly string[]): NormalizedLegacyV3 {
	const entries = recordLines.map((line, index) => parseLegacyV3MessageEntry(line, index + 2));
	const importedIds = new Map(entries.map((entry) => [entry.id, uuidv7(Date.parse(entry.timestamp))]));

	const writes: CommittedWrite[] = entries.map((entry, index) => ({
		kind: "entry",
		type: "message",
		id: importedIds.get(entry.id)!,
		parentId: entry.parentId === null ? null : importedIds.get(entry.parentId)!,
		seq: index + 1,
		timestamp: Date.parse(entry.timestamp),
		message: entry.message,
	}));
	const leaf = entries.length === 0 ? null : importedIds.get(entries[entries.length - 1]!.id)!;
	const leafAddress = laneLeaf("main");
	writes.push({
		kind: "value",
		op: "set",
		seq: writes.length + 1,
		namespace: leafAddress.namespace,
		key: leafAddress.key,
		value: leaf,
	});
	const stateAddress = laneState("main");
	writes.push({
		kind: "value",
		op: "set",
		seq: writes.length + 1,
		namespace: stateAddress.namespace,
		key: stateAddress.key,
		value: { currentOperationId: null, pendingNextRun: [] },
	});
	const nextSeq = writes.length + 1;
	return {
		header: { ...normalizeLegacyV3Header(header), nextSeq },
		writes,
	};
}
