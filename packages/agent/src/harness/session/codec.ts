import Type, { type TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
	Entry,
	JsonValue,
	Register,
	RegisterNamespace,
	SessionCodecOptions,
	Transaction,
	UsageRow,
	Write,
} from "./types.ts";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SafeIntegerSchema = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER });
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER });
const StringSchema = Type.String();
const StringArraySchema = Type.Array(StringSchema);
const NullableStringSchema = Type.Union([StringSchema, Type.Null()]);

function strict(properties: Parameters<typeof Type.Object>[0]): TSchema {
	return Type.Object(properties, { additionalProperties: false });
}

function literals<const TValues extends readonly (string | number | boolean)[]>(...values: TValues): TSchema {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

const TextContentSchema = strict({
	type: Type.Literal("text"),
	text: StringSchema,
	textSignature: Type.Optional(StringSchema),
});
const ThinkingContentSchema = strict({
	type: Type.Literal("thinking"),
	thinking: StringSchema,
	thinkingSignature: Type.Optional(StringSchema),
	redacted: Type.Optional(Type.Boolean()),
});
const ImageContentSchema = strict({
	type: Type.Literal("image"),
	data: StringSchema,
	mimeType: StringSchema,
});
const ToolCallSchema = strict({
	type: Type.Literal("toolCall"),
	id: StringSchema,
	name: StringSchema,
	arguments: Type.Record(Type.String(), JsonValueSchema),
	thoughtSignature: Type.Optional(StringSchema),
	namespace: Type.Optional(StringSchema),
});
const DiagnosticErrorSchema = strict({
	name: Type.Optional(StringSchema),
	message: StringSchema,
	stack: Type.Optional(StringSchema),
	code: Type.Optional(Type.Union([StringSchema, Type.Number()])),
});
const AssistantDiagnosticSchema = strict({
	type: StringSchema,
	timestamp: SafeIntegerSchema,
	error: Type.Optional(DiagnosticErrorSchema),
	details: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
});

export const UsageSchema = strict({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cacheWrite1h: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: strict({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
const DeferredHandleSchema = strict({
	provider: StringSchema,
	modelId: StringSchema,
	api: StringSchema,
	id: StringSchema,
	expiresAt: Type.Optional(SafeIntegerSchema),
	pollAfterMs: Type.Optional(SafeIntegerSchema),
	data: Type.Optional(JsonValueSchema),
});
const UserMessageSchema = strict({
	role: Type.Literal("user"),
	content: Type.Union([StringSchema, Type.Array(Type.Union([TextContentSchema, ImageContentSchema]))]),
	timestamp: SafeIntegerSchema,
});
const AssistantMessageSchema = strict({
	role: Type.Literal("assistant"),
	content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
	api: StringSchema,
	provider: StringSchema,
	model: StringSchema,
	responseModel: Type.Optional(StringSchema),
	responseId: Type.Optional(StringSchema),
	diagnostics: Type.Optional(Type.Array(AssistantDiagnosticSchema)),
	usage: UsageSchema,
	stopReason: literals("stop", "length", "toolUse", "error", "aborted", "deferred"),
	deferred: Type.Optional(DeferredHandleSchema),
	errorMessage: Type.Optional(StringSchema),
	rawStopReason: Type.Optional(StringSchema),
	endTurn: Type.Optional(Type.Boolean()),
	timestamp: SafeIntegerSchema,
});
const ToolResultMessageSchema = strict({
	role: Type.Literal("toolResult"),
	toolCallId: StringSchema,
	toolName: StringSchema,
	content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	addedToolNames: Type.Optional(StringArraySchema),
	isError: Type.Boolean(),
	timestamp: SafeIntegerSchema,
});
export const BuiltInAgentMessageSchema = Type.Union([
	UserMessageSchema,
	AssistantMessageSchema,
	ToolResultMessageSchema,
]);

const ThinkingLevelSchema = literals("off", "minimal", "low", "medium", "high", "xhigh", "max");
const LaneConfigurationSchema = strict({
	model: strict({ provider: StringSchema, modelId: StringSchema }),
	thinkingLevel: ThinkingLevelSchema,
	activeToolNames: StringArraySchema,
});
const ControlSchema = Type.Union([
	strict({ status: Type.Literal("running") }),
	strict({
		status: Type.Literal("cancel_requested"),
		requestedAt: SafeIntegerSchema,
		drainedSteer: StringArraySchema,
		drainedFollowUp: StringArraySchema,
	}),
]);
const OperationErrorSchema = strict({
	code: StringSchema,
	message: StringSchema,
	details: Type.Optional(JsonValueSchema),
});
const CheckpointPhaseSchema = strict({
	kind: Type.Literal("checkpoint"),
	continuation: Type.Union([
		strict({ kind: Type.Literal("need_assistant"), overflowRecoveryUsed: Type.Boolean() }),
		strict({ kind: Type.Literal("may_finish"), includeFinalAssistant: Type.Boolean() }),
	]),
	triggerEntryId: StringSchema,
	thresholdCheckedTriggerEntryId: Type.Optional(StringSchema),
	skipInboxOnce: Type.Optional(Type.Boolean()),
});
const RetryPolicySchema = strict({
	maxAttempts: PositiveSafeIntegerSchema,
	baseDelayMs: SafeIntegerSchema,
});
const StreamOptionsSchema = strict({
	transport: Type.Optional(literals("sse", "websocket", "websocket-cached", "auto")),
	timeoutMs: Type.Optional(SafeIntegerSchema),
	maxRetries: Type.Optional(SafeIntegerSchema),
	maxRetryDelayMs: Type.Optional(SafeIntegerSchema),
	headers: Type.Optional(Type.Record(Type.String(), StringSchema)),
	metadata: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
	cacheRetention: Type.Optional(literals("none", "short", "long")),
	deferred: Type.Optional(
		Type.Union([Type.Boolean(), strict({ window: Type.Optional(literals("15m", "1h", "24h")) })]),
	),
});
const GenerationContextSchema = strict({
	stepId: StringSchema,
	triggerEntryId: StringSchema,
	configuration: LaneConfigurationSchema,
	streamOptions: StreamOptionsSchema,
	retryPolicy: RetryPolicySchema,
	overflowRecoveryUsed: Type.Boolean(),
});
const GenerationSchema = Type.Union([
	strict({ status: Type.Literal("ready"), context: GenerationContextSchema, nextAttempt: PositiveSafeIntegerSchema }),
	strict({
		status: Type.Literal("effect_pending"),
		context: GenerationContextSchema,
		attempt: PositiveSafeIntegerSchema,
		responseEntryId: StringSchema,
		usageId: StringSchema,
		intendedOutputLimit: SafeIntegerSchema,
		contextWindow: SafeIntegerSchema,
	}),
	strict({
		status: Type.Literal("retry_wait"),
		context: GenerationContextSchema,
		nextAttempt: PositiveSafeIntegerSchema,
		notBefore: SafeIntegerSchema,
		errorMessage: StringSchema,
	}),
]);
const ToolCallStateSchema = Type.Union([
	strict({ status: Type.Literal("planned"), sourceIndex: SafeIntegerSchema, resultEntryId: StringSchema }),
	strict({
		status: Type.Literal("effect_pending"),
		sourceIndex: SafeIntegerSchema,
		resultEntryId: StringSchema,
		replay: literals("never", "safe"),
	}),
	strict({
		status: Type.Literal("completed"),
		sourceIndex: SafeIntegerSchema,
		resultEntryId: StringSchema,
		terminate: Type.Boolean(),
	}),
]);
const ToolBatchSchema = strict({
	assistantEntryId: StringSchema,
	configuration: LaneConfigurationSchema,
	turnId: StringSchema,
	calls: Type.Array(ToolCallStateSchema),
});
const DeferredSchema = Type.Union([
	strict({
		status: Type.Literal("suspended"),
		stepId: StringSchema,
		sourceEntryId: StringSchema,
		poll: SafeIntegerSchema,
		configuration: LaneConfigurationSchema,
		streamOptions: StreamOptionsSchema,
	}),
	strict({
		status: Type.Literal("effect_pending"),
		stepId: StringSchema,
		sourceEntryId: StringSchema,
		poll: SafeIntegerSchema,
		responseEntryId: StringSchema,
		usageId: StringSchema,
		configuration: LaneConfigurationSchema,
		streamOptions: StreamOptionsSchema,
	}),
]);
const SummaryContextSchema = strict({
	taskId: StringSchema,
	resultEntryId: StringSchema,
	kind: literals("compaction", "branch_summary"),
	configuration: LaneConfigurationSchema,
	streamOptions: StreamOptionsSchema,
	retryPolicy: RetryPolicySchema,
	reason: Type.Optional(literals("manual", "threshold", "overflow")),
});
const SummaryGenerationSchema = Type.Union([
	strict({ status: Type.Literal("ready"), context: SummaryContextSchema, nextAttempt: PositiveSafeIntegerSchema }),
	strict({
		status: Type.Literal("effect_pending"),
		context: SummaryContextSchema,
		attempt: PositiveSafeIntegerSchema,
		request: Type.Optional(strict({ index: SafeIntegerSchema, usageId: StringSchema })),
		usageIds: StringArraySchema,
	}),
	strict({
		status: Type.Literal("retry_wait"),
		context: SummaryContextSchema,
		nextAttempt: PositiveSafeIntegerSchema,
		notBefore: SafeIntegerSchema,
		errorMessage: StringSchema,
	}),
]);
const StructuralDecisionSchema = Type.Union([
	strict({ taskId: StringSchema, status: Type.Literal("deciding") }),
	strict({ taskId: StringSchema, status: Type.Literal("generating"), generation: SummaryGenerationSchema }),
]);
const RunPhaseSchema = Type.Union([
	CheckpointPhaseSchema,
	strict({ kind: Type.Literal("assistant"), generation: GenerationSchema }),
	strict({ kind: Type.Literal("tools"), batch: ToolBatchSchema }),
	strict({
		kind: Type.Literal("compaction"),
		reason: literals("threshold", "overflow"),
		structural: StructuralDecisionSchema,
		resumeAfter: CheckpointPhaseSchema,
	}),
	strict({ kind: Type.Literal("deferred"), deferred: DeferredSchema }),
	strict({
		kind: Type.Literal("failure_drain"),
		error: OperationErrorSchema,
		provenance: Type.Union([
			strict({ kind: Type.Literal("response"), entryId: StringSchema }),
			strict({ kind: Type.Literal("structural"), taskId: StringSchema }),
		]),
	}),
]);
const CompactionSettingsSchema = strict({
	enabled: Type.Boolean(),
	reserveTokens: SafeIntegerSchema,
	keepRecentTokens: SafeIntegerSchema,
});
const RunStateSchema = strict({
	kind: Type.Literal("run"),
	control: ControlSchema,
	settings: strict({
		compaction: CompactionSettingsSchema,
		steeringMode: literals("all", "one-at-a-time"),
		followUpMode: literals("all", "one-at-a-time"),
		toolExecution: literals("sequential", "parallel"),
	}),
	phase: RunPhaseSchema,
	inbox: strict({ steer: StringArraySchema, followUp: StringArraySchema, writes: StringArraySchema }),
	latestAssistantEntryId: NullableStringSchema,
});
const CompactionStateSchema = strict({
	kind: Type.Literal("compaction"),
	control: ControlSchema,
	customInstructions: Type.Optional(StringSchema),
	structural: StructuralDecisionSchema,
});
const NavigationStateSchema = Type.Union([
	strict({
		kind: Type.Literal("navigation"),
		control: ControlSchema,
		targetId: NullableStringSchema,
		label: Type.Optional(StringSchema),
		summarize: Type.Literal(false),
		phase: strict({ kind: Type.Literal("ready_to_commit") }),
	}),
	strict({
		kind: Type.Literal("navigation"),
		control: ControlSchema,
		targetId: StringSchema,
		label: Type.Optional(StringSchema),
		customInstructions: Type.Optional(StringSchema),
		summarize: Type.Literal(true),
		phase: strict({ kind: Type.Literal("summary"), structural: StructuralDecisionSchema }),
	}),
]);
export const OperationStateSchema = Type.Union([RunStateSchema, CompactionStateSchema, NavigationStateSchema]);

export const OperationSchema = strict({
	operationId: StringSchema,
	lane: StringSchema,
	sourceLeafId: NullableStringSchema,
	startedAt: SafeIntegerSchema,
	intent: Type.Union([
		strict({
			kind: Type.Literal("run"),
			promptEntryIds: StringArraySchema,
			systemPromptOverride: Type.Optional(StringSchema),
			resumeData: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
		}),
		strict({ kind: Type.Literal("compaction"), customInstructions: Type.Optional(StringSchema) }),
		strict({
			kind: Type.Literal("navigation"),
			targetId: NullableStringSchema,
			summarize: Type.Boolean(),
			label: Type.Optional(StringSchema),
			customInstructions: Type.Optional(StringSchema),
		}),
	]),
});
const LaneStateSchema = strict({ currentOperationId: NullableStringSchema, pendingNextRun: StringArraySchema });
const RunLastResultSchema = Type.Union([
	strict({
		operationId: StringSchema,
		kind: Type.Literal("run"),
		leafId: NullableStringSchema,
		finalAssistantEntryId: StringSchema,
		outcome: Type.Literal("completed"),
		runCompletion: Type.Literal("assistant"),
	}),
	strict({
		operationId: StringSchema,
		kind: Type.Literal("run"),
		leafId: NullableStringSchema,
		outcome: Type.Literal("completed"),
		runCompletion: Type.Literal("terminated_tools"),
	}),
	strict({
		operationId: StringSchema,
		kind: Type.Literal("run"),
		leafId: NullableStringSchema,
		finalAssistantEntryId: Type.Optional(StringSchema),
		outcome: Type.Literal("failed"),
		error: OperationErrorSchema,
	}),
	strict({
		operationId: StringSchema,
		kind: Type.Literal("run"),
		leafId: NullableStringSchema,
		finalAssistantEntryId: Type.Optional(StringSchema),
		outcome: Type.Literal("aborted"),
	}),
]);
function structuralLastResultSchema(kind: "compaction" | "navigation"): TSchema {
	return Type.Union([
		strict({
			operationId: StringSchema,
			kind: Type.Literal(kind),
			leafId: NullableStringSchema,
			outcome: Type.Literal("completed"),
		}),
		strict({
			operationId: StringSchema,
			kind: Type.Literal(kind),
			leafId: NullableStringSchema,
			outcome: Type.Literal("failed"),
			error: OperationErrorSchema,
		}),
		strict({
			operationId: StringSchema,
			kind: Type.Literal(kind),
			leafId: NullableStringSchema,
			outcome: literals("declined", "aborted"),
		}),
	]);
}
const LaneLastResultSchema = Type.Union([
	RunLastResultSchema,
	structuralLastResultSchema("compaction"),
	structuralLastResultSchema("navigation"),
]);
const DurableFileOperationsSchema = strict({
	read: StringArraySchema,
	written: StringArraySchema,
	edited: StringArraySchema,
});

function createStructuralPreparationSchema(messageSchema: TSchema): TSchema {
	return Type.Union([
		strict({
			kind: Type.Literal("compaction"),
			messagesToSummarize: Type.Array(messageSchema),
			turnPrefixMessages: Type.Array(messageSchema),
			retainedTail: Type.Array(messageSchema),
			isSplitTurn: Type.Boolean(),
			tokensBefore: SafeIntegerSchema,
			previousSummary: Type.Optional(StringSchema),
			fileOps: DurableFileOperationsSchema,
			settings: CompactionSettingsSchema,
		}),
		strict({
			kind: Type.Literal("branch_summary"),
			messages: Type.Array(messageSchema),
			fileOps: DurableFileOperationsSchema,
			totalTokens: SafeIntegerSchema,
		}),
	]);
}

function createPendingEntrySchema(messageSchema: TSchema): TSchema {
	return Type.Union([
		strict({ type: Type.Literal("message"), payload: messageSchema }),
		strict({ type: Type.Literal("custom"), customType: StringSchema, payload: Type.Optional(JsonValueSchema) }),
	]);
}

function createRegisterValueSchemas(messageSchema: TSchema): Record<RegisterNamespace, TSchema> {
	return {
		"lane.leaf": NullableStringSchema,
		"lane.config": LaneConfigurationSchema,
		"lane.state": LaneStateSchema,
		"lane.lastResult": LaneLastResultSchema,
		"op.meta": OperationSchema,
		"op.state": OperationStateSchema,
		"op.tool_args": Type.Record(Type.String(), JsonValueSchema),
		"op.preparation": createStructuralPreparationSchema(messageSchema),
		"pending.entry": createPendingEntrySchema(messageSchema),
		"fact.name": StringSchema,
		"fact.label": StringSchema,
		"fact.custom": JsonValueSchema,
	};
}
export const RegisterValueSchemas = createRegisterValueSchemas(BuiltInAgentMessageSchema);

function createEntrySchemas(
	messageSchema: TSchema,
	customMessageSchema?: TSchema,
): { entry: TSchema; newEntry: TSchema } {
	function variants(base: Parameters<typeof Type.Object>[0]): TSchema[] {
		return [
			strict({ ...base, type: Type.Literal("message"), message: UserMessageSchema }),
			strict({ ...base, type: Type.Literal("message"), message: AssistantMessageSchema }),
			strict({
				...base,
				type: Type.Literal("message"),
				message: ToolResultMessageSchema,
				terminate: Type.Optional(Type.Literal(true)),
			}),
			...(customMessageSchema === undefined
				? []
				: [strict({ ...base, type: Type.Literal("message"), message: customMessageSchema })]),
			strict({
				...base,
				type: Type.Literal("compaction"),
				summary: StringSchema,
				retainedTail: Type.Array(messageSchema),
				tokensBefore: SafeIntegerSchema,
				details: Type.Optional(JsonValueSchema),
				usage: Type.Optional(UsageSchema),
				fromHook: Type.Boolean(),
			}),
			strict({
				...base,
				type: Type.Literal("branch_summary"),
				fromId: StringSchema,
				summary: StringSchema,
				details: Type.Optional(JsonValueSchema),
				usage: Type.Optional(UsageSchema),
				fromHook: Type.Boolean(),
			}),
			strict({
				...base,
				type: Type.Literal("custom"),
				customType: StringSchema,
				data: Type.Optional(JsonValueSchema),
			}),
		];
	}
	const newBase = { id: StringSchema, parentId: NullableStringSchema };
	const storedBase = { ...newBase, seq: PositiveSafeIntegerSchema, timestamp: SafeIntegerSchema };
	return { newEntry: Type.Union(variants(newBase)), entry: Type.Union(variants(storedBase)) };
}
const defaultEntries = createEntrySchemas(BuiltInAgentMessageSchema);
export const NewEntrySchema = defaultEntries.newEntry;
export const EntrySchema = defaultEntries.entry;

export const NewUsageRowSchema = strict({
	id: StringSchema,
	usage: UsageSchema,
	entryId: Type.Optional(StringSchema),
	adjustment: Type.Boolean(),
	details: Type.Optional(JsonValueSchema),
});
export const UsageRowSchema = strict({
	id: StringSchema,
	seq: PositiveSafeIntegerSchema,
	usage: UsageSchema,
	entryId: Type.Optional(StringSchema),
	adjustment: Type.Boolean(),
	details: Type.Optional(JsonValueSchema),
});
const RegisterNamespaceSchema = literals(
	"lane.leaf",
	"lane.config",
	"lane.state",
	"lane.lastResult",
	"op.meta",
	"op.state",
	"op.tool_args",
	"op.preparation",
	"pending.entry",
	"fact.name",
	"fact.label",
	"fact.custom",
);

function createWriteSchema(newEntrySchema: TSchema, registerSchemas: Record<RegisterNamespace, TSchema>): TSchema {
	const registerSetSchemas = Object.entries(registerSchemas).map(([namespace, value]) =>
		strict({
			kind: Type.Literal("register"),
			op: Type.Literal("set"),
			namespace: Type.Literal(namespace),
			key: StringSchema,
			value,
		}),
	);
	return Type.Union([
		strict({ kind: Type.Literal("entry"), entry: newEntrySchema }),
		strict({ kind: Type.Literal("usage"), row: NewUsageRowSchema }),
		...registerSetSchemas,
		strict({
			kind: Type.Literal("register"),
			op: Type.Literal("delete"),
			namespace: RegisterNamespaceSchema,
			key: StringSchema,
		}),
	]);
}
export const WriteSchema = createWriteSchema(NewEntrySchema, RegisterValueSchemas);
export const TransactionSchema = strict({ writes: Type.Array(WriteSchema) });

export class SessionCodecError extends TypeError {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`${path}: ${reason}`);
		this.name = "SessionCodecError";
		this.path = path;
	}
}

function propertyPath(path: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function cloneJsonSafe(value: unknown, path: string, ancestors = new WeakSet<object>()): JsonValue {
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) throw new SessionCodecError(path, "number must be finite");
			return value;
		case "undefined":
		case "bigint":
		case "symbol":
		case "function":
			throw new SessionCodecError(path, `${typeof value} is not a durable JSON value`);
		case "object":
			break;
	}
	if (value === null) return null;
	if (ancestors.has(value)) throw new SessionCodecError(path, "cyclic reference is not durable JSON");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const ownKeys = Reflect.ownKeys(value);
			for (const key of ownKeys) {
				if (typeof key === "symbol")
					throw new SessionCodecError(`${path}[${String(key)}]`, "symbol-keyed properties are not durable JSON");
				if (key === "length") continue;
				const index = Number(key);
				if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
					throw new SessionCodecError(propertyPath(path, key), "array has a non-index property");
				}
			}
			const result: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const itemPath = `${path}[${index}]`;
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined) throw new SessionCodecError(itemPath, "sparse arrays are not durable JSON");
				if (!("value" in descriptor))
					throw new SessionCodecError(itemPath, "accessor properties are not durable JSON");
				if (!descriptor.enumerable)
					throw new SessionCodecError(itemPath, "non-enumerable properties are not durable JSON");
				result.push(cloneJsonSafe(descriptor.value, itemPath, ancestors));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new SessionCodecError(path, "object prototype is not supported for durable JSON");
		}
		const result: { [key: string]: JsonValue } = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol")
				throw new SessionCodecError(`${path}[${String(key)}]`, "symbol-keyed properties are not durable JSON");
			const keyPath = propertyPath(path, key);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined)
				throw new SessionCodecError(keyPath, "property descriptor disappeared during validation");
			if (!("value" in descriptor)) throw new SessionCodecError(keyPath, "accessor properties are not durable JSON");
			if (!descriptor.enumerable)
				throw new SessionCodecError(keyPath, "non-enumerable properties are not durable JSON");
			Object.defineProperty(result, key, {
				value: cloneJsonSafe(descriptor.value, keyPath, ancestors),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function pointerPath(root: string, pointer: string): string {
	if (pointer === "") return root;
	let path = root;
	for (const encoded of pointer.split("/").slice(1)) {
		const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		path = /^\d+$/.test(segment) ? `${path}[${segment}]` : propertyPath(path, segment);
	}
	return path;
}

function assertSchema(schema: TSchema, value: unknown, path: string): void {
	if (Value.Check(schema, value)) return;
	const errors = Value.Errors(schema, value);
	const error = errors.reduce<(typeof errors)[number] | undefined>(
		(selected, candidate) =>
			selected === undefined || candidate.instancePath.length > selected.instancePath.length ? candidate : selected,
		undefined,
	);
	throw new SessionCodecError(
		error === undefined ? path : pointerPath(path, error.instancePath),
		error?.message ?? "value does not match the runtime schema",
	);
}

const BUILT_IN_ROLES = new Set(["user", "assistant", "toolResult"]);

function validateMessageRole(value: unknown, path: string, customMessageSchemas: ReadonlyMap<string, TSchema>): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const role = (value as Record<string, unknown>).role;
	if (typeof role !== "string") throw new SessionCodecError(`${path}.role`, "message role must be a string");
	if (!BUILT_IN_ROLES.has(role) && !customMessageSchemas.has(role)) {
		throw new SessionCodecError(`${path}.role`, `unknown custom message role ${JSON.stringify(role)}`);
	}
}

function validateMessageRolesInEntry(
	value: unknown,
	path: string,
	customMessageSchemas: ReadonlyMap<string, TSchema>,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const object = value as Record<string, unknown>;
	if (object.type === "message") validateMessageRole(object.message, `${path}.message`, customMessageSchemas);
	if (object.type === "compaction" && Array.isArray(object.retainedTail)) {
		object.retainedTail.forEach((message, index) => {
			validateMessageRole(message, `${path}.retainedTail[${index}]`, customMessageSchemas);
		});
	}
}

function validateMessageRolesInRegister(
	namespace: RegisterNamespace,
	value: unknown,
	path: string,
	customMessageSchemas: ReadonlyMap<string, TSchema>,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const register = value as Record<string, unknown>;
	const registerValue = register.value;
	if (typeof registerValue !== "object" || registerValue === null || Array.isArray(registerValue)) return;
	const object = registerValue as Record<string, unknown>;
	if (namespace === "pending.entry" && object.type === "message") {
		validateMessageRole(object.payload, `${path}.value.payload`, customMessageSchemas);
	}
	if (namespace !== "op.preparation") return;
	for (const field of object.kind === "compaction"
		? ["messagesToSummarize", "turnPrefixMessages", "retainedTail"]
		: object.kind === "branch_summary"
			? ["messages"]
			: []) {
		const messages = object[field];
		if (Array.isArray(messages)) {
			messages.forEach((message, index) => {
				validateMessageRole(message, `${path}.value.${field}[${index}]`, customMessageSchemas);
			});
		}
	}
}

function validateRegisterKey(namespace: RegisterNamespace, key: string, value: unknown, path: string): void {
	if (namespace === "fact.name") {
		if (key !== "") throw new SessionCodecError(`${path}.key`, "fact.name register key must be empty");
	} else if (namespace !== "fact.custom" && key.length === 0) {
		throw new SessionCodecError(`${path}.key`, `${namespace} register key must not be empty`);
	}
	if (namespace === "op.tool_args" && !/^[^:]+:[^:]+:(?:0|[1-9]\d*)$/.test(key)) {
		throw new SessionCodecError(`${path}.key`, "op.tool_args key must be {operationId}:{stepId}:{sourceIndex}");
	}
	if (namespace === "op.preparation" && !/^[^:]+:[^:]+$/.test(key)) {
		throw new SessionCodecError(`${path}.key`, "op.preparation key must be {operationId}:{taskId}");
	}
	if (namespace === "op.meta" && typeof value === "object" && value !== null && !Array.isArray(value)) {
		const operationId = (value as Record<string, unknown>).operationId;
		if (typeof operationId === "string" && operationId !== key) {
			throw new SessionCodecError(`${path}.key`, "op.meta register key must equal value.operationId");
		}
	}
}

/** Package-internal durable value validation and detachment boundary. */
export class SessionCodec {
	private readonly customMessageSchemas: ReadonlyMap<string, TSchema>;
	private readonly entrySchema: TSchema;
	private readonly registerSchemas: Record<RegisterNamespace, TSchema>;
	private readonly writeSchema: TSchema;
	private readonly transactionSchema: TSchema;

	constructor(options: SessionCodecOptions = {}) {
		const customMessageSchemas = options.customMessageSchemas ?? {};
		const schemas = new Map<string, TSchema>();
		for (const key of Reflect.ownKeys(customMessageSchemas)) {
			if (typeof key !== "string")
				throw new SessionCodecError("$.customMessageSchemas", "custom message roles must be strings");
			if (BUILT_IN_ROLES.has(key))
				throw new SessionCodecError(`$.customMessageSchemas.${key}`, "built-in message roles cannot be replaced");
			const schema = customMessageSchemas[key];
			if (!Type.IsSchema(schema))
				throw new SessionCodecError(`$.customMessageSchemas.${key}`, "custom message schema must be a TSchema");
			schemas.set(key, Type.Intersect([schema, Type.Object({ role: Type.Literal(key) })]));
		}
		this.customMessageSchemas = schemas;
		const customSchemas = [...schemas.values()];
		const customMessageSchema = customSchemas.length === 0 ? undefined : Type.Union(customSchemas);
		const messageSchema =
			customMessageSchema === undefined
				? BuiltInAgentMessageSchema
				: Type.Union([BuiltInAgentMessageSchema, customMessageSchema]);
		const entries = createEntrySchemas(messageSchema, customMessageSchema);
		this.entrySchema = entries.entry;
		this.registerSchemas = createRegisterValueSchemas(messageSchema);
		this.writeSchema = createWriteSchema(entries.newEntry, this.registerSchemas);
		this.transactionSchema = strict({ writes: Type.Array(this.writeSchema) });
	}

	encodeTransaction(transaction: Transaction): Transaction {
		return this.parseTransaction(transaction);
	}

	decodeTransaction(value: unknown): Transaction {
		return this.parseTransaction(value);
	}

	decodeWrite(value: unknown): Write {
		const detached = cloneJsonSafe(value, "$");
		this.validateWriteRoles(detached, "$");
		assertSchema(this.writeSchema, detached, "$");
		this.validateWriteKey(detached, "$");
		return detached as Write;
	}

	decodeEntry(value: unknown): Entry {
		const detached = cloneJsonSafe(value, "$");
		validateMessageRolesInEntry(detached, "$", this.customMessageSchemas);
		assertSchema(this.entrySchema, detached, "$");
		return detached as unknown as Entry;
	}

	decodeRegister<TNamespace extends RegisterNamespace>(namespace: TNamespace, value: unknown): Register<TNamespace> {
		const detached = cloneJsonSafe(value, "$");
		validateMessageRolesInRegister(namespace, detached, "$", this.customMessageSchemas);
		const schema = strict({
			namespace: Type.Literal(namespace),
			key: StringSchema,
			value: this.registerSchemas[namespace],
			seq: PositiveSafeIntegerSchema,
		});
		assertSchema(schema, detached, "$");
		const register = detached as unknown as Register<TNamespace>;
		validateRegisterKey(namespace, register.key, register.value, "$");
		return register;
	}

	decodeUsageRow(value: unknown): UsageRow {
		const detached = cloneJsonSafe(value, "$");
		assertSchema(UsageRowSchema, detached, "$");
		return detached as unknown as UsageRow;
	}

	private parseTransaction(value: unknown): Transaction {
		const detached = cloneJsonSafe(value, "$");
		if (
			typeof detached === "object" &&
			detached !== null &&
			!Array.isArray(detached) &&
			Array.isArray(detached.writes)
		) {
			detached.writes.forEach((write, index) => {
				this.validateWriteRoles(write, `$.writes[${index}]`);
			});
		}
		assertSchema(this.transactionSchema, detached, "$");
		const transaction = detached as unknown as Transaction;
		transaction.writes.forEach((write, index) => {
			this.validateWriteKey(write, `$.writes[${index}]`);
		});
		return transaction;
	}

	private validateWriteRoles(value: unknown, path: string): void {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const write = value as Record<string, unknown>;
		if (write.kind === "entry") validateMessageRolesInEntry(write.entry, `${path}.entry`, this.customMessageSchemas);
		if (write.kind === "register" && write.op === "set" && typeof write.namespace === "string") {
			if (write.namespace in this.registerSchemas) {
				validateMessageRolesInRegister(
					write.namespace as RegisterNamespace,
					write,
					path,
					this.customMessageSchemas,
				);
			}
		}
	}

	private validateWriteKey(value: unknown, path: string): void {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const write = value as Record<string, unknown>;
		if (write.kind !== "register" || typeof write.namespace !== "string" || typeof write.key !== "string") return;
		if (!(write.namespace in this.registerSchemas)) return;
		validateRegisterKey(write.namespace as RegisterNamespace, write.key, write.value, path);
	}
}
