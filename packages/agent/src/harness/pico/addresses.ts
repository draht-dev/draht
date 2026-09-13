import type { Id, JsonValue } from "./core.ts";

export type Scope =
	| { readonly type: "session" }
	| { readonly type: "conversation"; readonly conversationId: Id }
	| { readonly type: "task"; readonly taskId: Id }
	| { readonly type: "shared"; readonly id: Id };

export type PublicScope = Exclude<Scope, { type: "shared" }>;
export type StickyScope = Extract<PublicScope, { type: "session" | "task" }>;
export type ConversationScope = Extract<PublicScope, { type: "conversation" }>;

declare const addressType: unique symbol;

export interface Address<T extends JsonValue = JsonValue> {
	readonly scope: Scope;
	readonly namespace: string;
	readonly key?: string;
	readonly kind: "value" | "list";
	readonly rewind: boolean;
	readonly [addressType]?: T;
}

export interface Value<T extends JsonValue> extends Address<T> {
	readonly kind: "value";
	readonly default?: T;
}

export interface List<T extends JsonValue> extends Address<T> {
	readonly kind: "list";
}

export interface Element<T extends JsonValue> {
	readonly id: Id;
	readonly value: T;
}

export interface UnboundValue<T extends JsonValue, R extends boolean = boolean> {
	readonly namespace: string;
	readonly key?: string;
	readonly rewind: R;
	readonly default?: T;
	readonly [addressType]?: T;
	bind(conversationId: Id): Value<T>;
}

export interface UnboundList<T extends JsonValue, R extends boolean = boolean> {
	readonly namespace: string;
	readonly key?: string;
	readonly rewind: R;
	readonly [addressType]?: T;
	bind(conversationId: Id): List<T>;
}

export type ConversationValueDefinition<T extends JsonValue, R extends boolean = boolean> = UnboundValue<T, R>;
export type ConversationListDefinition<T extends JsonValue, R extends boolean = boolean> = UnboundList<T, R>;
export type PayloadOf<D> = D extends Address<infer BoundPayload>
	? BoundPayload
	: D extends UnboundValue<infer DefinitionPayload, boolean>
		? DefinitionPayload
		: never;
export type ResolvedValue<D> = D extends { readonly default: infer V } ? V : PayloadOf<D> | undefined;

type DefaultedUnboundValue<T extends JsonValue, R extends boolean> = Omit<UnboundValue<T, R>, "bind" | "default"> & {
	readonly default: T;
	bind(conversationId: Id): Value<T> & { readonly default: T };
};

type StickyOptions<T extends JsonValue> = { readonly key?: string; readonly default?: T };
type DefaultedStickyOptions<T extends JsonValue> = { readonly key?: string; readonly default: T };
type ConversationOptions<T extends JsonValue> = {
	readonly key?: string;
	readonly rewind: boolean;
	readonly default?: T;
};
type DefaultedConversationOptions<T extends JsonValue> = {
	readonly key?: string;
	readonly rewind: boolean;
	readonly default: T;
};
type InternalOptions<T extends JsonValue> = StickyOptions<T> & { readonly rewind?: boolean };

function assertPublicNamespace(namespace: string): void {
	if (namespace.startsWith("pi.")) throw new Error(`Namespace ${namespace} is reserved`);
}

function assertPublicScope(scope: Scope): asserts scope is PublicScope {
	if (scope.type === "shared") throw new Error("Shared scope is internal");
}

function value<T extends JsonValue>(scope: Scope, namespace: string, options?: InternalOptions<T>): Value<T> {
	return Object.freeze({
		...options,
		scope,
		namespace,
		kind: "value" as const,
		rewind: options?.rewind ?? false,
	});
}

function list<T extends JsonValue>(scope: Scope, namespace: string, options?: InternalOptions<T>): List<T> {
	return Object.freeze({
		...options,
		scope,
		namespace,
		kind: "list" as const,
		rewind: options?.rewind ?? false,
	});
}

