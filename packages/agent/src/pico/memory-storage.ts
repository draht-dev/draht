import type { Context, JsonValue } from "@draht/chord";
import type {
	ConversationRecord,
	Cursor,
	EntryQuery,
	EntryRecord,
	Id,
	Input,
	Page,
	Seq,
	Storage,
	StorageWrite,
	TaskQuery,
	TaskRecord,
} from "./types.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "input";

type State = {
	conversations: Map<Id, ConversationRecord>;
	entries: Map<Id, EntryRecord>;
	entryCommits: Map<Id, Seq>;
	tasks: Map<Id, StoredTask>;
	inputs: Map<Id, Input>;
};

/** Clone trusted JSON containers while sharing immutable primitives. */
const clone = <T>(value: T): T => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	const source = value as Record<string, unknown>;
	const nullPrototype = Object.getPrototypeOf(value) === null;
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const copied = clone(source[key]);
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			result[key] = copied;
		}
	}
	return result as T;
};

const cursorId = (cursor: Readonly<Record<string, JsonValue>> | undefined): Id | undefined =>
	cursor?.after as Id | undefined;

const tableContaining = (state: State, id: Id): TableName | undefined => {
	if (state.conversations.has(id)) return "conversation";
	if (state.entries.has(id)) return "entry";
	if (state.tasks.has(id)) return "task";
	if (state.inputs.has(id)) return "input";
	return undefined;
};

const page = <T extends { readonly id: Id }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items: clone(items) };
	return { items: clone(items), next: { after: items.at(-1)!.id } };
};

export class MemoryStorage implements Storage {
	private readonly state: State = {
		conversations: new Map(),
		entries: new Map(),
		entryCommits: new Map(),
		tasks: new Map(),
		inputs: new Map(),
	};
	private nextId = 2;
	private nextSeq = 1;
	private closed = false;

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const prepared = writes.map((write) => clone(write));
		this.checkImmutableIds(prepared);
		const seq = this.nextSeq;

		for (const write of prepared) {
			switch (write.type) {
				case "conversation":
					this.state.conversations.set(write.value.id, write.value);
					break;
				case "entry":
					this.state.entries.set(write.value.id, write.value);
					this.state.entryCommits.set(write.value.id, seq);
					break;
				case "task":
					this.state.tasks.set(write.value.id, write.value);
					break;
				case "input":
					this.state.inputs.set(write.value.id, write.value);
					break;
			}
			this.nextId = Math.max(this.nextId, write.value.id + 1);
		}
		this.nextSeq++;
		return seq;
	}

	mintId(): Id {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++;
	}

	async conversation(id: Id, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const values = [...this.state.conversations.values()]
			.filter((value) => after === undefined || value.id > after)
			.sort((left, right) => left.id - right.id);
		return page(values, limit);
	}

	async entries(ids: readonly Id[], _context: Context): Promise<ReadonlyMap<Id, EntryRecord>> {
		this.assertOpen();
		const result = new Map<Id, EntryRecord>();
		for (const id of ids) {
			const value = this.state.entries.get(id);
			if (value !== undefined) result.set(id, clone(value));
		}
		return result;
	}

	async scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		if (!this.state.conversations.has(query.conversationId)) {
			throw new Error(`Unknown conversation: ${query.conversationId}`);
		}
		const beforeCursor = cursorId(cursor);
		const visible: EntryRecord[] = [];
		let currentId = query.conversationId;
		let upperEntryId = Number.POSITIVE_INFINITY;
		const visited = new Set<Id>();
		while (true) {
			if (visited.has(currentId)) throw new Error("Conversation parent cycle");
			visited.add(currentId);
			for (const entry of this.state.entries.values()) {
				if (entry.conversationId !== currentId || entry.id > upperEntryId) continue;
				if (query.before !== undefined && entry.id >= query.before) continue;
				if (beforeCursor !== undefined && entry.id >= beforeCursor) continue;
				if (query.kind !== undefined && entry.kind !== query.kind) continue;
				if (query.withHead === true && entry.head === undefined) continue;
				visible.push(entry);
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			currentId = conversation.parent.conversationId;
		}
		visible.sort((left, right) => right.id - left.id);
		return page(visible, limit);
	}

	async entryCommit(id: Id, _context: Context): Promise<Seq | undefined> {
		this.assertOpen();
		return this.state.entryCommits.get(id);
	}

	async task(id: Id, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const after = cursorId(cursor);
		const values = [...this.state.tasks.values()]
			.filter((value) => after === undefined || value.id > after)
			.filter((value) => query.conversationId === undefined || value.conversationId === query.conversationId)
			.filter((value) => query.kind === undefined || value.kind === query.kind)
			.filter((value) => query.status === undefined || value.state.status === query.status)
			.filter((value) => query.abortRequested === undefined || value.abortRequested === query.abortRequested)
			.filter((value) => query.background === undefined || value.background === query.background)
			.sort((left, right) => left.id - right.id);
		return page(values, limit);
	}

	async input(id: Id, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		const value = this.state.inputs.get(id);
		return value === undefined ? undefined : clone(value);
	}

	async inputByRequest(conversationId: Id, requestId: string, _context: Context): Promise<Input | undefined> {
		this.assertOpen();
		for (const value of this.state.inputs.values()) {
			if (value.conversationId === conversationId && value.requestId === requestId) return clone(value);
		}
		return undefined;
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	private checkImmutableIds(writes: readonly StorageWrite[]): void {
		const claimed = new Map<Id, TableName>();
		for (const write of writes) {
			const table = write.type;
			const id = write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
