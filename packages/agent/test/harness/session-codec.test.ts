import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@draht/ai";
import Type from "typebox";
import { describe, expect, it } from "vitest";
import { SessionCodec, SessionCodecError } from "../../src/harness/session/codec.ts";
import type {
	Entry,
	LaneConfiguration,
	NewEntry,
	Operation,
	OperationState,
	RegisterNamespace,
	RegisterValues,
	RunState,
	Transaction,
	UsageRow,
} from "../../src/harness/session/types.ts";

const ENTRY_ID = "00000000-0000-7000-8000-000000000001";
const PARENT_ID = "00000000-0000-7000-8000-000000000002";
const USAGE_ID = "00000000-0000-7000-8000-000000000003";
const OPERATION_ID = "00000000-0000-7000-8000-000000000004";
const STEP_ID = "00000000-0000-7000-8000-000000000005";
const TASK_ID = "00000000-0000-7000-8000-000000000006";
const FOLLOWER_ID = "00000000-0000-7000-8000-000000000007";
const OTHER_TIMESTAMP_ID = "00000000-0001-7000-8000-000000000008";

const USER_ID = "00000000-0000-7000-8000-000000000009";
const ASSISTANT_ID = "00000000-0000-7000-8000-00000000000a";
const TOOL_ID = "00000000-0000-7000-8000-00000000000b";
const COMPACTION_ID = "00000000-0000-7000-8000-00000000000c";
const SUMMARY_ID = "00000000-0000-7000-8000-00000000000d";
const MARKER_ID = "00000000-0000-7000-8000-00000000000e";
const NOTE_ID = "00000000-0000-7000-8000-00000000000f";
const NOTICE_ID = "00000000-0000-7000-8000-000000000010";
const TRIGGER_ID = "00000000-0000-7000-8000-000000000011";
const PROMPT_ID = "00000000-0000-7000-8000-000000000012";
const TARGET_ID = "00000000-0000-7000-8000-000000000013";
const PENDING_ID = "00000000-0000-7000-8000-000000000014";
const CUSTOM_ID = "00000000-0000-7000-8000-000000000015";
const SECOND_FOLLOWER_ID = "00000000-0000-7000-8000-000000000018";
const MESSAGE_ID = "00000000-0000-7000-8000-000000000016";
const BAD_ID = "00000000-0000-7000-8000-000000000017";

const NOW = 1_700_000_000_000;
const configuration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;
const usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	cacheWrite1h: 1,
	reasoning: 1,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
} satisfies Usage;
const userMessage: UserMessage = {
	role: "user",
	content: [{ type: "text", text: "hello", textSignature: "signature" }],
	timestamp: NOW,
};
const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "hmm", thinkingSignature: "opaque", redacted: false },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" }, namespace: "fs" },
	],
	api: "test-api",
	provider: "test-provider",
	model: "test-model",
	responseModel: "resolved-model",
	responseId: "response-1",
	diagnostics: [{ type: "retry", timestamp: NOW, error: { message: "temporary", code: 503 } }],
	usage,
	stopReason: "toolUse",
	timestamp: NOW,
};
const toolResultMessage: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "contents" }],
	details: { path: "README.md" },
	usage,
	addedToolNames: ["write"],
	isError: false,
	timestamp: NOW,
};

function stored<TEntry extends NewEntry>(entry: TEntry, seq = 1): TEntry & { seq: number; timestamp: number } {
	return { ...entry, seq, timestamp: NOW };
}

