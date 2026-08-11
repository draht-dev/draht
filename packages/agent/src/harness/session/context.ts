import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import type { CompactionEntry, CustomEntry, Entry } from "./types.ts";

export interface SessionContext {
	messages: AgentMessage[];
}

export type ContextEntryTransform = (entries: readonly Entry[]) => readonly Entry[];

export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly Entry[],
) => readonly AgentMessage[] | undefined;

export interface SessionContextBuildOptions {
	entryTransforms?: readonly ContextEntryTransform[];
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

export function defaultContextEntryTransform(pathEntries: readonly Entry[]): Entry[] {
	let compaction: CompactionEntry | undefined;
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index];
		if (entry?.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

export function buildContextEntries(pathEntries: readonly Entry[], options: SessionContextBuildOptions = {}): Entry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) entries = [...transform(entries)];
	return entries;
}

export function sessionEntryToContextMessages(
	entry: Entry,
	index: number,
	entries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	switch (entry.type) {
		case "message":
			if (
				entry.message.role === "assistant" &&
				(entry.message.stopReason === "error" ||
					entry.message.stopReason === "aborted" ||
					entry.message.stopReason === "deferred")
			) {
				return [];
			}
			return [entry.message];
		case "compaction":
			return [
				createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
				...entry.retainedTail,
			];
		case "branch_summary":
			return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
		case "custom":
			return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
}

export function buildSessionContext(
	pathEntries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const contextEntries = buildContextEntries(pathEntries, options);
	return {
		messages: contextEntries.flatMap((entry, index) =>
			sessionEntryToContextMessages(entry, index, contextEntries, options),
		),
	};
}
