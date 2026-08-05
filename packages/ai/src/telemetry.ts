export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}

export interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
}

export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}

function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(callback(noopTelemetrySpan));
	} catch (error) {
		return Promise.reject(error);
	}
}

const noopTelemetrySpan: TelemetrySpan = {
	startSpan: startNoopSpan,
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
};
Object.freeze(noopTelemetrySpan);

/** Shared telemetry context used when an application does not provide one. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = noopTelemetrySpan;

export type TelemetryAttributeType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";

export interface TelemetryAttributeMetadata {
	description: string;
	sensitive?: boolean;
	cardinality?: "low" | "high";
}

export type TelemetryAttributeDefinition = TelemetryAttributeMetadata &
	(
		| { type: "string"; values?: readonly string[]; examples?: readonly string[] }
		| { type: "number"; values?: readonly number[]; examples?: readonly number[] }
		| { type: "boolean"; values?: readonly boolean[]; examples?: readonly boolean[] }
		| { type: "string[]"; elementValues?: readonly string[]; examples?: readonly (readonly string[])[] }
		| { type: "number[]"; elementValues?: readonly number[]; examples?: readonly (readonly number[])[] }
		| { type: "boolean[]"; elementValues?: readonly boolean[]; examples?: readonly (readonly boolean[])[] }
	);

export type TelemetryStartAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };
export type TelemetryEventAttributeDefinition = TelemetryAttributeDefinition & { required: boolean };

export interface TelemetryEventDefinition {
	description: string;
	attributes: Record<string, TelemetryEventAttributeDefinition>;
}

export type TelemetryParentDefinition =
	| { kind: "any" }
	| { kind: "root_or_external" }
	| { kind: "spans"; spans: readonly string[] };

export interface TelemetrySpanDefinition {
	description: string;
	parents: TelemetryParentDefinition;
	startAttributes: Record<string, TelemetryStartAttributeDefinition>;
	endAttributes: Record<string, TelemetryAttributeDefinition>;
	events?: Record<string, TelemetryEventDefinition>;
	status: { default: "ok"; errorWhen: string };
}

export interface TelemetrySchemaDefinition {
	version: number;
	spans: Record<string, TelemetrySpanDefinition>;
}

/** Typed identity helper for serializable telemetry schema data. */
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
	return schema;
}

type AttributeDefinitionValue<Definition extends TelemetryAttributeDefinition> = Definition extends {
	type: "string";
	values: readonly (infer Value extends string)[];
}
	? Value
	: Definition extends { type: "string" }
		? string
		: Definition extends { type: "number"; values: readonly (infer Value extends number)[] }
			? Value
			: Definition extends { type: "number" }
				? number
				: Definition extends { type: "boolean"; values: readonly (infer Value extends boolean)[] }
					? Value
					: Definition extends { type: "boolean" }
						? boolean
						: Definition extends {
									type: "string[]";
									elementValues: readonly (infer Value extends string)[];
								}
							? readonly Value[]
							: Definition extends { type: "string[]" }
								? readonly string[]
								: Definition extends {
											type: "number[]";
											elementValues: readonly (infer Value extends number)[];
										}
									? readonly Value[]
									: Definition extends { type: "number[]" }
										? readonly number[]
										: Definition extends {
													type: "boolean[]";
													elementValues: readonly (infer Value extends boolean)[];
												}
											? readonly Value[]
											: readonly boolean[];

type RequiredAttributeNames<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = {
	[Name in keyof Definitions]-?: Definitions[Name]["required"] extends true ? Name : never;
}[keyof Definitions];

type OptionalAttributeNames<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = Exclude<keyof Definitions, RequiredAttributeNames<Definitions>>;

export type InferRequiredAndOptionalAttributes<
	Definitions extends Record<string, TelemetryStartAttributeDefinition | TelemetryEventAttributeDefinition>,
> = keyof Definitions extends never
	? Record<string, never>
	: {
			[Name in RequiredAttributeNames<Definitions>]: AttributeDefinitionValue<Definitions[Name]>;
		} & {
			[Name in OptionalAttributeNames<Definitions>]?: AttributeDefinitionValue<Definitions[Name]>;
		};

export type InferStartAttributes<Definitions extends Record<string, TelemetryStartAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<Definitions>;

export type InferOptionalAttributes<Definitions extends Record<string, TelemetryAttributeDefinition>> =
	keyof Definitions extends never
		? Record<string, never>
		: { [Name in keyof Definitions]?: AttributeDefinitionValue<Definitions[Name]> };

export type ExactTelemetryAttributes<Expected, Actual extends Expected> = Actual &
	Record<Exclude<keyof Actual, keyof Expected>, never>;

export type InferEventAttributes<Definitions extends Record<string, TelemetryEventAttributeDefinition>> =
	InferRequiredAndOptionalAttributes<Definitions>;

export type TelemetrySchemaSpanName<Schema extends TelemetrySchemaDefinition> = keyof Schema["spans"] & string;

type SchemaSpan<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = Schema["spans"][Name];

export type TelemetrySchemaSpanStartAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["startAttributes"] extends infer Definitions extends Record<
	string,
	TelemetryStartAttributeDefinition
>
	? InferStartAttributes<Definitions>
	: never;

export type TelemetrySchemaSpanEndAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name>["endAttributes"] extends infer Definitions extends Record<
	string,
	TelemetryAttributeDefinition
>
	? InferOptionalAttributes<Definitions>
	: never;

type SchemaSpanEvents<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = SchemaSpan<Schema, Name> extends { events: infer Events extends Record<string, TelemetryEventDefinition> }
	? Events
	: Record<never, never>;

