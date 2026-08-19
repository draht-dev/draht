import { type ImageContent, type TextContent, type Usage, uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../../messages.ts";
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

interface LegacyV3CompactionEntry extends LegacyV3EntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
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
	| LegacyV3BranchSummaryEntry
	| LegacyV3CompactionEntry;

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
		recordType !== "branch_summary" &&
		recordType !== "compaction"
	) {
		throw new Error(`Unsupported legacy v3 record type at line ${lineNumber}: ${String(recordType)}`);
	}
	return entry;
}

function importedCustomMessage(entry: LegacyV3CustomMessageEntry): AgentMessage {
	const message: ImportedCustomMessage = {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		details: entry.details,
		display: entry.display,
		timestamp: Date.parse(entry.timestamp),
	};
	// The coding-agent CustomAgentMessages declaration merge is not visible in this package.
	return message as unknown as AgentMessage;
}

function requireRemintedId(remintedIds: ReadonlyMap<string, string>, legacyId: string): string {
	const importedId = remintedIds.get(legacyId);
	if (importedId === undefined) throw new Error(`Missing legacy v3 entry reference: ${legacyId}`);
	return importedId;
}

function projectContextMessages(entry: LegacyV3Entry, remintedIds: ReadonlyMap<string, string>): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return [entry.message];
		case "custom_message":
			return [importedCustomMessage(entry)];
		case "branch_summary":
			return entry.summary
				? [createBranchSummaryMessage(entry.summary, requireRemintedId(remintedIds, entry.fromId), entry.timestamp)]
				: [];
		case "compaction":
			return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
		case "custom":
			return [];
	}
}

function materializeRetainedTail(
	compaction: LegacyV3CompactionEntry,
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	remintedIds: ReadonlyMap<string, string>,
): AgentMessage[] {
	const reversedTail: LegacyV3Entry[] = [];
	const visited = new Set<string>();
	let currentId = compaction.parentId;
	while (currentId !== null) {
		if (visited.has(currentId)) throw new Error(`Cycle in legacy v3 parent chain at entry: ${currentId}`);
		visited.add(currentId);
		const entry = entriesById.get(currentId);
		if (entry === undefined) throw new Error(`Missing legacy v3 parent entry: ${currentId}`);
		reversedTail.push(entry);
		if (currentId === compaction.firstKeptEntryId) {
			return reversedTail.reverse().flatMap((tailEntry) => projectContextMessages(tailEntry, remintedIds));
		}
		currentId = entry.parentId;
	}
	throw new Error(
		`Legacy v3 compaction ${compaction.id} firstKeptEntryId is not on its parent branch: ${compaction.firstKeptEntryId}`,
	);
}

/** Normalize the currently supported v3 entries without touching their source file. */
export function normalizeLegacyV3(header: LegacyV3SessionHeader, recordLines: readonly string[]): NormalizedLegacyV3 {
	const entries = recordLines.map((line, index) => parseLegacyV3Entry(line, index + 2));
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const remintedIds = new Map(entries.map((entry) => [entry.id, uuidv7(Date.parse(entry.timestamp))]));

	const writes: CommittedWrite[] = entries.map((entry, index): CommittedWrite => {
		const committedBase = {
			kind: "entry" as const,
			id: requireRemintedId(remintedIds, entry.id),
			parentId: entry.parentId === null ? null : requireRemintedId(remintedIds, entry.parentId),
			seq: index + 1,
			timestamp: Date.parse(entry.timestamp),
		};
		if (entry.type === "message") {
			return { ...committedBase, type: "message", message: entry.message };
		}
		if (entry.type === "custom_message") {
			return { ...committedBase, type: "message", message: importedCustomMessage(entry) };
		}
		if (entry.type === "branch_summary") {
			return {
				...committedBase,
				type: "branch_summary",
				fromId: requireRemintedId(remintedIds, entry.fromId),
				summary: entry.summary,
				details: entry.details,
				usage: entry.usage,
				fromHook: entry.fromHook ?? false,
			};
		}
		if (entry.type === "compaction") {
			return {
				...committedBase,
				type: "compaction",
				summary: entry.summary,
				retainedTail: materializeRetainedTail(entry, entriesById, remintedIds),
				tokensBefore: entry.tokensBefore,
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
	const finalEntry = entries.at(-1);
	const leaf = finalEntry === undefined ? null : requireRemintedId(remintedIds, finalEntry.id);
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
