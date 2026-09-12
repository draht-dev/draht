import type { Context } from "@draht/chord";
import type { Element, List, Value } from "./addresses.ts";
import type { Id, JsonValue, Seq } from "./core.ts";
import type { Conversation, Entry } from "./entries.ts";
import type { Task } from "./tasks.ts";

export interface PageQuery {
	/** Last item returned by the same scan. */
	readonly cursor?: Id;
	readonly limit: number;
}

export interface Page<T> {
	readonly items: readonly T[];
	readonly next?: Id;
}

export class InvalidHistoryPosition extends Error {
	readonly at: Id;

	constructor(at: Id) {
		super(`Entry ${at} is not a valid history position for this address`);
		this.name = "InvalidHistoryPosition";
		this.at = at;
	}
}

export type NewTask = Omit<Task, "abort" | "checkpoint" | "outcome" | "owns" | "status"> & {
	readonly status: "pending";
	readonly owns: readonly [];
	readonly abort?: never;
	readonly checkpoint?: never;
	readonly outcome?: never;
};

export type StateWrite =
	| { readonly type: "value.set"; readonly address: Value<JsonValue>; readonly value: JsonValue }
	| { readonly type: "value.delete"; readonly address: Value<JsonValue> }
	| { readonly type: "list.append"; readonly address: List<JsonValue>; readonly element: Element<JsonValue> }
	| { readonly type: "list.remove"; readonly address: List<JsonValue>; readonly elementId: Id }
	| { readonly type: "list.clear"; readonly address: List<JsonValue> };

export type Write =
	| StateWrite
	| { readonly type: "conversation.create"; readonly conversation: Conversation }
	| { readonly type: "entry.append"; readonly entry: Entry }
	| { readonly type: "task.create"; readonly task: NewTask }
	| { readonly type: "task.set"; readonly task: Task };

export type ConversationScan = PageQuery & {
	readonly parent?: Id;
	readonly owner?: Id;
};

export type EntryScan = PageQuery & {
	readonly conversationId: Id;
	readonly kind?: string;
	readonly through?: Id;
};

export type TaskScan = PageQuery & {
	readonly conversationIds?: readonly Id[];
	readonly statuses?: readonly Task["status"][];
	readonly kind?: string;
	readonly abort?: boolean;
	readonly outputId?: Id;
};

export interface Storage {
	nextId(): Id;
	commit(writes: readonly Write[], ctx: Context): Promise<readonly Seq[]>;
	getConversations(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Conversation>>;
	scanConversations(query: ConversationScan, ctx: Context): Promise<Page<Conversation>>;
	getEntries(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Entry>>;
	scanEntries(query: EntryScan, ctx: Context): Promise<Page<Entry>>;
	newestHead(conversationId: Id, at: Id, ctx: Context): Promise<Entry | undefined>;
	getTasks(ids: readonly Id[], ctx: Context): Promise<ReadonlyMap<Id, Task>>;
	scanTasks(query: TaskScan, ctx: Context): Promise<Page<Task>>;
	getValue<T extends JsonValue>(address: Value<T>, at: Id | undefined, ctx: Context): Promise<T | undefined>;
	readList<T extends JsonValue>(address: List<T>, at: Id | undefined, ctx: Context): Promise<readonly Element<T>[]>;
}