function checkpointState(): RunState {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		phase: {
			kind: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId: TRIGGER_ID,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

function operation(kind: Operation["intent"]["kind"]): Operation {
	const base = { operationId: OPERATION_ID, lane: "main", sourceLeafId: null, startedAt: NOW };
	switch (kind) {
		case "run":
			return { ...base, intent: { kind, promptEntryIds: [PROMPT_ID], resumeData: { extension: null } } };
		case "compaction":
			return { ...base, intent: { kind, customInstructions: "short" } };
		case "navigation":
			return { ...base, intent: { kind, targetId: TARGET_ID, summarize: true, label: "target" } };
	}
}

function operationStates(): OperationState[] {
	return [
		checkpointState(),
		{
			kind: "compaction",
			control: { status: "running" },
			customInstructions: "short",
			structural: { status: "deciding", taskId: TASK_ID },
		},
		{
			kind: "navigation",
			control: { status: "running" },
			targetId: null,
			summarize: false,
			phase: { kind: "ready_to_commit" },
		},
		{
			kind: "navigation",
			control: { status: "running" },
			targetId: TARGET_ID,
			summarize: true,
			phase: { kind: "summary", structural: { status: "deciding", taskId: TASK_ID } },
		},
	];
}

const registerKeys = {
	"lane.leaf": "main",
	"lane.config": "main",
	"lane.state": "main",
	"lane.lastResult": "main",
	"op.meta": OPERATION_ID,
	"op.state": OPERATION_ID,
	"op.tool_args": `${OPERATION_ID}:${STEP_ID}:0`,
	"op.preparation": `${OPERATION_ID}:${TASK_ID}`,
	"pending.entry": PENDING_ID,
	"fact.name": "",
	"fact.label": ENTRY_ID,
	"fact.custom": "key",
} satisfies Record<RegisterNamespace, string>;

function registerValue<TNamespace extends RegisterNamespace>(
	namespace: TNamespace,
	value: RegisterValues[TNamespace],
	key = registerKeys[namespace],
): { namespace: TNamespace; key: string; value: RegisterValues[TNamespace]; seq: number } {
	return { namespace, key, value, seq: 1 };
}

function invalidJsonValues(): Array<{ name: string; value: unknown }> {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	const sparse = [1, 2, 3];
	delete sparse[1];
	const accessor: Record<string, unknown> = {};
	Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "value" });
	const nonEnumerable = { visible: true };
	Object.defineProperty(nonEnumerable, "hidden", { enumerable: false, value: true });
	const symbolKeyed = { visible: true };
	Object.defineProperty(symbolKeyed, Symbol("secret"), { enumerable: true, value: true });
	return [
		{ name: "undefined", value: undefined },
		{ name: "bigint", value: 1n },
		{ name: "symbol", value: Symbol("value") },
		{ name: "function", value: () => undefined },
		{ name: "cycle", value: cycle },
		{ name: "sparse array", value: sparse },
		{ name: "accessor", value: accessor },
		{ name: "non-enumerable property", value: nonEnumerable },
		{ name: "symbol-keyed property", value: symbolKeyed },
		{ name: "unsupported prototype", value: new Date(0) },
		{ name: "NaN", value: Number.NaN },
		{ name: "positive infinity", value: Number.POSITIVE_INFINITY },
		{ name: "negative infinity", value: Number.NEGATIVE_INFINITY },
	];
}

function transactionWithCustomValue(value: unknown): Transaction {
	return {
		writes: [
			{
				kind: "register",
				op: "set",
				namespace: "fact.custom",
				key: "invalid",
				value,
			} as unknown as Transaction["writes"][number],
		],
	};
}

