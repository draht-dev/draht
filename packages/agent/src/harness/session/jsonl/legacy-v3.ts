import { type ImageContent, type TextContent, type Usage, uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import type { CommittedWrite } from "../commit.ts";
import type { JsonValue } from "../types.ts";
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

interface LegacyV3EntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

interface LegacyV3MessageEntry extends LegacyV3EntryBase {
	type: "message";
	message: AgentMessage;
}

interface LegacyV3CustomEntry extends LegacyV3EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

interface LegacyV3CustomMessageEntry extends LegacyV3EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

interface LegacyV3BranchSummaryEntry extends LegacyV3EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook?: boolean;
}

interface ImportedCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
	timestamp: number;
}

type LegacyV3Entry =
	| LegacyV3MessageEntry
	| LegacyV3CustomEntry
	| LegacyV3CustomMessageEntry
	| LegacyV3BranchSummaryEntry;

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

function parseLegacyV3Entry(line: string, lineNumber: number): LegacyV3Entry {
	let entry: LegacyV3Entry;
	try {
		entry = JSON.parse(line) as LegacyV3Entry;
	} catch (error) {
		throw new Error(`Invalid legacy v3 JSONL record at line ${lineNumber}: not valid JSON`, { cause: error });
	}
	const recordType: unknown = entry.type;
	// TODO: Support the remaining legacy v3 record types as their normalization slices are implemented.
	if (
		recordType !== "message" &&
		recordType !== "custom" &&
		recordType !== "custom_message" &&
		recordType !== "branch_summary"
	) {
		throw new Error(`Unsupported legacy v3 record type at line ${lineNumber}: ${String(recordType)}`);
	}
	return entry;
}

/** Normalize the currently supported v3 entries without touching their source file. */
export function normalizeLegacyV3(header: LegacyV3SessionHeader, recordLines: readonly string[]): NormalizedLegacyV3 {
	const entries = recordLines.map((line, index) => parseLegacyV3Entry(line, index + 2));
	const importedIds = new Map(entries.map((entry) => [entry.id, uuidv7(Date.parse(entry.timestamp))]));

	const writes: CommittedWrite[] = entries.map((entry, index): CommittedWrite => {
		const committedBase = {
			kind: "entry" as const,
			id: importedIds.get(entry.id)!,
			parentId: entry.parentId === null ? null : importedIds.get(entry.parentId)!,
			seq: index + 1,
			timestamp: Date.parse(entry.timestamp),
		};
		if (entry.type === "message") {
			return { ...committedBase, type: "message", message: entry.message };
		}
		if (entry.type === "custom_message") {
			const message: ImportedCustomMessage = {
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				details: entry.details,
				display: entry.display,
				timestamp: committedBase.timestamp,
			};
			// The coding-agent CustomAgentMessages declaration merge is not visible in this package.
			return { ...committedBase, type: "message", message: message as unknown as AgentMessage };
		}
		if (entry.type === "branch_summary") {
			return {
				...committedBase,
				type: "branch_summary",
				fromId: importedIds.get(entry.fromId)!,
				summary: entry.summary,
				details: entry.details,
				usage: entry.usage,
				fromHook: entry.fromHook ?? false,
			};
		}
		return {
			...committedBase,
			type: "custom",
			customType: entry.customType,
			data: entry.data,
		};
	});
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