export function defineValue<T extends JsonValue>(
	scope: StickyScope,
	namespace: string,
	options: DefaultedStickyOptions<T>,
): Value<T> & { readonly default: T };
export function defineValue<T extends JsonValue>(
	scope: StickyScope,
	namespace: string,
	options?: { readonly key?: string },
): Value<T>;
export function defineValue<T extends JsonValue>(
	scope: ConversationScope,
	namespace: string,
	options: DefaultedConversationOptions<T>,
): Value<T> & { readonly default: T };
export function defineValue<T extends JsonValue>(
	scope: ConversationScope,
	namespace: string,
	options: { readonly key?: string; readonly rewind: boolean },
): Value<T>;
export function defineValue<T extends JsonValue>(
	scope: Scope,
	namespace: string,
	options?: InternalOptions<T>,
): Value<T> {
	assertPublicScope(scope);
	assertPublicNamespace(namespace);
	return value(scope, namespace, options);
}

export function defineList<T extends JsonValue>(
	scope: StickyScope,
	namespace: string,
	options?: { readonly key?: string },
): List<T>;
export function defineList<T extends JsonValue>(
	scope: ConversationScope,
	namespace: string,
	options: Omit<ConversationOptions<T>, "default">,
): List<T>;
export function defineList<T extends JsonValue>(
	scope: Scope,
	namespace: string,
	options?: InternalOptions<T>,
): List<T> {
	assertPublicScope(scope);
	assertPublicNamespace(namespace);
	return list(scope, namespace, options);
}

export function conversationValue<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: true; readonly default: T },
): DefaultedUnboundValue<T, true>;
export function conversationValue<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: false; readonly default: T },
): DefaultedUnboundValue<T, false>;
export function conversationValue<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: true },
): UnboundValue<T, true>;
export function conversationValue<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: false },
): UnboundValue<T, false>;
export function conversationValue<T extends JsonValue>(
	namespace: string,
	options: ConversationOptions<T>,
): UnboundValue<T> {
	assertPublicNamespace(namespace);
	return unboundValue(namespace, options);
}

export function conversationList<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: true },
): UnboundList<T, true>;
export function conversationList<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: false },
): UnboundList<T, false>;
export function conversationList<T extends JsonValue>(
	namespace: string,
	options: Omit<ConversationOptions<T>, "default">,
): UnboundList<T> {
	assertPublicNamespace(namespace);
	return unboundList(namespace, options);
}

export function sessionValue<T extends JsonValue>(
	namespace: string,
	options: { readonly key?: string; readonly default: T },
): Value<T> & { readonly default: T };
export function sessionValue<T extends JsonValue>(namespace: string, options?: { readonly key?: string }): Value<T>;
export function sessionValue<T extends JsonValue>(namespace: string, options?: StickyOptions<T>): Value<T> {
	return defineValue({ type: "session" }, namespace, options);
}

/** Internal constructor for fixed `pi.*` definitions and shared task output state. */
export function defineInternalValue<T extends JsonValue>(
	scope: Scope,
	namespace: string,
	options?: InternalOptions<T>,
): Value<T> {
	return value(scope, namespace, options);
}

/** Internal constructor for fixed `pi.*` definitions and shared task output state. */
export function defineInternalList<T extends JsonValue>(
	scope: Scope,
	namespace: string,
	options?: InternalOptions<T>,
): List<T> {
	return list(scope, namespace, options);
}

/** Internal constructor for fixed conversation configuration definitions. */
export function internalConversationValue<T extends JsonValue, R extends boolean>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: R; readonly default: T },
): DefaultedUnboundValue<T, R>;
export function internalConversationValue<T extends JsonValue, R extends boolean>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: R },
): UnboundValue<T, R>;
export function internalConversationValue<T extends JsonValue, R extends boolean>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: R; readonly default?: T },
): UnboundValue<T, R> {
	return unboundValue(namespace, options);
}

function unboundValue<T extends JsonValue, R extends boolean>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: R; readonly default?: T },
): UnboundValue<T, R> {
	return Object.freeze({
		...options,
		namespace,
		bind: (conversationId: Id) =>
			value<T>({ type: "conversation", conversationId }, namespace, {
				key: options.key,
				rewind: options.rewind,
				default: options.default,
			}),
	});
}

function unboundList<T extends JsonValue, R extends boolean>(
	namespace: string,
	options: { readonly key?: string; readonly rewind: R },
): UnboundList<T, R> {
	return Object.freeze({
		...options,
		namespace,
		bind: (conversationId: Id) =>
			list<T>({ type: "conversation", conversationId }, namespace, {
				key: options.key,
				rewind: options.rewind,
			}),
	});
}