describe("SessionCodec entries and messages", () => {
	it("decodes every entry family and built-in pi-ai message role", () => {
		const codec = new SessionCodec();
		const entries = [
			stored({ id: USER_ID, parentId: null, type: "message", message: userMessage }),
			stored({ id: ASSISTANT_ID, parentId: USER_ID, type: "message", message: assistantMessage }),
			stored({ id: TOOL_ID, parentId: ASSISTANT_ID, type: "message", message: toolResultMessage, terminate: true }),
			stored({
				id: COMPACTION_ID,
				parentId: TOOL_ID,
				type: "compaction",
				summary: "summary",
				retainedTail: [userMessage, assistantMessage, toolResultMessage],
				tokensBefore: 100,
				details: { source: "generated" },
				usage,
				fromHook: false,
			}),
			stored({
				id: SUMMARY_ID,
				parentId: COMPACTION_ID,
				type: "branch_summary",
				fromId: TOOL_ID,
				summary: "branch summary",
				details: null,
				usage,
				fromHook: true,
			}),
			stored({ id: MARKER_ID, parentId: SUMMARY_ID, type: "custom", customType: "marker" }),
			stored({ id: NOTE_ID, parentId: MARKER_ID, type: "custom", customType: "note", data: { text: "remember" } }),
		] satisfies Entry[];

		expect(entries.map((entry) => codec.decodeEntry(entry))).toEqual(entries);
	});

	it("requires canonical UUIDv7 harness identities while preserving opaque provider ids", () => {
		const codec = new SessionCodec();
		const entry = stored({ id: ENTRY_ID, parentId: null, type: "message", message: assistantMessage });

		expect(codec.decodeEntry(entry)).toEqual(entry);
		expect(assistantMessage.responseId).toBe("response-1");
		expect(assistantMessage.content[1]).toMatchObject({ id: "call-1" });
		const deferredMessage: AssistantMessage = {
			...assistantMessage,
			stopReason: "deferred",
			deferred: { provider: "provider", modelId: "model", api: "api", id: "opaque-handle" },
		};
		expect(
			codec.decodeEntry(stored({ id: PARENT_ID, parentId: ENTRY_ID, type: "message", message: deferredMessage })),
		).toMatchObject({ message: { deferred: { id: "opaque-handle" } } });
		for (const id of [
			"entry",
			"00000000-0000-4000-8000-000000000001",
			"00000000-0000-7000-7000-000000000001",
			"00000000-0000-7000-8000-00000000000A",
		]) {
			expect(() => codec.decodeEntry({ ...entry, id })).toThrow(SessionCodecError);
		}
		expect(() => codec.decodeEntry({ ...entry, parentId: "parent" })).toThrow(SessionCodecError);
	});

	it("accepts a registered custom role and rejects unknown or non-string roles in both directions", () => {
		const codec = new SessionCodec({
			customMessageSchemas: {
				notice: Type.Object(
					{ role: Type.Literal("notice"), text: Type.String(), timestamp: Type.Integer() },
					{ additionalProperties: false },
				),
			},
		});
		const customMessage = { role: "notice", text: "maintenance", timestamp: NOW };
		const entry = stored({
			id: NOTICE_ID,
			parentId: null,
			type: "message",
			message: customMessage,
		} as unknown as NewEntry);

		const newEntry = { id: NOTICE_ID, parentId: null, type: "message", message: customMessage };
		expect(codec.decodeEntry(entry)).toEqual(entry);
		expect(codec.decodeWrite({ kind: "entry", entry: newEntry })).toEqual({ kind: "entry", entry: newEntry });
		expect(
			codec.encodeTransaction({ writes: [{ kind: "entry", entry: newEntry }] } as unknown as Transaction),
		).toEqual({ writes: [{ kind: "entry", entry: newEntry }] });

		const schemaMismatch = { ...newEntry, message: { ...customMessage, text: 42 } };
		expect(() => codec.decodeWrite({ kind: "entry", entry: schemaMismatch })).toThrow(SessionCodecError);
		expect(() =>
			codec.encodeTransaction({ writes: [{ kind: "entry", entry: schemaMismatch }] } as unknown as Transaction),
		).toThrow(SessionCodecError);

		for (const message of [
			{ role: "unregistered", text: "no" },
			{ role: 42, text: "no" },
		]) {
			expect(() =>
				codec.decodeEntry(stored({ id: BAD_ID, parentId: null, type: "message", message } as unknown as NewEntry)),
			).toThrow(SessionCodecError);
			expect(() =>
				codec.decodeWrite({ kind: "entry", entry: { id: BAD_ID, parentId: null, type: "message", message } }),
			).toThrow(SessionCodecError);
			expect(() =>
				codec.encodeTransaction({
					writes: [{ kind: "entry", entry: { id: BAD_ID, parentId: null, type: "message", message } }],
				} as unknown as Transaction),
			).toThrow(SessionCodecError);
		}
	});

	it("binds each custom schema to its registered role", () => {
		const codec = new SessionCodec({
			customMessageSchemas: {
				alpha: Type.Object(
					{ role: Type.String(), alpha: Type.String(), timestamp: Type.Integer() },
					{ additionalProperties: false },
				),
				beta: Type.Object(
					{ role: Type.String(), beta: Type.Number(), timestamp: Type.Integer() },
					{ additionalProperties: false },
				),
			},
		});

		for (const message of [
			{ role: "alpha", beta: 1, timestamp: NOW },
			{ role: "beta", alpha: "wrong schema", timestamp: NOW },
		]) {
			const entry = { id: BAD_ID, parentId: null, type: "message", message };
			expect(() => codec.decodeEntry(stored(entry as unknown as NewEntry))).toThrow(SessionCodecError);
			expect(() => codec.decodeWrite({ kind: "entry", entry })).toThrow(SessionCodecError);
			expect(() => codec.decodeTransaction({ writes: [{ kind: "entry", entry }] })).toThrow(SessionCodecError);
			expect(() =>
				codec.decodeRegister("pending.entry", {
					namespace: "pending.entry",
					key: PENDING_ID,
					value: { type: "message", payload: message },
					seq: 1,
				}),
			).toThrow(SessionCodecError);
		}
	});

	it("does not let a permissive custom schema admit malformed built-in messages", () => {
		const codec = new SessionCodec({ customMessageSchemas: { notice: Type.Any() } });
		const malformedUser = { role: "user", content: 42, timestamp: NOW };
		const entry = { id: BAD_ID, parentId: null, type: "message", message: malformedUser };

		expect(() => codec.decodeEntry(stored(entry as unknown as NewEntry))).toThrow(SessionCodecError);
		expect(() => codec.decodeWrite({ kind: "entry", entry })).toThrow(SessionCodecError);
		expect(() => codec.decodeTransaction({ writes: [{ kind: "entry", entry }] })).toThrow(SessionCodecError);
		expect(() =>
			codec.decodeRegister("pending.entry", {
				namespace: "pending.entry",
				key: PENDING_ID,
				value: { type: "message", payload: malformedUser },
				seq: 1,
			}),
		).toThrow(SessionCodecError);
	});

	it("rejects pending assistants, malformed entry discriminants, structural omissions, and invalid termination", () => {
		const codec = new SessionCodec();
		const pending = { ...assistantMessage, stopReason: "pending" };
		const invalidEntries: unknown[] = [
			stored({ id: BAD_ID, parentId: null, type: "message", message: pending } as unknown as NewEntry),
			stored({
				id: MESSAGE_ID,
				parentId: null,
				type: "message",
				customType: "wrong",
				message: userMessage,
			} as unknown as NewEntry),
			stored({ id: CUSTOM_ID, parentId: null, type: "custom", data: null } as unknown as NewEntry),
			stored({
				id: CUSTOM_ID,
				parentId: null,
				type: "custom",
				customType: "note",
				message: userMessage,
			} as unknown as NewEntry),
			stored({
				id: COMPACTION_ID,
				parentId: null,
				type: "compaction",
				summary: "missing tail",
				tokensBefore: 1,
				fromHook: false,
			} as unknown as NewEntry),
			stored({
				id: COMPACTION_ID,
				parentId: null,
				type: "compaction",
				summary: "missing hook",
				retainedTail: [],
				tokensBefore: 1,
			} as unknown as NewEntry),
			stored({
				id: SUMMARY_ID,
				parentId: null,
				type: "branch_summary",
				fromId: PARENT_ID,
				summary: "missing hook",
			} as unknown as NewEntry),
			stored({
				id: USER_ID,
				parentId: null,
				type: "message",
				message: userMessage,
				terminate: true,
			} as unknown as NewEntry),
			stored({
				id: TOOL_ID,
				parentId: null,
				type: "message",
				message: toolResultMessage,
				terminate: false,
			} as unknown as NewEntry),
			{ ...stored({ id: CUSTOM_ID, parentId: null, type: "custom", customType: "note" }), seq: 0 },
			{ ...stored({ id: NOTE_ID, parentId: null, type: "custom", customType: "note" }), timestamp: -1 },
		];

		for (const entry of invalidEntries) expect(() => codec.decodeEntry(entry)).toThrow(SessionCodecError);
	});
});

