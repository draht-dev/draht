import type { Context } from "@draht/chord";
import type { Address, Element, List, Value } from "./addresses.ts";
import type { Id, JsonValue, Seq } from "./core.ts";
import type { Conversation, Entry } from "./entries.ts";
import {
	type ConversationScan,
	type EntryScan,
	InvalidHistoryPosition,
	type Page,
	type PageQuery,
	type Storage,
	type TaskScan,
	type Write,
} from "./storage.ts";
import type { Task } from "./tasks.ts";

type ValueHistoryWrite =
	| { readonly seq: Seq; readonly type: "set"; readonly value: JsonValue }
	| { readonly seq: Seq; readonly type: "delete" };

type ListHistoryWrite =
	| { readonly seq: Seq; readonly type: "append"; readonly element: Element<JsonValue> }
	| { readonly seq: Seq; readonly type: "remove"; readonly elementId: Id }
	| { readonly seq: Seq; readonly type: "clear" };

type StoredState =
	| { readonly kind: "value"; readonly rewind: false; value?: JsonValue }
	| { readonly kind: "list"; readonly rewind: false; readonly elements: Map<Id, Element<JsonValue>> }
	| { readonly kind: "value"; readonly rewind: true; readonly writes: ValueHistoryWrite[] }
	| { readonly kind: "list"; readonly rewind: true; readonly writes: ListHistoryWrite[] };

type RewindListState = Extract<StoredState, { kind: "list"; rewind: true }>;

interface AddressState {
	value?: Extract<StoredState, { kind: "value" }>;
	list?: Extract<StoredState, { kind: "list" }>;
}

interface NamespaceState {
	unkeyed?: AddressState;
	readonly keyed: Map<string, AddressState>;
}

type ScopeState = Map<string, NamespaceState>;

interface CappedListState {
	readonly state: RewindListState | undefined;
	readonly cap: Seq | undefined;
}

interface StoredEntry {
	readonly seq: Seq;
	readonly entry: Entry;
}

function rewindable(
	address: Address,
): address is Address & { readonly scope: Extract<Address["scope"], { type: "conversation" }>; readonly rewind: true } {
	return address.scope.type === "conversation" && address.rewind;
}

function scopeId(address: Address): Id | undefined {
	if (address.scope.type === "conversation") return address.scope.conversationId;
	if (address.scope.type === "task") return address.scope.taskId;
	if (address.scope.type === "shared") return address.scope.id;
	return undefined;
}

function page<T>(
	values: Iterable<T>,
	query: PageQuery,
	id: (value: T) => Id,
	matches: (value: T) => boolean,
	ascending: boolean,
): Page<T> {
	const items: T[] = [];
	let more = false;
	for (const value of values) {
		const valueId = id(value);
		if (
			!matches(value) ||
			(query.cursor !== undefined && (ascending ? valueId <= query.cursor : valueId >= query.cursor))
		) {
			continue;
		}
		if (items.length === query.limit) {
			more = true;
			break;
		}
		items.push(value);
	}
	return { items, ...(more && items.length > 0 ? { next: id(items.at(-1)!) } : {}) };
}

export class MemoryStorage implements Storage {
	private nextObjectId: Id = 1;
	private nextSeq: Seq = 1;
	private readonly conversations = new Map<Id, Conversation>();
	private readonly entries = new Map<Id, StoredEntry>();
	private readonly entriesByConversation = new Map<Id, StoredEntry[]>();
	private readonly tasks = new Map<Id, Task>();
	private readonly outputReferences = new Map<Id, number>();
	private readonly sessionState: ScopeState = new Map();
	private readonly conversationStickyState = new Map<Id, ScopeState>();
	private readonly conversationRewindableState = new Map<Id, ScopeState>();
	private readonly taskState = new Map<Id, ScopeState>();
	private readonly sharedState = new Map<Id, ScopeState>();

	nextId(): Id {
		return this.nextObjectId++;
	}

