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
	Transaction,
	UsageRow,
} from "../../src/harness/session/types.ts";

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

function checkpointState(): OperationState {
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
			triggerEntryId: "trigger",
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

function operation(kind: Operation["intent"]["kind"]): Operation {
	const base = { operationId: `operation-${kind}`, lane: "main", sourceLeafId: null, startedAt: NOW };
	switch (kind) {
		case "run":
			return { ...base, intent: { kind, promptEntryIds: ["prompt"], resumeData: { extension: null } } };
		case "compaction":
			return { ...base, intent: { kind, customInstructions: "short" } };
		case "navigation":
			return { ...base, intent: { kind, targetId: "target", summarize: true, label: "target" } };
	}
}

function operationStates(): OperationState[] {
	return [
		checkpointState(),
		{
			kind: "compaction",
			control: { status: "running" },
			customInstructions: "short",
			structural: { status: "deciding", taskId: "task" },
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
			targetId: "target",
			summarize: true,
			phase: { kind: "summary", structural: { status: "deciding", taskId: "task" } },
		},
	];
}

function registerValue<TNamespace extends RegisterNamespace>(
	namespace: TNamespace,
	value: RegisterValues[TNamespace],
	key = namespace === "fact.name" ? "" : "key",
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
			stored({ id: "user", parentId: null, type: "message", message: userMessage }),
			stored({ id: "assistant", parentId: "user", type: "message", message: assistantMessage }),
			stored({ id: "tool", parentId: "assistant", type: "message", message: toolResultMessage, terminate: true }),
			stored({
				id: "compaction",
				parentId: "tool",
				type: "compaction",
				summary: "summary",
				retainedTail: [userMessage, assistantMessage, toolResultMessage],
				tokensBefore: 100,
				details: { source: "generated" },
				usage,
				fromHook: false,
			}),
			stored({
				id: "summary",
				parentId: "compaction",
				type: "branch_summary",
				fromId: "tool",
				summary: "branch summary",
				details: null,
				usage,
				fromHook: true,
			}),
			stored({ id: "marker", parentId: "summary", type: "custom", customType: "marker" }),
			stored({ id: "note", parentId: "marker", type: "custom", customType: "note", data: { text: "remember" } }),
		] satisfies Entry[];

		expect(entries.map((entry) => codec.decodeEntry(entry))).toEqual(entries);
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
			id: "notice",
			parentId: null,
			type: "message",
			message: customMessage,
		} as unknown as NewEntry);

		const newEntry = { id: "notice", parentId: null, type: "message", message: customMessage };
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
				codec.decodeEntry(stored({ id: "bad", parentId: null, type: "message", message } as unknown as NewEntry)),
			).toThrow(SessionCodecError);
			expect(() =>
				codec.decodeWrite({ kind: "entry", entry: { id: "bad", parentId: null, type: "message", message } }),
			).toThrow(SessionCodecError);
			expect(() =>
				codec.encodeTransaction({
					writes: [{ kind: "entry", entry: { id: "bad", parentId: null, type: "message", message } }],
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
			const entry = { id: `bad-${message.role}`, parentId: null, type: "message", message };
			expect(() => codec.decodeEntry(stored(entry as unknown as NewEntry))).toThrow(SessionCodecError);
			expect(() => codec.decodeWrite({ kind: "entry", entry })).toThrow(SessionCodecError);
			expect(() => codec.decodeTransaction({ writes: [{ kind: "entry", entry }] })).toThrow(SessionCodecError);
			expect(() =>
				codec.decodeRegister("pending.entry", {
					namespace: "pending.entry",
					key: `pending-${message.role}`,
					value: { type: "message", payload: message },
					seq: 1,
				}),
			).toThrow(SessionCodecError);
		}
	});

	it("does not let a permissive custom schema admit malformed built-in messages", () => {
		const codec = new SessionCodec({ customMessageSchemas: { notice: Type.Any() } });
		const malformedUser = { role: "user", content: 42, timestamp: NOW };
		const entry = { id: "malformed-user", parentId: null, type: "message", message: malformedUser };

		expect(() => codec.decodeEntry(stored(entry as unknown as NewEntry))).toThrow(SessionCodecError);
		expect(() => codec.decodeWrite({ kind: "entry", entry })).toThrow(SessionCodecError);
		expect(() => codec.decodeTransaction({ writes: [{ kind: "entry", entry }] })).toThrow(SessionCodecError);
		expect(() =>
			codec.decodeRegister("pending.entry", {
				namespace: "pending.entry",
				key: "pending-user",
				value: { type: "message", payload: malformedUser },
				seq: 1,
			}),
		).toThrow(SessionCodecError);
	});

	it("rejects pending assistants, malformed entry discriminants, structural omissions, and invalid termination", () => {
		const codec = new SessionCodec();
		const pending = { ...assistantMessage, stopReason: "pending" };
		const invalidEntries: unknown[] = [
			stored({ id: "pending", parentId: null, type: "message", message: pending } as unknown as NewEntry),
			stored({
				id: "message",
				parentId: null,
				type: "message",
				customType: "wrong",
				message: userMessage,
			} as unknown as NewEntry),
			stored({ id: "custom", parentId: null, type: "custom", data: null } as unknown as NewEntry),
			stored({
				id: "custom",
				parentId: null,
				type: "custom",
				customType: "note",
				message: userMessage,
			} as unknown as NewEntry),
			stored({
				id: "compaction",
				parentId: null,
				type: "compaction",
				summary: "missing tail",
				tokensBefore: 1,
				fromHook: false,
			} as unknown as NewEntry),
			stored({
				id: "compaction",
				parentId: null,
				type: "compaction",
				summary: "missing hook",
				retainedTail: [],
				tokensBefore: 1,
			} as unknown as NewEntry),
			stored({
				id: "summary",
				parentId: null,
				type: "branch_summary",
				fromId: "from",
				summary: "missing hook",
			} as unknown as NewEntry),
			stored({
				id: "user",
				parentId: null,
				type: "message",
				message: userMessage,
				terminate: true,
			} as unknown as NewEntry),
			stored({
				id: "tool",
				parentId: null,
				type: "message",
				message: toolResultMessage,
				terminate: false,
			} as unknown as NewEntry),
			{ ...stored({ id: "seq", parentId: null, type: "custom", customType: "note" }), seq: 0 },
			{ ...stored({ id: "timestamp", parentId: null, type: "custom", customType: "note" }), timestamp: -1 },
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
				register: registerValue("lane.state", { currentOperationId: "operation-run", pendingNextRun: ["pending"] }),
			},
			{
				namespace: "lane.lastResult",
				register: registerValue("lane.lastResult", {
					operationId: "operation-run",
					kind: "run",
					leafId: "assistant",
					finalAssistantEntryId: "assistant",
					outcome: "completed",
					runCompletion: "assistant",
				}),
			},
			{ namespace: "op.meta", register: registerValue("op.meta", operation("run"), "operation-run") },
			{ namespace: "op.state", register: registerValue("op.state", checkpointState()) },
			{
				namespace: "op.tool_args",
				register: registerValue("op.tool_args", { path: "README.md", line: 1 }, "op:step:0"),
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
					"op:task",
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
					"op:task",
				),
			},
			{
				namespace: "pending.entry",
				register: {
					namespace: "pending.entry",
					key: "pending",
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

	it("accepts every operation-state top-level discriminant and rejects malformed variants", () => {
		const codec = new SessionCodec();
		for (const [index, state] of operationStates().entries()) {
			const register = { namespace: "op.state", key: `operation-${index}`, value: state, seq: index + 1 };
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
				structural: { status: "deciding", taskId: "task" },
			},
		];
		for (const value of malformed) {
			expect(() =>
				codec.decodeRegister("op.state", { namespace: "op.state", key: "operation", value, seq: 1 }),
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
						operationId: "op",
						kind: "compaction",
						leafId: null,
						outcome: "completed",
						runCompletion: "assistant",
					},
					seq: 1,
				},
			],
			["pending.entry", { namespace: "pending.entry", key: "pending", value: { type: "message" }, seq: 1 }],
			[
				"pending.entry",
				{
					namespace: "pending.entry",
					key: "pending",
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
			id: "usage",
			seq: 3,
			usage,
			entryId: "assistant",
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

	it("validates every write kind and a complete mapped transaction", () => {
		const codec = new SessionCodec();
		const transaction = {
			writes: [
				{ kind: "entry", entry: { id: "message", parentId: null, type: "message", message: userMessage } },
				{ kind: "usage", row: { id: "usage", usage, entryId: "message", adjustment: false, details: null } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "message" },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "nullable", value: null },
				{ kind: "register", op: "delete", namespace: "fact.label", key: "message" },
			],
		} satisfies Transaction;

		expect(codec.encodeTransaction(transaction)).toEqual(transaction);
		expect(codec.decodeTransaction(transaction)).toEqual(transaction);
		for (const write of transaction.writes) expect(codec.decodeWrite(write)).toEqual(write);
	});

	it("rejects malformed write discriminants and mapped register set values", () => {
		const codec = new SessionCodec();
		for (const write of [
			{ kind: "other" },
			{ kind: "entry", row: {} },
			{ kind: "usage", row: { id: "usage", usage, adjustment: false, seq: 1 } },
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
			id: "custom",
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
						id: "custom",
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
			stored({ id: "marker", parentId: null, type: "custom", customType: "marker" }),
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