describe("SessionCodec registers and operation states", () => {
	it("decodes every namespace-specific register value", () => {
		const codec = new SessionCodec();
		const registerCases: Array<{ namespace: RegisterNamespace; register: unknown }> = [
			{ namespace: "lane.leaf", register: registerValue("lane.leaf", null) },
			{ namespace: "lane.config", register: registerValue("lane.config", configuration) },
			{
				namespace: "lane.state",
				register: registerValue("lane.state", { currentOperationId: OPERATION_ID, pendingNextRun: [PENDING_ID] }),
			},
			{
				namespace: "lane.lastResult",
				register: registerValue("lane.lastResult", {
					operationId: OPERATION_ID,
					kind: "run",
					leafId: ASSISTANT_ID,
					finalAssistantEntryId: ASSISTANT_ID,
					outcome: "completed",
					runCompletion: "assistant",
				}),
			},
			{ namespace: "op.meta", register: registerValue("op.meta", operation("run")) },
			{ namespace: "op.state", register: registerValue("op.state", checkpointState()) },
			{
				namespace: "op.tool_args",
				register: registerValue("op.tool_args", { path: "README.md", line: 1 }),
			},
			{
				namespace: "op.preparation",
				register: registerValue(
					"op.preparation",
					{
						kind: "compaction",
						messagesToSummarize: [userMessage],
						turnPrefixMessages: [],
						retainedTail: [toolResultMessage],
						isSplitTurn: false,
						tokensBefore: 100,
						previousSummary: "previous",
						fileOps: { read: ["README.md"], written: [], edited: [] },
						settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
					},
					registerKeys["op.preparation"],
				),
			},
			{
				namespace: "op.preparation",
				register: registerValue(
					"op.preparation",
					{
						kind: "branch_summary",
						messages: [assistantMessage],
						fileOps: { read: [], written: ["result.txt"], edited: [] },
						totalTokens: 100,
					},
					registerKeys["op.preparation"],
				),
			},
			{
				namespace: "pending.entry",
				register: {
					namespace: "pending.entry",
					key: PENDING_ID,
					value: { type: "message", payload: userMessage },
					seq: 1,
				},
			},
			{
				namespace: "pending.entry",
				register: registerValue("pending.entry", { type: "custom", customType: "note" }),
			},
			{ namespace: "fact.name", register: registerValue("fact.name", "session") },
			{ namespace: "fact.label", register: registerValue("fact.label", "important") },
			{ namespace: "fact.custom", register: registerValue("fact.custom", null) },
		];

		for (const { namespace, register } of registerCases) {
			expect(codec.decodeRegister(namespace, register)).toEqual(register);
		}
	});

	it("requires UUIDv7 state identities and namespace-specific register keys", () => {
		const codec = new SessionCodec();
		const invalidRegisters: Array<[RegisterNamespace, unknown]> = [
			["fact.label", { namespace: "fact.label", key: "entry", value: "label", seq: 1 }],
			[
				"pending.entry",
				{
					namespace: "pending.entry",
					key: "pending",
					value: { type: "message", payload: userMessage },
					seq: 1,
				},
			],
			["op.meta", { namespace: "op.meta", key: "operation", value: operation("run"), seq: 1 }],
			["op.state", { namespace: "op.state", key: "operation", value: checkpointState(), seq: 1 }],
			["op.tool_args", { namespace: "op.tool_args", key: "operation:step:0", value: {}, seq: 1 }],
			[
				"op.preparation",
				{
					namespace: "op.preparation",
					key: "operation:task",
					value: {
						kind: "branch_summary",
						messages: [],
						fileOps: { read: [], written: [], edited: [] },
						totalTokens: 0,
					},
					seq: 1,
				},
			],
		];

		for (const [namespace, register] of invalidRegisters) {
			expect(() => codec.decodeRegister(namespace, register)).toThrow(SessionCodecError);
		}
		expect(() =>
			codec.decodeRegister("op.meta", {
				namespace: "op.meta",
				key: PARENT_ID,
				value: operation("run"),
				seq: 1,
			}),
		).toThrow("op.meta register key must equal value.operationId");
		expect(() =>
			codec.decodeRegister("op.tool_args", {
				namespace: "op.tool_args",
				key: `${OPERATION_ID}:${STEP_ID}:9007199254740992`,
				value: {},
				seq: 1,
			}),
		).toThrow("sourceIndex must be a safe integer");

		expect(() =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value: { ...checkpointState(), phase: { ...checkpointState().phase, triggerEntryId: "trigger" } },
				seq: 1,
			}),
		).toThrow(SessionCodecError);
	});

	it("requires tool-result reservations to follow the assistant UUIDv7 timestamp", () => {
		const codec = new SessionCodec();
		const toolState = (resultEntryIds: string[], turnId = STEP_ID): RunState => ({
			...checkpointState(),
			phase: {
				kind: "tools",
				batch: {
					assistantEntryId: ENTRY_ID,
					configuration,
					turnId,
					calls: resultEntryIds.map((resultEntryId, sourceIndex) => ({
						status: "planned" as const,
						sourceIndex,
						resultEntryId,
					})),
				},
			},
		});
		const decode = (state: RunState) =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value: state,
				seq: 1,
			});

		for (const state of [
			toolState([OTHER_TIMESTAMP_ID]),
			toolState([ENTRY_ID]),
			toolState([FOLLOWER_ID, FOLLOWER_ID]),
		]) {
			expect(() => decode(state)).toThrow(SessionCodecError);
		}
		const followerState = toolState([FOLLOWER_ID, SECOND_FOLLOWER_ID]);
		expect(decode(followerState)).toMatchObject({ value: followerState });
		expect(() => decode(toolState([FOLLOWER_ID], `${STEP_ID}:poll:0`))).toThrow(SessionCodecError);
		expect(() => decode(toolState([FOLLOWER_ID], `${STEP_ID}:poll:9007199254740992`))).toThrow(SessionCodecError);
	});

	it("requires complete source-ordered tool-call indexes", () => {
		const codec = new SessionCodec();
		const state = (sourceIndexes: number[]): RunState => ({
			...checkpointState(),
			phase: {
				kind: "tools",
				batch: {
					assistantEntryId: ENTRY_ID,
					configuration,
					turnId: STEP_ID,
					calls: sourceIndexes.map((sourceIndex, index) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: index === 0 ? FOLLOWER_ID : SECOND_FOLLOWER_ID,
					})),
				},
			},
		});
		const decode = (value: RunState) =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value,
				seq: 1,
			});

		expect(decode(state([0, 1]))).toMatchObject({ value: state([0, 1]) });
		expect(() => decode(state([0, 0]))).toThrow("complete and in source order");
		expect(() => decode(state([1]))).toThrow("complete and in source order");
	});

	it("keeps locally visible reserved entry and usage ids distinct", () => {
		const codec = new SessionCodec();
		const pendingGeneration = (responseEntryId: string, usageId: string): RunState => ({
			...checkpointState(),
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context: {
						stepId: STEP_ID,
						triggerEntryId: TRIGGER_ID,
						configuration,
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
						overflowRecoveryUsed: false,
					},
					attempt: 1,
					responseEntryId,
					usageId,
					intendedOutputLimit: 1,
					contextWindow: 1,
				},
			},
		});
		const decode = (state: OperationState) =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value: state,
				seq: 1,
			});

		expect(decode(pendingGeneration(ENTRY_ID, USAGE_ID))).toMatchObject({
			value: pendingGeneration(ENTRY_ID, USAGE_ID),
		});
		expect(() => decode(pendingGeneration(ENTRY_ID, ENTRY_ID))).toThrow("must be distinct");
		expect(() => decode(pendingGeneration(TRIGGER_ID, USAGE_ID))).toThrow("must be distinct");
	});

	it("keeps structural task identity stable and reserved rows distinct", () => {
		const codec = new SessionCodec();
		const summaryState = (
			contextTaskId: string,
			resultEntryId: string,
			usageIds: string[],
			requestUsageId: string,
		): OperationState => ({
			kind: "compaction",
			control: { status: "running" },
			structural: {
				taskId: TASK_ID,
				status: "generating",
				generation: {
					status: "effect_pending",
					context: {
						taskId: contextTaskId,
						resultEntryId,
						kind: "compaction",
						configuration,
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
					},
					attempt: 1,
					request: { index: 0, usageId: requestUsageId },
					usageIds,
				},
			},
		});
		const decode = (state: OperationState) =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value: state,
				seq: 1,
			});
		const valid = summaryState(TASK_ID, ENTRY_ID, [USAGE_ID], SECOND_FOLLOWER_ID);

		expect(decode(valid)).toMatchObject({ value: valid });
		expect(() => decode(summaryState(PARENT_ID, ENTRY_ID, [USAGE_ID], SECOND_FOLLOWER_ID))).toThrow(
			"task ids must match",
		);
		expect(() => decode(summaryState(TASK_ID, ENTRY_ID, [ENTRY_ID], SECOND_FOLLOWER_ID))).toThrow("must be distinct");
		expect(() => decode(summaryState(TASK_ID, ENTRY_ID, [USAGE_ID], USAGE_ID))).toThrow("must be distinct");
	});

	it("uses zero-based completed deferred polls and one-based pending poll intents", () => {
		const codec = new SessionCodec();
		const decode = (state: RunState) =>
			codec.decodeRegister("op.state", {
				namespace: "op.state",
				key: OPERATION_ID,
				value: state,
				seq: 1,
			});
		const suspended: RunState = {
			...checkpointState(),
			phase: {
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: STEP_ID,
					sourceEntryId: ENTRY_ID,
					poll: 0,
					configuration,
					streamOptions: {},
				},
			},
		};
		const pending = (poll: number, responseEntryId = FOLLOWER_ID, usageId = USAGE_ID): RunState => ({
			...suspended,
			phase: {
				kind: "deferred",
				deferred: {
					status: "effect_pending",
					stepId: STEP_ID,
					sourceEntryId: ENTRY_ID,
					poll,
					responseEntryId,
					usageId,
					configuration,
					streamOptions: {},
				},
			},
		});

		expect(decode(suspended)).toMatchObject({ value: suspended });
		expect(() => decode(pending(0))).toThrow(SessionCodecError);
		expect(decode(pending(1))).toMatchObject({ value: pending(1) });
		expect(() => decode(pending(1, ENTRY_ID, USAGE_ID))).toThrow("must be distinct");
		expect(() => decode(pending(1, FOLLOWER_ID, FOLLOWER_ID))).toThrow("must be distinct");
	});

	it("accepts every operation-state top-level discriminant and rejects malformed variants", () => {
		const codec = new SessionCodec();
		for (const [index, state] of operationStates().entries()) {
			const register = { namespace: "op.state", key: OPERATION_ID, value: state, seq: index + 1 };
			expect(codec.decodeRegister("op.state", register)).toEqual(register);
		}

		const malformed: unknown[] = [
			{ ...checkpointState(), kind: "unknown" },
			{ ...checkpointState(), phase: { kind: "assistant" } },
			{
				kind: "navigation",
				control: { status: "running" },
				targetId: null,
				summarize: true,
				phase: { kind: "ready_to_commit" },
			},
			{
				kind: "compaction",
				control: { status: "cancel_requested", requestedAt: NOW, drainedSteer: [] },
				structural: { status: "deciding", taskId: TASK_ID },
			},
		];
		for (const value of malformed) {
			expect(() =>
				codec.decodeRegister("op.state", { namespace: "op.state", key: OPERATION_ID, value, seq: 1 }),
			).toThrow(SessionCodecError);
		}
	});

	it("enforces namespace, key, value, and last-result combinations", () => {
		const codec = new SessionCodec();
		const invalidRegisters: Array<[RegisterNamespace, unknown]> = [
			["fact.name", { namespace: "fact.name", key: "not-empty", value: "name", seq: 1 }],
			["fact.name", { namespace: "fact.name", key: "", value: 1, seq: 1 }],
			["fact.label", { namespace: "fact.custom", key: "entry", value: "label", seq: 1 }],
			[
				"lane.config",
				{ namespace: "lane.config", key: "main", value: { ...configuration, thinkingLevel: "huge" }, seq: 1 },
			],
			[
				"lane.lastResult",
				{
					namespace: "lane.lastResult",
					key: "main",
					value: {
						operationId: OPERATION_ID,
						kind: "compaction",
						leafId: null,
						outcome: "completed",
						runCompletion: "assistant",
					},
					seq: 1,
				},
			],
			["pending.entry", { namespace: "pending.entry", key: PENDING_ID, value: { type: "message" }, seq: 1 }],
			[
				"pending.entry",
				{
					namespace: "pending.entry",
					key: PENDING_ID,
					value: { type: "message", customType: "note", payload: userMessage },
					seq: 1,
				},
			],
			["op.tool_args", { namespace: "op.tool_args", key: "missing-index", value: {}, seq: 1 }],
			["op.preparation", { namespace: "op.preparation", key: "missing-task", value: {}, seq: 1 }],
		];
		for (const [namespace, register] of invalidRegisters) {
			expect(() => codec.decodeRegister(namespace, register)).toThrow(SessionCodecError);
		}
	});
});

