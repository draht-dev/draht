import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@draht/chord";
import { withoutAbortSignal } from "@draht/chord/context";
import type { Element, List, PayloadOf, ResolvedValue, Value } from "./addresses.ts";
import type { Id, JsonValue } from "./core.ts";
import type { Conversation, Entry } from "./entries.ts";
import type { ConversationScan, EntryScan, NewTask, Page, Storage, TaskScan, Write } from "./storage.ts";
import type { Task } from "./tasks.ts";

export class Closed extends Error {
	constructor() {
		super("Session is closed");
		this.name = "Closed";
	}
}

export class Faulted extends Error {
	constructor() {
		super("Session is faulted");
		this.name = "Faulted";
	}
}

export class NestedLineOperation extends Error {
	constructor() {
		super("Session line operations cannot be nested");
		this.name = "NestedLineOperation";
	}
}

export class ReadAfterWrite extends Error {
	constructor() {
		super("Transaction reads must precede writes");
		this.name = "ReadAfterWrite";
	}
}

export type TaskCreate = Omit<NewTask, "id" | "output"> & {
	readonly output?: { readonly id?: Id; readonly kind: string };
};

interface LineInvocation {
	active: boolean;
}

const lineInvocation = new AsyncLocalStorage<LineInvocation>();
const storageOwners = new WeakMap<Storage, object>();

function assertContextActive(ctx: Context): void {
	ctx.abortSignal?.throwIfAborted();
}

function resolveStoredValue<D extends Value<JsonValue>>(
	address: D,
	stored: PayloadOf<D> | undefined,
): ResolvedValue<D> {
	const fallback = address.default as PayloadOf<D> | undefined;
	return (stored === undefined ? fallback : stored) as ResolvedValue<D>;
}

export interface Transaction {
	getConversation(id: Id): Promise<Conversation | undefined>;
	getEntry(id: Id): Promise<Entry | undefined>;
	getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
	getTask(id: Id): Promise<Task | undefined>;
	getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
	createConversation(conversation: Omit<Conversation, "id">): Id;
	entry(entry: Omit<Entry, "id">): Id;
	task(task: TaskCreate): Id;
	setTask(task: Task): void;
	value<D extends Value<JsonValue>>(
		address: D,
	): {
		get(at?: Id): Promise<ResolvedValue<D>>;
		set(value: PayloadOf<D>): void;
		delete(): void;
	};
	list<T extends JsonValue>(
		address: List<T>,
	): {
		read(at?: Id): Promise<readonly Element<T>[]>;
		append(value: T): Id;
		remove(id: Id): void;
		clear(): void;
	};
}

class TransactionState {
	private readonly storage: Storage;
	private readonly ctx: Context;
	private active = true;
	private writing = false;
	private entryAppended = false;
	private pendingReads = 0;
	private failure: Error | undefined;
	private readonly writes: Write[] = [];

	constructor(storage: Storage, ctx: Context) {
		this.storage = storage;
		this.ctx = ctx;
	}

	facade(): Transaction {
		return Object.freeze({
			getConversation: (id: Id) => this.getConversation(id),
			getEntry: (id: Id) => this.getEntry(id),
			getEntries: (ids: readonly Id[]) => this.getEntries(ids),
			getTask: (id: Id) => this.getTask(id),
			getTasks: (ids: readonly Id[]) => this.getTasks(ids),
			createConversation: (conversation: Omit<Conversation, "id">) => this.createConversation(conversation),
			entry: (entry: Omit<Entry, "id">) => this.entry(entry),
			task: (task: TaskCreate) => this.task(task),
			setTask: (task: Task) => this.setTask(task),
			value: <D extends Value<JsonValue>>(address: D) => this.value(address),
			list: <T extends JsonValue>(address: List<T>) => this.list(address),
		});
	}

	finish(): readonly Write[] {
		this.assertActive();
		if (this.pendingReads !== 0) this.poison(new Error("Transaction has pending reads"));
		this.active = false;
		return this.writes;
	}

	seal(): void {
		this.active = false;
	}

