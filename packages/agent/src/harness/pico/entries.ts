import type { AssistantMessage, Message, ToolResultMessage, Usage, UserMessage } from "@draht/ai";
import type { Id, JsonValue, Stored } from "./core.ts";

export type ContextEdit =
	| { readonly target: Id; readonly action: "omit" }
	| { readonly target: Id; readonly action: "replace"; readonly messages: readonly Stored<Message>[] };

export interface Entry {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly byTaskId?: Id;
	readonly data?: JsonValue;
	readonly model?: readonly Stored<Message>[];
	readonly head?: Id;
	readonly edits?: readonly ContextEdit[];
}

export type EntryIdentity = Pick<Entry, "id" | "conversationId" | "kind" | "byTaskId">;
export type EntryBase = EntryIdentity;

export interface EntryData<D extends JsonValue = JsonValue> {
	readonly data: D;
}

export interface ModelProjection<M extends Message = Message> {
	readonly model: readonly Stored<M>[];
}

export interface ContextHead {
	readonly head: Id;
}

export interface ContextEdits {
	readonly edits: readonly ContextEdit[];
}

export type EntryInput<E extends Entry> = Omit<E, keyof EntryIdentity | "head"> &
	(E extends { readonly head: Id } ? { readonly head: Id | "self" } : { readonly head?: never });

export interface EntryKind<E extends Entry = Entry> {
	readonly kind: string;
	is(entry: Entry | undefined): entry is E;
}

export function defineEntry<E extends Entry>(kind: string): EntryKind<E> {
	return Object.freeze({
		kind,
		is(entry: Entry | undefined): entry is E {
			return entry?.kind === kind;
		},
	});
}

export interface Conversation {
	readonly id: Id;
	readonly parent?: { readonly conversationId: Id; readonly at: Id };
	readonly owner?: Id;
}

export type AssistantEntryData = { readonly attempt: number };
export type UsageEntryData = { readonly attempt: number; readonly usage?: Stored<Usage>; readonly error: string };
export type ToolControl = {
	readonly terminate?: true;
	readonly handoff?: string;
	readonly addTools?: readonly string[];
};
export type ToolDiagnostic = {
	readonly severity: "info" | "warn" | "error";
	readonly message: string;
	readonly code?: string;
};
export type ToolUsage = { readonly [key: string]: number };
export type ToolResultData = {
	readonly details?: JsonValue;
	readonly usage?: ToolUsage;
	readonly diagnostics?: readonly ToolDiagnostic[];
	readonly control?: ToolControl;
	readonly truncated?: { readonly bytes: number; readonly lines: number };
};
export type SectionRecord =
	| { readonly key: string; readonly action: "set"; readonly value: JsonValue; readonly rendered: string }
	| { readonly key: string; readonly action: "remove" };
export type SystemEntryData = { readonly baseline?: true; readonly sections: readonly SectionRecord[] };

export type UserEntry = EntryBase & {
	readonly model: readonly [Stored<UserMessage>];
	readonly data?: { readonly continuation: true; readonly from: Id };
};
export type AssistantEntry = EntryBase & {
	readonly model: readonly [Stored<AssistantMessage>];
	readonly data?: AssistantEntryData;
};
export type ToolResultEntry = EntryBase & {
	readonly model: readonly [Stored<ToolResultMessage>];
	readonly data: ToolResultData;
};
export type NoticeEntry = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly data?: JsonValue };
export type UsageEntry = EntryBase & { readonly data: UsageEntryData };
export type SummaryEntry = EntryBase & {
	readonly model: readonly [Stored<UserMessage>];
	readonly data: { readonly through: Id };
	readonly head: Id;
};
export type HandoffEntry = EntryBase & { readonly model: readonly [Stored<UserMessage>]; readonly head: Id };
export type ResetEntry = EntryBase & { readonly head: Id };