describe("SessionCodec usage and transactions", () => {
	it("decodes usage rows and rejects malformed ledger shape", () => {
		const codec = new SessionCodec();
		const row = {
			id: USAGE_ID,
			seq: 3,
			usage,
			entryId: ASSISTANT_ID,
			adjustment: false,
			details: { attempt: 1 },
		} satisfies UsageRow;
		expect(codec.decodeUsageRow(row)).toEqual(row);

		for (const invalid of [
			{ ...row, seq: 0 },
			{ ...row, adjustment: "false" },
			{ ...row, usage: { ...usage, cost: { total: 1 } } },
			{ ...row, extra: true },
		]) {
			expect(() => codec.decodeUsageRow(invalid)).toThrow(SessionCodecError);
		}
	});

	it("requires UUIDv7 usage and entry references", () => {
		const codec = new SessionCodec();
		const row = { id: USAGE_ID, seq: 1, usage, entryId: ENTRY_ID, adjustment: false };

		expect(codec.decodeUsageRow(row)).toEqual(row);
		expect(() => codec.decodeUsageRow({ ...row, id: "usage" })).toThrow(SessionCodecError);
		expect(() => codec.decodeUsageRow({ ...row, entryId: "entry" })).toThrow(SessionCodecError);
	});

	it("validates every write kind and a complete mapped transaction", () => {
		const codec = new SessionCodec();
		const transaction = {
			writes: [
				{ kind: "entry", entry: { id: MESSAGE_ID, parentId: null, type: "message", message: userMessage } },
				{ kind: "usage", row: { id: USAGE_ID, usage, entryId: MESSAGE_ID, adjustment: false, details: null } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: MESSAGE_ID },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "nullable", value: null },
				{ kind: "register", op: "delete", namespace: "fact.label", key: MESSAGE_ID },
			],
		} satisfies Transaction;

		expect(codec.encodeTransaction(transaction)).toEqual(transaction);
		expect(codec.decodeTransaction(transaction)).toEqual(transaction);
		for (const write of transaction.writes) expect(codec.decodeWrite(write)).toEqual(write);
	});

	it("applies namespace-specific UUIDv7 key schemas to register writes", () => {
		const codec = new SessionCodec();
		for (const write of [
			{ kind: "register", op: "delete", namespace: "fact.label", key: "entry" },
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: "pending",
				value: { type: "message", payload: userMessage },
			},
			{ kind: "register", op: "set", namespace: "op.tool_args", key: "operation:step:0", value: {} },
			{
				kind: "register",
				op: "set",
				namespace: "op.tool_args",
				key: `${OPERATION_ID}:${STEP_ID}:9007199254740992`,
				value: {},
			},
		]) {
			expect(() => codec.decodeWrite(write)).toThrow(SessionCodecError);
			expect(() => codec.decodeTransaction({ writes: [write] })).toThrow(SessionCodecError);
		}
	});

	it("accepts deletion of UUIDv7-keyed registers without requiring a value", () => {
		const codec = new SessionCodec();
		const transaction: Transaction = {
			writes: [
				{ kind: "register", op: "delete", namespace: "op.state", key: OPERATION_ID },
				{ kind: "register", op: "delete", namespace: "pending.entry", key: PENDING_ID },
			],
		};

		expect(codec.encodeTransaction(transaction)).toEqual(transaction);
		expect(() =>
			codec.decodeWrite({
				kind: "register",
				op: "delete",
				namespace: "op.tool_args",
				key: `${OPERATION_ID}:${STEP_ID}:9007199254740992`,
			}),
		).toThrow("sourceIndex must be a safe integer");
	});

	it("rejects malformed write discriminants and mapped register set values", () => {
		const codec = new SessionCodec();
		for (const write of [
			{ kind: "other" },
			{ kind: "entry", row: {} },
			{ kind: "usage", row: { id: USAGE_ID, usage, adjustment: false, seq: 1 } },
			{ kind: "register", op: "replace", namespace: "fact.name", key: "", value: "name" },
			{ kind: "register", op: "set", namespace: "fact.name", key: "", value: null },
			{ kind: "register", op: "delete", namespace: "unknown", key: "key" },
		]) {
			expect(() => codec.decodeWrite(write)).toThrow(SessionCodecError);
		}
		expect(() => codec.decodeTransaction({ writes: [{ kind: "other" }] })).toThrow(/\$\.writes\[0\]/);
	});
});