	async commit(writes: readonly Write[], _ctx: Context): Promise<readonly Seq[]> {
		const seqs = writes.map((_, index) => this.nextSeq + index);
		const affectedOutputs = new Set<Id>();
		let nextObjectId = this.nextObjectId;
		for (const write of writes) {
			if (write.type === "conversation.create") nextObjectId = Math.max(nextObjectId, write.conversation.id + 1);
			else if (write.type === "entry.append") nextObjectId = Math.max(nextObjectId, write.entry.id + 1);
			else if (write.type === "task.create") nextObjectId = Math.max(nextObjectId, write.task.id + 1);
			else if (write.type === "list.append") nextObjectId = Math.max(nextObjectId, write.element.id + 1);
			if (write.type !== "task.create" && write.type !== "task.set") continue;
			const currentOutput = this.tasks.get(write.task.id)?.output?.id;
			if (currentOutput !== undefined) affectedOutputs.add(currentOutput);
			if (write.task.output !== undefined) affectedOutputs.add(write.task.output.id);
		}
		for (let index = 0; index < writes.length; index++) this.apply(writes[index]!, seqs[index]!);
		for (const write of writes) {
			if (write.type === "task.set" && write.task.status === "terminal") this.taskState.delete(write.task.id);
		}
		for (const id of affectedOutputs) {
			if (!this.outputReferences.has(id)) this.sharedState.delete(id);
		}
		this.nextObjectId = nextObjectId;
		this.nextSeq += writes.length;
		return seqs;
	}

	async getConversations(ids: readonly Id[], _ctx: Context): Promise<ReadonlyMap<Id, Conversation>> {
		const result = new Map<Id, Conversation>();
		for (const id of ids) {
			const conversation = this.conversations.get(id);
			if (conversation !== undefined) result.set(id, conversation);
		}
		return result;
	}

	async scanConversations(query: ConversationScan, _ctx: Context): Promise<Page<Conversation>> {
		return page(
			this.conversations.values(),
			query,
			(conversation) => conversation.id,
			(conversation) =>
				(query.parent === undefined || conversation.parent?.conversationId === query.parent) &&
				(query.owner === undefined || conversation.owner === query.owner),
			true,
		);
	}

	async getEntries(ids: readonly Id[], _ctx: Context): Promise<ReadonlyMap<Id, Entry>> {
		const result = new Map<Id, Entry>();
		for (const id of ids) {
			const stored = this.entries.get(id);
			if (stored !== undefined) result.set(id, stored.entry);
		}
		return result;
	}

	async scanEntries(query: EntryScan, _ctx: Context): Promise<Page<Entry>> {
		return page(
			this.visibleEntries(query.conversationId, query.through),
			query,
			(entry) => entry.id,
			(entry) => query.kind === undefined || entry.kind === query.kind,
			false,
		);
	}

	async newestHead(conversationId: Id, at: Id, _ctx: Context): Promise<Entry | undefined> {
		for (const entry of this.visibleEntries(conversationId, at)) {
			if (entry.head !== undefined) return entry;
		}
		return undefined;
	}

