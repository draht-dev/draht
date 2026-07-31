import type { ImageContent, TextContent, Usage } from "@draht/ai";
import type { AgentMessage } from "../../types.js";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.js";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	LeafEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionContext,
	SessionEntryCursorOptions,
	SessionInfoEntry,
	SessionMetadata,
	SessionSnapshot,
	SessionStats,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];

export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;

export interface SessionContextBuildOptions {
	/** Additional entry transforms applied after the default compaction transform. */
	entryTransforms?: readonly ContextEntryTransform[];
	/** Optional custom-entry projectors. Custom entries are omitted from model context by default. */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	return { thinkingLevel, model, activeToolNames };
}

export function defaultContextEntryTransform(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}
	if (!compaction) {
		return [...pathEntries];
	}

	const entries: SessionTreeEntry[] = [compaction];
	const compactionIdx = pathEntries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	if (compaction.retainedTail) {
		for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
			entries.push(pathEntries[i]!);
		}
		return entries;
	}
	if (compaction.firstKeptEntryId) {
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = pathEntries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) entries.push(entry);
		}
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
}

export function buildContextEntries(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionTreeEntry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) {
		entries = [...transform(entries)];
	}
	return entries;
}

export function sessionEntryToContextMessages(
	entry: SessionTreeEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	if (entry.type === "message") {
		return [entry.message as AgentMessage];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content as string | (TextContent | ImageContent)[],
				entry.display,
				entry.details,
				entry.timestamp,
			),
		];
	}
	if (entry.type === "compaction") {
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...(entry.retainedTail ?? []),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

export function buildSessionContext(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}

export interface SessionDependencies<TMetadata extends SessionMetadata = SessionMetadata> {
	metadata: TMetadata;
	load(): Promise<SessionSnapshot<TMetadata>>;
	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionTreeEntry): Promise<void>;
	setLeafId(leafId: string | null): Promise<LeafEntry>;
	storage?: SessionStorage<TMetadata>;
}

function entriesById(entries: readonly SessionTreeEntry[]): Map<string, SessionTreeEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

function getPathToRootOrCompaction(entries: readonly SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const byId = entriesById(entries);
	const path: SessionTreeEntry[] = [];
	let stopAtEntryId: string | null = null;
	let current = byId.get(leafId);
	if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
	while (current) {
		path.unshift(current);
		if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
		if (current.type === "compaction") {
			if (current.retainedTail) break;
			stopAtEntryId = current.firstKeptEntryId ?? null;
		}
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
		current = parent;
	}
	return path;
}

function getLabel(entries: readonly SessionTreeEntry[], id: string): string | undefined {
	let label: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "label" || entry.targetId !== id) continue;
		const trimmed = entry.label?.trim();
		label = trimmed || undefined;
	}
	return label;
}

function getSessionName(entries: readonly SessionTreeEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

function getSessionStats(entries: readonly SessionTreeEntry[]): SessionStats {
	let messageCount = 0;
	let cachedTokens = 0;
	let uncachedTokens = 0;
	let totalTokens = 0;
	let costTotal = 0;
	for (const entry of entries) {
		if (entry.type === "message") messageCount += 1;
		const usage =
			entry.type === "message"
				? entry.message.role === "assistant"
					? entry.message.usage
					: undefined
				: entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: undefined;
		if (
			!usage ||
			typeof usage.input !== "number" ||
			typeof usage.output !== "number" ||
			typeof usage.cacheRead !== "number" ||
			typeof usage.cacheWrite !== "number" ||
			typeof usage.cost?.total !== "number"
		) {
			continue;
		}
		cachedTokens += usage.cacheRead;
		uncachedTokens += usage.input + usage.cacheWrite;
		totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		costTotal += usage.cost.total;
	}
	return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
}

function storageToDependencies<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
): SessionDependencies<TMetadata> {
	let metadata: TMetadata | undefined;
	return {
		get metadata() {
			if (!metadata) {
				throw new SessionError("storage", "Session metadata has not been loaded yet");
			}
			return metadata;
		},
		async load() {
			metadata = await storage.getMetadata();
			return {
				metadata,
				leafId: await storage.getLeafId(),
				entries: await storage.getEntries(),
			};
		},
		getEntries: (options) => storage.getEntries(options),
		createEntryId: () => storage.createEntryId(),
		appendEntry: (entry) => storage.appendEntry(entry),
		setLeafId: (leafId) => storage.setLeafId(leafId),
		storage,
	} as SessionDependencies<TMetadata>;
}