describe("SessionCodec durable JSON boundary", () => {
	it.each(invalidJsonValues())("rejects $name before persistence with a useful path", ({ value }) => {
		const codec = new SessionCodec();
		expect(() => codec.encodeTransaction(transactionWithCustomValue(value))).toThrow(/\$\.writes\[0\]\.value/);
	});

	it.each(invalidJsonValues())("rejects $name while decoding stored data with a useful path", ({ value }) => {
		const codec = new SessionCodec();
		const entry = stored({
			id: CUSTOM_ID,
			parentId: null,
			type: "custom",
			customType: "data",
			data: value,
		} as unknown as NewEntry);
		expect(() => codec.decodeEntry(entry)).toThrow(/\$\.data/);
	});

	it("preserves null and absent optional fields and detaches input and decoded output", () => {
		const codec = new SessionCodec();
		const source = {
			writes: [
				{
					kind: "entry",
					entry: {
						id: CUSTOM_ID,
						parentId: null,
						type: "custom",
						customType: "data",
						data: { nested: [null, { value: 1 }] },
					},
				},
				{ kind: "register", op: "set", namespace: "fact.custom", key: "null", value: null },
			],
		} satisfies Transaction;
		const encoded = codec.encodeTransaction(source);
		const decoded = codec.decodeTransaction(source);

		expect(encoded).toEqual(source);
		expect(decoded).toEqual(source);
		const absentData = codec.decodeEntry(
			stored({ id: MARKER_ID, parentId: null, type: "custom", customType: "marker" }),
		);
		expect(absentData.type).toBe("custom");
		expect("data" in absentData).toBe(false);
		const sourceData = (source.writes[0] as Extract<Transaction["writes"][number], { kind: "entry" }>).entry;
		if (sourceData.type !== "custom" || sourceData.data === undefined) throw new Error("invalid test fixture");
		(sourceData.data as { nested: Array<unknown> }).nested[1] = { value: 99 };
		expect(encoded).not.toEqual(source);
		expect(decoded).not.toEqual(source);
	});
});