export type TelemetrySchemaSpanEventName<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = keyof SchemaSpanEvents<Schema, Name> & string;

type SchemaSpanEvent<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvents<Schema, Name> extends infer Events
	? EventName extends keyof Events
		? Events[EventName]
		: never
	: never;

export type TelemetrySchemaSpanEventAttributes<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? InferEventAttributes<Definitions>
	: never;

type SchemaSpanEventAttributeDefinitions<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
	EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
> = SchemaSpanEvent<Schema, Name, EventName> extends {
	attributes: infer Definitions extends Record<string, TelemetryEventAttributeDefinition>;
}
	? Definitions
	: Record<never, never>;

type EventArguments<
	Definitions extends Record<string, TelemetryEventAttributeDefinition>,
	Attributes extends InferEventAttributes<Definitions>,
> = [RequiredAttributeNames<Definitions>] extends [never]
	? [attributes?: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>]
	: [attributes: ExactTelemetryAttributes<InferEventAttributes<Definitions>, Attributes>];

export type SchemaTelemetrySpan<
	Schema extends TelemetrySchemaDefinition,
	Name extends TelemetrySchemaSpanName<Schema>,
> = Omit<TelemetrySpan, "addEvent" | "setAttributes"> & {
	addEvent<
		EventName extends TelemetrySchemaSpanEventName<Schema, Name>,
		const Attributes extends InferEventAttributes<
			SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>
		> = InferEventAttributes<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>>,
	>(
		name: EventName,
		...args: EventArguments<SchemaSpanEventAttributeDefinitions<Schema, Name, EventName>, Attributes>
	): void;
	setAttributes<const Attributes extends TelemetrySchemaSpanEndAttributes<Schema, Name>>(
		attributes: ExactTelemetryAttributes<TelemetrySchemaSpanEndAttributes<Schema, Name>, Attributes>,
	): void;
};

export type TelemetrySchemaSpanUnion<Schema extends TelemetrySchemaDefinition> = {
	[Name in TelemetrySchemaSpanName<Schema>]: {
		name: Name;
		startAttributes: TelemetrySchemaSpanStartAttributes<Schema, Name>;
		endAttributes: TelemetrySchemaSpanEndAttributes<Schema, Name>;
		events: {
			[EventName in TelemetrySchemaSpanEventName<Schema, Name>]: TelemetrySchemaSpanEventAttributes<
				Schema,
				Name,
				EventName
			>;
		};
	};
}[TelemetrySchemaSpanName<Schema>];

export const AI_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"pi.ai.request": {
			description: "One logical request to an AI provider",
			parents: { kind: "any" },
			startAttributes: {
				"pi.ai.operation": {
					type: "string",
					required: true,
					values: ["stream", "fetch_deferred", "cancel_deferred", "generate_images"],
					description: "Logical provider operation",
				},
				"pi.ai.provider": {
					type: "string",
					required: true,
					description: "Selected provider id",
				},
				"pi.ai.model": {
					type: "string",
					required: true,
					description: "Requested model id",
				},
				"pi.ai.api": {
					type: "string",
					required: true,
					description: "Provider API id",
				},
				"pi.ai.streaming": {
					type: "boolean",
					required: true,
					description: "Whether this operation returns a stream",
				},
				"pi.ai.deferred": {
					type: "boolean",
					required: false,
					description: "Whether the operation requests or participates in deferred execution",
				},
			},
			endAttributes: {
				"pi.ai.response.model": { type: "string", description: "Concrete response model" },
				"pi.ai.response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response id",
				},
				"pi.ai.response.stop_reason": {
					type: "string",
					values: ["stop", "length", "tool_use", "error", "aborted", "deferred"],
					description: "Normalized terminal response reason",
				},
				"pi.ai.http.status_code": { type: "number", description: "Final HTTP status" },
				"pi.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
				"pi.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
				"pi.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
				"pi.ai.usage.cache_write_tokens": {
					type: "number",
					description: "Reported cache-write tokens",
				},
				"pi.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens" },
				"pi.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
				"pi.ai.usage.cost": { type: "number", description: "Reported total cost" },
				"pi.ai.stream.chunk_count": { type: "number", description: "Streamed update chunk count" },
				"pi.ai.stream.time_to_first_chunk_ms": {
					type: "number",
					description: "Elapsed milliseconds to first update chunk",
				},
				"pi.ai.error.type": {
					type: "string",
					cardinality: "low",
					description: "Provider or transport error class",
				},
			},
			status: { default: "ok", errorWhen: "The operation throws or returns an error result" },
		},
	},
} as const);

export type AiSpanName = TelemetrySchemaSpanName<typeof AI_TELEMETRY_SCHEMA>;
export type AiSpanStartAttributes<Name extends AiSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanEndAttributes<Name extends AiSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanAttributes<Name extends AiSpanName> = AiSpanStartAttributes<Name> & AiSpanEndAttributes<Name>;
export type AiSpanEventName<Name extends AiSpanName> = TelemetrySchemaSpanEventName<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpanEventAttributes<
	Name extends AiSpanName,
	EventName extends AiSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof AI_TELEMETRY_SCHEMA, Name, EventName>;
export type AiTelemetrySpan<Name extends AiSpanName> = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpan = TelemetrySchemaSpanUnion<typeof AI_TELEMETRY_SCHEMA>;

export function startAiSpan<Name extends AiSpanName, const Attributes extends AiSpanStartAttributes<Name>, Result>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<AiSpanStartAttributes<Name>, Attributes>,
	callback: (span: AiTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	return telemetryContext.startSpan({ name, attributes }, (span) => callback(span as AiTelemetrySpan<Name>));
}