	async getConversation(id: Id): Promise<Conversation | undefined> {
		return (await this.read(() => this.storage.getConversations([id], this.ctx))).get(id);
	}

	async getEntry(id: Id): Promise<Entry | undefined> {
		return (await this.getEntries([id])).get(id);
	}

	getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>> {
		return this.read(() => this.storage.getEntries(ids, this.ctx));
	}

	async getTask(id: Id): Promise<Task | undefined> {
		return (await this.getTasks([id])).get(id);
	}

	getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>> {
		return this.read(() => this.storage.getTasks(ids, this.ctx));
	}

	createConversation(conversation: Omit<Conversation, "id">): Id {
		const id = this.allocate();
		this.writes.push({ type: "conversation.create", conversation: { ...conversation, id } });
		return id;
	}

	entry(entry: Omit<Entry, "id">): Id {
		const id = this.allocate();
		this.writes.push({ type: "entry.append", entry: { ...entry, id } });
		this.entryAppended = true;
		return id;
	}

	task(task: TaskCreate): Id {
		const id = this.allocate();
		const { output: requestedOutput, ...base } = task;
		const output =
			requestedOutput === undefined ? undefined : { id: requestedOutput.id ?? id, kind: requestedOutput.kind };
		this.writes.push({
			type: "task.create",
			task: { ...base, id, ...(output === undefined ? {} : { output }) },
		});
		return id;
	}

	setTask(task: Task): void {
		this.write({ type: "task.set", task });
	}

	value<D extends Value<JsonValue>>(
		address: D,
	): {
		get(at?: Id): Promise<ResolvedValue<D>>;
		set(value: PayloadOf<D>): void;
		delete(): void;
	} {
		this.assertActive();
		return Object.freeze({
			get: (at?: Id) =>
				this.read(async () => {
					const stored = await this.storage.getValue(address as unknown as Value<PayloadOf<D>>, at, this.ctx);
					return resolveStoredValue(address, stored);
				}),
			set: (value: PayloadOf<D>) => {
				this.assertStateWriteOrder(address);
				this.write({ type: "value.set", address, value });
			},
			delete: () => {
				this.assertStateWriteOrder(address);
				this.write({ type: "value.delete", address });
			},
		});
	}

	list<T extends JsonValue>(
		address: List<T>,
	): {
		read(at?: Id): Promise<readonly Element<T>[]>;
		append(value: T): Id;
		remove(id: Id): void;
		clear(): void;
	} {
		this.assertActive();
		return Object.freeze({
			read: (at?: Id) => this.read(() => this.storage.readList(address, at, this.ctx)),
			append: (value: T) => {
				this.assertStateWriteOrder(address);
				const id = this.allocate();
				this.writes.push({ type: "list.append", address, element: { id, value } });
				return id;
			},
			remove: (elementId: Id) => {
				this.assertStateWriteOrder(address);
				this.write({ type: "list.remove", address, elementId });
			},
			clear: () => {
				this.assertStateWriteOrder(address);
				this.write({ type: "list.clear", address });
			},
		});
	}

	private assertStateWriteOrder(address: Value<JsonValue> | List<JsonValue>): void {
		this.assertActive();
		if (address.rewind && this.entryAppended) {
			this.poison(new Error("Rewindable state writes must precede entry appends"));
		}
	}

	private allocate(): Id {
		this.assertWritable();
		return this.storage.nextId();
	}

	private write(write: Write): void {
		this.assertWritable();
		this.writes.push(write);
	}

	private async read<T>(read: () => Promise<T>): Promise<T> {
		this.assertReadable();
		this.pendingReads++;
		try {
			return await read();
		} finally {
			this.pendingReads--;
		}
	}

	private assertReadable(): void {
		this.assertActive();
		if (this.writing) this.poison(new ReadAfterWrite());
	}

	private assertWritable(): void {
		this.assertActive();
		if (this.pendingReads !== 0) this.poison(new Error("Transaction writes must await reads"));
		this.writing = true;
	}

	private assertActive(): void {
		if (!this.active) throw new Error("Transaction is closed");
		if (this.failure !== undefined) throw this.failure;
	}