function createStorageAdapter<TMetadata extends SessionMetadata>(
	dependencies: SessionDependencies<TMetadata>,
): SessionStorage<TMetadata> {
	return {
		async getMetadata() {
			return (await dependencies.load()).metadata;
		},
		async getLeafId() {
			return (await dependencies.load()).leafId;
		},
		setLeafId: (leafId) => dependencies.setLeafId(leafId),
		createEntryId: () => dependencies.createEntryId(),
		appendEntry: (entry) => dependencies.appendEntry(entry),
		async getEntry(id) {
			return entriesById((await dependencies.load()).entries).get(id);
		},
		async findEntries(type) {
			return (await dependencies.load()).entries.filter(
				(entry): entry is Extract<SessionTreeEntry, { type: typeof type }> => entry.type === type,
			);
		},
		async getLabel(id) {
			return getLabel((await dependencies.load()).entries, id);
		},
		async getSessionName() {
			return getSessionName((await dependencies.load()).entries);
		},
		async getSessionStats() {
			return getSessionStats((await dependencies.load()).entries);
		},
		async getPathToRootOrCompaction(leafId) {
			return getPathToRootOrCompaction((await dependencies.load()).entries, leafId);
		},
		getEntries: (options) => dependencies.getEntries(options),
	};
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly dependencies: SessionDependencies<TMetadata>;
	private readonly storageAdapter: SessionStorage<TMetadata>;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(
		storageOrDependencies: SessionStorage<TMetadata> | SessionDependencies<TMetadata>,
		contextBuildOptions: SessionContextBuildOptions = {},
	) {
		this.dependencies =
			"load" in storageOrDependencies ? storageOrDependencies : storageToDependencies(storageOrDependencies);
		this.storageAdapter = this.dependencies.storage ?? createStorageAdapter(this.dependencies);
		this.contextBuildOptions = contextBuildOptions;
	}

	async getMetadata(): Promise<TMetadata> {
		return (await this.dependencies.load()).metadata;
	}

	/** Prefer the Session facade methods. Exposed for low-level adapter compatibility. */
	getStorage(): SessionStorage<TMetadata> {
		return this.storageAdapter;
	}

	async getLeafId(): Promise<string | null> {
		return (await this.dependencies.load()).leafId;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return entriesById((await this.dependencies.load()).entries).get(id);
	}

	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return this.dependencies.getEntries(options);
	}

	async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
		const state = await this.dependencies.load();
		return getPathToRootOrCompaction(state.entries, fromId ?? state.leafId);
	}

	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}

	async getLabel(id: string): Promise<string | undefined> {
		return getLabel((await this.dependencies.load()).entries, id);
	}

	async getSessionStats(): Promise<SessionStats> {
		return getSessionStats((await this.dependencies.load()).entries);
	}

	async getSessionName(): Promise<string | undefined> {
		return getSessionName((await this.dependencies.load()).entries);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.dependencies.appendEntry(entry);
	}

	setLeafId(leafId: string | null): Promise<LeafEntry> {
		return this.dependencies.setLeafId(leafId);
	}

	private async createEntryId(): Promise<string> {
		return this.dependencies.createEntryId();
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
		await this.appendEntry(entry);
		return entry.id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry({
			type: "thinking_level_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		} satisfies ThinkingLevelChangeEntry);
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry({
			type: "model_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		} satisfies ModelChangeEntry);
	}

	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry({
			type: "active_tools_change",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			activeToolNames: [...activeToolNames],
		} satisfies ActiveToolsChangeEntry);
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | undefined,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		retainedTail?: AgentMessage[],
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			retainedTail,
			details,
			usage,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry({
			type: "label",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		} satisfies LabelEntry);
	}

	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry({
			type: "session_info",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		} satisfies SessionInfoEntry);
	}

	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; usage?: Usage; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.setLeafId(entryId);
		if (!summary) return undefined;
		return this.appendTypedEntry({
			type: "branch_summary",
			id: await this.createEntryId(),
			parentId: entryId,
			timestamp: new Date().toISOString(),
			fromId: entryId ?? "root",
			summary: summary.summary,
			details: summary.details,
			usage: summary.usage,
			fromHook: summary.fromHook,
		} satisfies BranchSummaryEntry);
	}
}
