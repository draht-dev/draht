import { type ImageContent, type TextContent, type Usage, uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
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
	SessionStore,
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

class SessionEntryIndex {
	private readonly entries: SessionTreeEntry[];
	private readonly byId: Map<string, SessionTreeEntry>;
	private readonly labelsById = new Map<string, string>();
	private leafId: string | null = null;

	constructor(entries: readonly SessionTreeEntry[]) {
		this.entries = [...entries];
		this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
		for (const entry of this.entries) this.applyProjection(entry);
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
	}

	getLeafId(): string | null {
		return this.leafId;
	}
	getEntry(id: string): SessionTreeEntry | undefined {
		return this.byId.get(id);
	}

	getEntries(options?: SessionEntryCursorOptions): SessionTreeEntry[] {
		if (options?.limit === undefined) return [...this.entries];
		const end = options.afterEntrySeq ?? this.entries.length;
		return this.entries.slice(Math.max(0, end - options.limit), end);
	}

	append(entry: SessionTreeEntry): void {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.applyProjection(entry);
	}

	assertCanAppend(entry: SessionTreeEntry): void {
		if (this.byId.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
	}

	createEntryId(): string {
		for (let i = 0; i < 100; i++) {
			const id = uuidv7().slice(-8);
			if (!this.byId.has(id)) return id;
		}
		return uuidv7();
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	getSessionName(): string | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i]!;
			if (entry.type === "session_info") return entry.name?.trim() || undefined;
		}
		return undefined;
	}

	getSessionStats(): SessionStats {
		let messageCount = 0;
		let cachedTokens = 0;
		let uncachedTokens = 0;
		let totalTokens = 0;
		let costTotal = 0;
		for (const entry of this.entries) {
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
			)
				continue;
			cachedTokens += usage.cacheRead;
			uncachedTokens += usage.input + usage.cacheWrite;
			totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			costTotal += usage.cost.total;
		}
		return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
	}

	getPathToRootOrCompaction(leafId: string | null): SessionTreeEntry[] {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	private applyProjection(entry: SessionTreeEntry): void {
		this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
		if (entry.type !== "label") return;
		const label = entry.label?.trim();
		if (label) this.labelsById.set(entry.targetId, label);
		else this.labelsById.delete(entry.targetId);
	}
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly store: Pick<SessionStore<TMetadata>, "appendEntry">;
	private readonly metadata: TMetadata;
	private readonly index: SessionEntryIndex;
	private readonly contextBuildOptions: SessionContextBuildOptions;
	private appendTail: Promise<void> = Promise.resolve();

	constructor(
		store: Pick<SessionStore<TMetadata>, "appendEntry">,
		snapshot: SessionSnapshot<TMetadata>,
		contextBuildOptions: SessionContextBuildOptions = {},
	) {
		this.store = store;
		this.metadata = snapshot.metadata;
		this.index = new SessionEntryIndex(snapshot.entries);
		this.contextBuildOptions = contextBuildOptions;
	}

	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}
	async getLeafId(): Promise<string | null> {
		return this.index.getLeafId();
	}
	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.index.getEntry(id);
	}
	async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return this.index.getEntries(options);
	}

	async getBranch(fromId?: string | null): Promise<SessionTreeEntry[]> {
		return this.index.getPathToRootOrCompaction(fromId === undefined ? this.index.getLeafId() : fromId);
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
		return this.index.getLabel(id);
	}
	async getSessionStats(): Promise<SessionStats> {
		return this.index.getSessionStats();
	}
	async getSessionName(): Promise<string | undefined> {
		return this.index.getSessionName();
	}

	private enqueueAppend<TEntry extends SessionTreeEntry>(
		createEntry: (base: Pick<SessionTreeEntry, "id" | "parentId" | "timestamp">) => TEntry,
	): Promise<TEntry> {
		const operation = this.appendTail.then(async () => {
			const entry = createEntry({
				id: this.index.createEntryId(),
				parentId: this.index.getLeafId(),
				timestamp: new Date().toISOString(),
			});
			this.index.assertCanAppend(entry);
			await this.store.appendEntry(this.metadata, entry);
			this.index.append(entry);
			return entry;
		});
		this.appendTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private setLeafId(leafId: string | null): Promise<LeafEntry> {
		return this.enqueueAppend((base) => {
			if (leafId !== null && !this.index.getEntry(leafId)) {
				throw new SessionError("not_found", `Entry ${leafId} not found`);
			}
			return { ...base, type: "leaf", targetId: leafId };
		});
	}

	private async appendTypedEntry<TEntry extends SessionTreeEntry>(
		createEntry: (base: Pick<SessionTreeEntry, "id" | "parentId" | "timestamp">) => TEntry,
	): Promise<string> {
		return (await this.enqueueAppend(createEntry)).id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "message",
					message,
				}) satisfies MessageEntry,
		);
	}

	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "thinking_level_change",
					thinkingLevel,
				}) satisfies ThinkingLevelChangeEntry,
		);
	}

	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "model_change",
					provider,
					modelId,
				}) satisfies ModelChangeEntry,
		);
	}

	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "active_tools_change",
					activeToolNames: [...activeToolNames],
				}) satisfies ActiveToolsChangeEntry,
		);
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
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "compaction",
					summary,
					firstKeptEntryId,
					tokensBefore,
					retainedTail,
					details,
					usage,
					fromHook,
				}) satisfies CompactionEntry<T>,
		);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "custom",
					customType,
					data,
				}) satisfies CustomEntry,
		);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "custom_message",
					customType,
					content,
					display,
					details,
				}) satisfies CustomMessageEntry<T>,
		);
	}

	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "label",
					targetId,
					label,
				}) satisfies LabelEntry,
		);
	}

	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "session_info",
					name: sanitizedName,
				}) satisfies SessionInfoEntry,
		);
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
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "branch_summary",
					fromId: entryId ?? "root",
					summary: summary.summary,
					details: summary.details,
					usage: summary.usage,
					fromHook: summary.fromHook,
				}) satisfies BranchSummaryEntry,
		);
	}
}