	private poison(error: Error): never {
		this.failure ??= error;
		throw this.failure;
	}
}

export class Session {
	private readonly storage: Storage;
	private readonly ownership = Object.freeze({});
	private tail: Promise<void> = Promise.resolve();
	private fault: Faulted | undefined;
	private closed = false;
	private closeCompletion: Promise<void> | undefined;
	private storageCloseCompletion: Promise<void> | undefined;

	constructor(storage: Storage) {
		if (storageOwners.has(storage)) throw new Error("Storage is already owned by another Session");
		storageOwners.set(storage, this.ownership);
		this.storage = storage;
	}

	commit<T>(build: (tx: Transaction) => T | Promise<T>, ctx: Context): Promise<T> {
		try {
			assertContextActive(ctx);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.onLine(async () => {
			this.assertUsable();
			assertContextActive(ctx);
			const tx = new TransactionState(this.storage, ctx);
			try {
				const result = await build(tx.facade());
				const writes = tx.finish();
				if (writes.length !== 0) {
					try {
						await this.storage.commit(writes, withoutAbortSignal(ctx));
					} catch (error) {
						this.fault = new Faulted();
						try {
							await this.closeStorage(ctx);
						} catch {}
						throw error;
					}
				}
				return result;
			} finally {
				tx.seal();
			}
		});
	}

	close(ctx: Context): Promise<void> {
		if (this.nested()) return Promise.reject(new NestedLineOperation());
		this.closeCompletion ??= this.enqueueLine(async () => {
			this.closed = true;
			await this.closeStorage(ctx);
		});
		return this.closeCompletion;
	}

	getConversations(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Conversation>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.getConversations(ids, ctx);
		});
	}

	scanConversations(query: ConversationScan, ctx: Context): Promise<Page<Conversation>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.scanConversations(query, ctx);
		});
	}

	getEntries(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Entry>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.getEntries(ids, ctx);
		});
	}

	scanEntries(query: EntryScan, ctx: Context): Promise<Page<Entry>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.scanEntries(query, ctx);
		});
	}

	newestHead(conversationId: Id, at: Id, ctx: Context): Promise<Entry | undefined> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.newestHead(conversationId, at, ctx);
		});
	}

	getTasks(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Task>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.getTasks(ids, ctx);
		});
	}

	scanTasks(query: TaskScan, ctx: Context): Promise<Page<Task>> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.scanTasks(query, ctx);
		});
	}

	getValue<D extends Value<JsonValue>>(address: D, at: Id | undefined, ctx: Context): Promise<ResolvedValue<D>> {
		return this.onLine(async () => {
			this.assertUsable();
			const stored = await this.storage.getValue(address as unknown as Value<PayloadOf<D>>, at, ctx);
			return resolveStoredValue(address, stored);
		});
	}

	readList<T extends JsonValue>(address: List<T>, at: Id | undefined, ctx: Context): Promise<readonly Element<T>[]> {
		return this.onLine(() => {
			this.assertUsable();
			return this.storage.readList(address, at, ctx);
		});
	}

	private onLine<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.nested()) return Promise.reject(new NestedLineOperation());
		return this.enqueueLine(operation);
	}

	private enqueueLine<T>(operation: () => T | Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise((resolve) => {
			release = resolve;
		});
		return (async () => {
			await previous;
			const invocation: LineInvocation = { active: true };
			try {
				return await lineInvocation.run(invocation, operation);
			} finally {
				invocation.active = false;
				release();
			}
		})();
	}

	private nested(): boolean {
		return lineInvocation.getStore()?.active === true;
	}

	private closeStorage(ctx: Context): Promise<void> {
		this.storageCloseCompletion ??= Promise.resolve()
			.then(() => this.storage.close(withoutAbortSignal(ctx)))
			.then(() => {
				if (storageOwners.get(this.storage) === this.ownership) storageOwners.delete(this.storage);
			});
		return this.storageCloseCompletion;
	}

	private assertUsable(): void {
		if (this.fault !== undefined) throw this.fault;
		if (this.closed) throw new Closed();
	}
}