	async getTasks(ids: readonly Id[], _ctx: Context): Promise<ReadonlyMap<Id, Task>> {
		const result = new Map<Id, Task>();
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (task !== undefined) result.set(id, task);
		}
		return result;
	}

	async scanTasks(query: TaskScan, _ctx: Context): Promise<Page<Task>> {
		return page(
			this.tasks.values(),
			query,
			(task) => task.id,
			(task) =>
				(query.conversationIds === undefined || query.conversationIds.includes(task.conversationId)) &&
				(query.statuses === undefined || query.statuses.includes(task.status)) &&
				(query.kind === undefined || task.kind === query.kind) &&
				(query.abort === undefined || (task.abort === true) === query.abort) &&
				(query.outputId === undefined || task.output?.id === query.outputId),
			true,
		);
	}

	async getValue<T extends JsonValue>(address: Value<T>, at: Id | undefined, _ctx: Context): Promise<T | undefined> {
		if (at !== undefined) {
			if (!rewindable(address)) throw new InvalidHistoryPosition(at);
			return this.rewindValue(address, this.historyPosition(address.scope.conversationId, at));
		}
		if (rewindable(address)) return this.rewindValue(address, undefined);
		const state = this.storedState(address);
		return state?.kind === "value" && !state.rewind ? (state.value as T | undefined) : undefined;
	}

	async readList<T extends JsonValue>(
		address: List<T>,
		at: Id | undefined,
		_ctx: Context,
	): Promise<readonly Element<T>[]> {
		if (at !== undefined) {
			if (!rewindable(address)) throw new InvalidHistoryPosition(at);
			return this.rewindListElements(address, this.historyPosition(address.scope.conversationId, at));
		}
		if (rewindable(address)) return this.rewindListElements(address, undefined);
		const state = this.storedState(address);
		if (state?.kind !== "list" || state.rewind) return [];
		return [...(state.elements.values() as Iterable<Element<T>>)];
	}

	private historyPosition(conversationId: Id, at: Id): Seq {
		const stored = this.entries.get(at);
		if (stored === undefined) throw new InvalidHistoryPosition(at);

		let currentId = conversationId;
		let cap: Seq | undefined;
		while (true) {
			if (stored.entry.conversationId === currentId && (cap === undefined || stored.seq <= cap)) return stored.seq;
			const conversation = this.conversations.get(currentId);
			if (conversation?.parent === undefined) throw new InvalidHistoryPosition(at);
			const parentAtSeq = this.entries.get(conversation.parent.at)?.seq;
			if (parentAtSeq === undefined) throw new InvalidHistoryPosition(at);
			cap = Math.min(cap ?? parentAtSeq, parentAtSeq);
			currentId = conversation.parent.conversationId;
		}
	}

	private rewindValue<T extends JsonValue>(address: Value<T>, cap: Seq | undefined): T | undefined {
		let conversationId = address.scope.type === "conversation" ? address.scope.conversationId : undefined;
		while (conversationId !== undefined) {
			const state = this.conversationStoredState(conversationId, address);
			if (state?.kind === "value" && state.rewind) {
				for (let index = state.writes.length - 1; index >= 0; index--) {
					const write = state.writes[index]!;
					if (cap !== undefined && write.seq > cap) continue;
					return write.type === "set" ? (write.value as T) : undefined;
				}
			}
			const conversation = this.conversations.get(conversationId);
			if (conversation?.parent === undefined) return undefined;
			const parentAtSeq = this.historyPosition(conversation.parent.conversationId, conversation.parent.at);
			cap = Math.min(cap ?? parentAtSeq, parentAtSeq);
			conversationId = conversation.parent.conversationId;
		}
		return undefined;
	}

	private rewindListElements<T extends JsonValue>(
		address: List<T> & { readonly scope: Extract<Address["scope"], { type: "conversation" }> },
		cap: Seq | undefined,
	): readonly Element<T>[] {
		const ancestry: CappedListState[] = [];
		let conversationId = address.scope.conversationId;
		while (true) {
			const stored = this.conversationStoredState(conversationId, address);
			ancestry.push({ state: stored?.kind === "list" && stored.rewind ? stored : undefined, cap });
			const conversation = this.conversations.get(conversationId);
			if (conversation?.parent === undefined) break;
			const parentAtSeq = this.historyPosition(conversation.parent.conversationId, conversation.parent.at);
			cap = Math.min(cap ?? parentAtSeq, parentAtSeq);
			conversationId = conversation.parent.conversationId;
		}

		const elements = new Map<Id, Element<T>>();
		for (const segment of ancestry.reverse()) {
			for (const write of segment.state?.writes ?? []) {
				if (segment.cap !== undefined && write.seq > segment.cap) continue;
				if (write.type === "append") elements.set(write.element.id, write.element as Element<T>);
				else if (write.type === "remove") elements.delete(write.elementId);
				else elements.clear();
			}
		}
		return [...elements.values()];
	}

	private *visibleEntries(conversationId: Id, through: Id | undefined): Iterable<Entry> {
		let conversation = this.conversations.get(conversationId);
		let cap = through;
		while (conversation !== undefined) {
			const entries = this.entriesByConversation.get(conversation.id) ?? [];
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index]!.entry;
				if (cap === undefined || entry.id <= cap) yield entry;
			}
			if (conversation.parent === undefined) return;
			cap = Math.min(cap ?? conversation.parent.at, conversation.parent.at);
			conversation = this.conversations.get(conversation.parent.conversationId);
		}
	}

	private apply(write: Write, seq: Seq): void {
		if (write.type === "conversation.create") {
			this.conversations.set(write.conversation.id, write.conversation);
		} else if (write.type === "entry.append") {
			const entry = write.entry;
			const stored = { seq, entry };
			this.entries.set(entry.id, stored);
			const entries = this.entriesByConversation.get(entry.conversationId);
			if (entries === undefined) this.entriesByConversation.set(entry.conversationId, [stored]);
			else entries.push(stored);
		} else if (write.type === "task.create" || write.type === "task.set") {
			const current = this.tasks.get(write.task.id);
			if (current?.status !== "terminal" && current?.output !== undefined)
				this.removeOutputReference(current.output.id);
			this.tasks.set(write.task.id, write.task);
			if (write.task.status !== "terminal" && write.task.output !== undefined) {
				this.outputReferences.set(write.task.output.id, (this.outputReferences.get(write.task.output.id) ?? 0) + 1);
			}
		} else if (write.type === "value.set") {
			const state = this.valueState(write.address);
			if (state.rewind) state.writes.push({ seq, type: "set", value: write.value });
			else state.value = write.value;
		} else if (write.type === "value.delete") {
			const state = this.valueState(write.address);
			if (state.rewind) state.writes.push({ seq, type: "delete" });
			else state.value = undefined;
		} else {
			const state = this.listState(write.address);
			if (state.rewind) {
				if (write.type === "list.append") state.writes.push({ seq, type: "append", element: write.element });
				else if (write.type === "list.remove")
					state.writes.push({ seq, type: "remove", elementId: write.elementId });
				else state.writes.push({ seq, type: "clear" });
			} else if (write.type === "list.append") state.elements.set(write.element.id, write.element);
			else if (write.type === "list.remove") state.elements.delete(write.elementId);
			else state.elements.clear();
		}
	}

	private removeOutputReference(id: Id): void {
		const count = this.outputReferences.get(id)!;
		if (count === 1) this.outputReferences.delete(id);
		else this.outputReferences.set(id, count - 1);
	}

	private storedState(address: Address): StoredState | undefined {
		return this.stateInScope(this.scopeState(address, false), address);
	}

	private conversationStoredState(conversationId: Id, address: Address): StoredState | undefined {
		const scopes = address.rewind ? this.conversationRewindableState : this.conversationStickyState;
		return this.stateInScope(scopes.get(conversationId), address);
	}

	private stateInScope(scope: ScopeState | undefined, address: Address): StoredState | undefined {
		const namespace = scope?.get(address.namespace);
		const state = address.key === undefined ? namespace?.unkeyed : namespace?.keyed.get(address.key);
		return address.kind === "value" ? state?.value : state?.list;
	}

	private valueState(address: Value<JsonValue>): Extract<StoredState, { kind: "value" }> {
		const initial: StoredState = rewindable(address)
			? { kind: "value", rewind: true, writes: [] }
			: { kind: "value", rewind: false };
		return this.ensureState(address, initial) as Extract<StoredState, { kind: "value" }>;
	}

	private listState(address: List<JsonValue>): Extract<StoredState, { kind: "list" }> {
		const initial: StoredState = rewindable(address)
			? { kind: "list", rewind: true, writes: [] }
			: { kind: "list", rewind: false, elements: new Map() };
		return this.ensureState(address, initial) as Extract<StoredState, { kind: "list" }>;
	}

	private ensureState(address: Address, initial: StoredState): StoredState {
		const scope = this.scopeState(address, true)!;
		let namespace = scope.get(address.namespace);
		if (namespace === undefined) {
			namespace = { keyed: new Map() };
			scope.set(address.namespace, namespace);
		}
		let state = address.key === undefined ? namespace.unkeyed : namespace.keyed.get(address.key);
		if (state === undefined) {
			state = {};
			if (address.key === undefined) namespace.unkeyed = state;
			else namespace.keyed.set(address.key, state);
		}
		const stored = address.kind === "value" ? state.value : state.list;
		if (stored !== undefined) return stored;
		if (initial.kind === "value") state.value = initial;
		else state.list = initial;
		return initial;
	}

	private scopeState(address: Address, create: boolean): ScopeState | undefined {
		if (address.scope.type === "session") return this.sessionState;
		const id = scopeId(address)!;
		const scopes =
			address.scope.type === "conversation"
				? address.rewind
					? this.conversationRewindableState
					: this.conversationStickyState
				: address.scope.type === "task"
					? this.taskState
					: this.sharedState;
		let state = scopes.get(id);
		if (state === undefined && create) {
			state = new Map();
			scopes.set(id, state);
		}
		return state;
	}
}
