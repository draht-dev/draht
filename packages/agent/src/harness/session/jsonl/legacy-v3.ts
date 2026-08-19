import { type ImageContent, type TextContent, type Usage, uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../../messages.ts";
import type { CommittedWrite } from "../commit.ts";
import type { JsonValue } from "../types.ts";
import { entryLabel, laneLeaf, laneState, sessionName } from "../values.ts";
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

interface LegacyV3ModelChangeEntry extends LegacyV3EntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

interface LegacyV3ThinkingLevelChangeEntry extends LegacyV3EntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

interface LegacyV3ActiveToolsChangeEntry extends LegacyV3EntryBase {
	type: "active_tools_change";
}

interface LegacyV3SessionInfoEntry extends LegacyV3EntryBase {
	type: "session_info";
	name?: string;
}

interface LegacyV3LabelEntry extends LegacyV3EntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

interface ImportedCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
	timestamp: number;
}

type RetainedLegacyV3Entry =
	| LegacyV3MessageEntry
	| LegacyV3CustomEntry
	| LegacyV3CustomMessageEntry
	| LegacyV3BranchSummaryEntry
	| LegacyV3CompactionEntry;

type DiscardedLegacyV3Entry =
	| LegacyV3ModelChangeEntry
	| LegacyV3ThinkingLevelChangeEntry
	| LegacyV3ActiveToolsChangeEntry
	| LegacyV3SessionInfoEntry
	| LegacyV3LabelEntry;

type LegacyV3Entry = RetainedLegacyV3Entry | DiscardedLegacyV3Entry;

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
		recordType !== "compaction" &&
		recordType !== "model_change" &&
		recordType !== "thinking_level_change" &&
		recordType !== "active_tools_change" &&
		recordType !== "session_info" &&
		recordType !== "label"
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

function isRetainedEntry(entry: LegacyV3Entry): entry is RetainedLegacyV3Entry {
	return (
		entry.type !== "model_change" &&
		entry.type !== "thinking_level_change" &&
		entry.type !== "active_tools_change" &&
		entry.type !== "session_info" &&
		entry.type !== "label"
	);
}

class RetainedIdResolver {
	/** Caches the reminted ID of each discarded legacy node's nearest retained ancestor, or null. */
	private resolvedIds = new Map<string, string | null>();
	private entriesById: Map<string, LegacyV3Entry>;
	private remintedIds: Map<string, string>;

	/**
	 * @param entriesById Complete inventory of legacy physical nodes, including discarded nodes.
	 * @param remintedIds Legacy-to-current ID map containing retained nodes only.
	 */
	constructor(entriesById: Map<string, LegacyV3Entry>, remintedIds: Map<string, string>) {
		this.entriesById = entriesById;
		this.remintedIds = remintedIds;
	}

	/**
	 * Resolve a legacy node to its reminted ID, or to its nearest retained ancestor when discarded.
	 * Returns null when the reference is null or no retained ancestor exists.
	 */
	resolve(legacyId: string | null): string | null {
		const traversedIds: string[] = [];
		const visitedIds = new Set<string>();
		let currentId = legacyId;
		let resolvedId: string | null = null;

		while (currentId !== null) {
			const remintedId = this.remintedIds.get(currentId);
			if (remintedId !== undefined) {
				resolvedId = remintedId;
				break;
			}
			if (this.resolvedIds.has(currentId)) {
				resolvedId = this.resolvedIds.get(currentId) ?? null;
				break;
			}
			if (visitedIds.has(currentId)) throw new Error(`Cycle in legacy v3 parent chain at entry: ${currentId}`);
			visitedIds.add(currentId);
			const entry = this.entriesById.get(currentId);
			if (entry === undefined) throw new Error(`Missing legacy v3 entry reference: ${currentId}`);
			traversedIds.push(currentId);
			currentId = entry.parentId;
		}

		for (const traversedId of traversedIds) this.resolvedIds.set(traversedId, resolvedId);
		return resolvedId;
	}
}

function requireRetainedId(resolver: RetainedIdResolver, legacyId: string): string {
	const importedId = resolver.resolve(legacyId);
	if (importedId === null) throw new Error(`Legacy v3 entry reference has no retained ancestor: ${legacyId}`);
	return importedId;
}

function resolveBranchSummaryFromId(resolver: RetainedIdResolver, legacyFromId: string): string | null {
	// Legacy branchWithSummary() encoded a root source as the "root" sentinel instead of null.
	return legacyFromId === "root" ? null : resolver.resolve(legacyFromId);
}

function projectContextMessages(entry: LegacyV3Entry, resolver: RetainedIdResolver): AgentMessage[] {
	switch (entry.type) {
		case "message":
			return [entry.message];
		case "custom_message":
			return [importedCustomMessage(entry)];
		case "branch_summary":
			return entry.summary
				? [
						createBranchSummaryMessage(
							entry.summary,
							resolveBranchSummaryFromId(resolver, entry.fromId),
							entry.timestamp,
						),
					]
				: [];
		case "compaction":
			return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
		case "custom":
		case "model_change":
		case "thinking_level_change":
		case "active_tools_change":
		case "session_info":
		case "label":
			return [];
	}
}

function materializeRetainedTail(
	compaction: LegacyV3CompactionEntry,
	entriesById: ReadonlyMap<string, LegacyV3Entry>,
	resolver: RetainedIdResolver,
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
			return reversedTail.reverse().flatMap((tailEntry) => projectContextMessages(tailEntry, resolver));
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
	const entriesById = new Map<string, LegacyV3Entry>();
	for (const entry of entries) {
		if (entriesById.has(entry.id)) throw new Error(`Duplicate legacy v3 entry id: ${entry.id}`);
		entriesById.set(entry.id, entry);
	}
	const retainedEntries = entries.filter(isRetainedEntry);
	const remintedIds = new Map(retainedEntries.map((entry) => [entry.id, uuidv7(Date.parse(entry.timestamp))]));
	const retainedIdResolver = new RetainedIdResolver(entriesById, remintedIds);

	const writes: CommittedWrite[] = retainedEntries.map((entry, index): CommittedWrite => {
		const committedBase = {
			kind: "entry" as const,
			id: requireRetainedId(retainedIdResolver, entry.id),
			parentId: retainedIdResolver.resolve(entry.parentId),
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
				fromId: resolveBranchSummaryFromId(retainedIdResolver, entry.fromId),
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
				retainedTail: materializeRetainedTail(entry, entriesById, retainedIdResolver),
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
	let latestSessionInfo: LegacyV3SessionInfoEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "session_info") latestSessionInfo = entry;
	}
	if (latestSessionInfo?.name) {
		writes.push({
			kind: "value",
			op: "set",
			seq: writes.length + 1,
			namespace: sessionName.namespace,
			key: sessionName.key,
			value: latestSessionInfo.name,
		});
	}
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label") continue;
		const targetId = retainedIdResolver.resolve(entry.targetId);
		// TODO: Decide whether labels whose targets normalize to the root should import as root labels.
		if (targetId === null) continue;
		// Legacy v3 treated both undefined and the empty string as clearing a label.
		if (entry.label) labels.set(targetId, entry.label);
		else labels.delete(targetId);
	}
	for (const [targetId, label] of labels) {
		const address = entryLabel(targetId);
		writes.push({
			kind: "value",
			op: "set",
			seq: writes.length + 1,
			namespace: address.namespace,
			key: address.key,
			value: label,
		});
	}
	const finalEntry = entries.at(-1);
	const leaf = finalEntry === undefined ? null : retainedIdResolver.resolve(finalEntry.id);
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
