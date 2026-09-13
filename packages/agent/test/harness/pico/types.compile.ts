import type {
	AssistantMessage,
	DeferredHandle,
	Message,
	RetryPolicy,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@draht/ai";
import type { Context } from "@draht/chord";
import { defineInternalList, internalConversationValue } from "../../../src/harness/pico/addresses.ts";
import type {
	Acceptance,
	AssistantEntryData,
	BaseTaskTx,
	BoundTxState,
	ConversationTx,
	Entry,
	EntryBase,
	EntryData,
	EntryInput,
	ExactJsonInput,
	GenerationOutput,
	HookHandler,
	HookPoint,
	HookResult,
	HostTx,
	InputOutcome,
	JsonObject,
	JsonValue,
	List,
	OutputState,
	PayloadsOf,
	PublicScope,
	QueuedInput,
	ReadonlyTaskOutput,
	ResolvedValue,
	RunningTask,
	ScratchReader,
	SectionRecord,
	Stored,
	StoredEntryDraft,
	StoredInputResult,
	SummaryEntry,
	SystemEntryData,
	TaskCheckpoint,
	TaskKind,
	TaskOf,
	TaskOutput,
	TaskOutputRef,
	TaskRuntime,
	TerminalClosure,
	ToolControl,
	ToolDiagnostic,
	ToolInput,
	ToolOutputState,
	ToolResultData,
	TxState,
	UsageEntryData,
	UserInput,
} from "../../../src/harness/pico/index.ts";
import * as Pico from "../../../src/harness/pico/index.ts";
import {
	conversationList,
	conversationValue,
	defineEntry,
	defineHookPoint,
	defineList,
	defineTask,
	defineTaskOutput,
	defineValue,
	sessionValue,
} from "../../../src/harness/pico/index.ts";
import type { CoreAbortTaskRuntime, CoreTaskRuntime, CoreTaskTx } from "../../../src/harness/pico/runtime.ts";
import type { DisjointBundles } from "../../../src/harness/pico/tasks.ts";
import * as TaskDeclarations from "../../../src/harness/pico/tasks.ts";
import { defineCoreTask } from "../../../src/harness/pico/tasks.ts";

// @ts-expect-error privileged core authoring is not part of the public Pico surface
const publicDefineCoreTask = Pico.defineCoreTask;
// @ts-expect-error the task-kind brand is private even within the tasks module
const publicTaskKindBrand = TaskDeclarations.taskKindBrand;
void publicDefineCoreTask;
void publicTaskKindBrand;

type RemovedPublicExports = [
	// @ts-expect-error low-level Session is internal
	Pico.Session,
	// @ts-expect-error low-level transaction is internal
	Pico.Transaction,
	// @ts-expect-error low-level task creation shape is internal
	Pico.TaskCreate,
	// @ts-expect-error stored conversation metadata is internal
	Pico.StoredConversation,
	// @ts-expect-error core kind construction types are internal
	Pico.CoreTaskKind,
	// @ts-expect-error erased core kind is internal
	Pico.CoreKind,
	// @ts-expect-error collision implementation helpers are internal
	Pico.DisjointBundles,
];
declare const removedPublicExports: RemovedPublicExports;
void removedPublicExports;

type Equal<Left, Right> = (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
	? (<Type>() => Type extends Right ? 1 : 2) extends <Type>() => Type extends Left ? 1 : 2
		? true
		: false
	: false;
type Assert<Condition extends true> = Condition;
type ExtendsJson<T extends JsonValue> = T;
type ExtendsJsonObject<T extends JsonObject> = T;

type StoredAssertions = [
	ExtendsJsonObject<Stored<UserMessage>>,
	ExtendsJsonObject<Stored<AssistantMessage>>,
	ExtendsJsonObject<Stored<ToolResultMessage>>,
	ExtendsJsonObject<Stored<ToolCall>>,
	ExtendsJsonObject<Stored<Usage>>,
	ExtendsJsonObject<Stored<DeferredHandle>>,
	ExtendsJsonObject<Stored<RetryPolicy>>,
	ExtendsJson<Stored<UserInput>>,
	ExtendsJson<ToolInput>,
	ExtendsJson<UsageEntryData>,
	ExtendsJson<QueuedInput>,
	ExtendsJson<StoredEntryDraft>,
	ExtendsJson<SystemEntryData>,
	ExtendsJson<AssistantEntryData>,
	ExtendsJson<ToolResultData>,
	ExtendsJson<Acceptance>,
	ExtendsJson<SectionRecord>,
	ExtendsJson<ToolControl>,
	ExtendsJson<ToolDiagnostic>,
	Assert<GenerationOutput extends OutputState ? true : false>,
	Assert<ToolOutputState extends OutputState ? true : false>,
	Assert<Date extends JsonValue ? false : true>,
	Assert<{ readonly value: undefined } extends JsonValue ? false : true>,
];

type Input = { readonly prompt: string; readonly nested: { readonly count: number } };
type Checkpoint = { readonly phase: "ready"; readonly cursor: number };
type Result = { readonly answer: string };
type Failure = { readonly code: "failed" };
type Aborted = { readonly cleaned: boolean };
type Progress = { text: string; chunks: string[] };

const pluginEnabled = conversationValue<boolean>("plugin.enabled", { rewind: false, default: false });
const collected = defineHookPoint<{ readonly value: string }, { readonly seen: true }>({
	fold: "collect",
	onThrow: "skip",
});
const first = defineHookPoint<{ readonly value: string }, { readonly accepted: true }>({
	fold: "first",
	onThrow: "skip",
});
const beforeRun = defineHookPoint<{ readonly prompt: string }, { readonly prompt?: string }>({
	fold: "chain",
	onThrow: "skip",
});
const noReturnHandler: HookHandler<typeof beforeRun> = async () => {};
void noReturnHandler;

const ordinaryKind = defineTask<Input, Checkpoint, Result, Failure, Aborted>()({
	kind: "plugin.ordinary",
	config: { enabled: pluginEnabled },
	hooks: { beforeRun },
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const coreKind = defineCoreTask<Input, Checkpoint, Result, Failure, Aborted>()({
	kind: "pi.test_core",
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

const progressOutput = defineTaskOutput<Progress>("plugin.progress");
const outputKind = defineTask<Input, Checkpoint, Result, Failure, Aborted, Progress>()({
	kind: "plugin.output",
	output: { kind: progressOutput, initial: (input) => ({ text: input.prompt, chunks: [] }) },
	execute() {
		return Promise.resolve(() => ({ status: "completed", result: { answer: "done" } }));
	},
	recover() {
		return Promise.resolve(() => ({ status: "failed", failure: { code: "failed" } }));
	},
	abort() {
		return Promise.resolve(() => ({ cleaned: true }));
	},
});

type HookAssertions = [
	Assert<Equal<typeof collected, HookPoint<{ readonly value: string }, { readonly seen: true }, "collect">>>,
	Assert<Equal<typeof first, HookPoint<{ readonly value: string }, { readonly accepted: true }, "first">>>,
	Assert<Equal<typeof beforeRun, HookPoint<{ readonly prompt: string }, { readonly prompt?: string }, "chain">>>,
	Assert<
		Equal<
			HookResult<typeof collected>,
			{ readonly outputs: readonly { readonly seen: true }[]; readonly threw?: unknown }
		>
	>,
	Assert<Equal<HookResult<typeof first>, { readonly output?: { readonly accepted: true }; readonly threw?: unknown }>>,
];
type InferredHooks = PayloadsOf<typeof ordinaryKind>["hooks"];
type KindAssertions = [
	Assert<Equal<typeof ordinaryKind.config.enabled, typeof pluginEnabled>>,
	Assert<Equal<typeof ordinaryKind.hooks.beforeRun, typeof beforeRun>>,
	Assert<Equal<keyof InferredHooks, "beforeRun">>,
	Assert<Equal<InferredHooks["beforeRun"], typeof beforeRun>>,
	Assert<
		Equal<
			Parameters<typeof ordinaryKind.execute>[1],
			TaskRuntime<Input, Checkpoint, never, typeof ordinaryKind.hooks>
		>
	>,
	Assert<Equal<Parameters<typeof coreKind.execute>[1], CoreTaskRuntime<Input, Checkpoint>>>,
	Assert<Equal<Parameters<typeof outputKind.execute>[1]["output"], TaskOutput<Progress>>>,
	Assert<Equal<Parameters<typeof outputKind.abort>[1]["output"], ReadonlyTaskOutput<Progress>>>,
	Assert<
		Equal<
			Extract<TaskOf<typeof ordinaryKind>, { status: "terminal" }>["outcome"]["status"],
			"completed" | "failed" | "aborted" | "orphaned"
		>
	>,
];

function verifyNoOutputRuntime(
	runtime: TaskRuntime<Input, Checkpoint>,
	abortRuntime: Parameters<typeof ordinaryKind.abort>[1],
	finalTx: Parameters<TerminalClosure<Input, Checkpoint, Result, Failure, never>>[0],
	running: RunningTask<Input, Checkpoint>,
	ctx: Context,
): void {
	// @ts-expect-error no-output runtimes have no output property
	void runtime.output;
	// @ts-expect-error no-output abort runtimes have no output property
	void abortRuntime.output;
	// @ts-expect-error no-output final transactions have no output property
	void finalTx.output;
	// @ts-expect-error no-output running tasks have no output property
	void running.output;
	void abortRuntime.sleep(1, ctx);
}

function verifyOutput(output: TaskOutput<Progress>, readonlyOutput: ReadonlyTaskOutput<Progress>, ctx: Context): void {
	void output.mutate((state) => {
		state.chunks.push("next");
	}, ctx);
	// @ts-expect-error output mutations must be synchronous
	void output.mutate(async (state) => {
		state.text = "invalid";
	}, ctx);
	// @ts-expect-error fresh abort receives read-only output
	void readonlyOutput.mutate;
}

type JobOutput = {
	stdout: string;
	stderr: string;
	droppedStdout: number;
	droppedStderr: number;
	exitCode?: number;
	occurrence: number;
};
type JobAssertions = [Assert<JobOutput extends OutputState ? true : false>];
function verifyJobMutation(output: TaskOutput<JobOutput>, snapshot: Readonly<JobOutput>, ctx: Context): void {
	void output.mutate((state) => {
		state.stdout = snapshot.stdout;
	}, ctx);
}

type NoteEntry = EntryBase & EntryData<{ readonly text: string }>;
type PinnedEntry = EntryBase &
	EntryData<{ readonly text: string }> & {
		readonly model: readonly [Stored<UserMessage>];
	};
const noteKind = defineEntry<NoteEntry>("plugin.note");
const pinnedKind = defineEntry<PinnedEntry>("plugin.pinned");
const summaryKind = defineEntry<SummaryEntry>("pi.summary");

function verifyEntryInputs(tx: ConversationTx, text: string): void {
	void tx.write(noteKind, { data: { text } });
	void tx.write(pinnedKind, {
		data: { text },
		model: [{ role: "user", content: text, timestamp: 1 }],
	});
	void tx.write(summaryKind, {
		data: { through: 1 },
		model: [{ role: "user", content: text, timestamp: 1 }],
		head: "self",
	});
	// @ts-expect-error kind is supplied by the witness
	void tx.write(noteKind, { kind: "plugin.note", data: { text } });
	// @ts-expect-error id is supplied by Pico
	void tx.write(noteKind, { id: 1, data: { text } });
}

type EntryAssertions = [
	Assert<NoteEntry extends Entry ? true : false>,
	Assert<PinnedEntry extends Entry ? true : false>,
	Assert<SummaryEntry extends Entry ? true : false>,
	Assert<Equal<EntryInput<SummaryEntry>["head"], number | "self">>,
];

function verifyHostTaskCreation(tx: HostTx): void {
	tx.task(ordinaryKind, { conversationId: 1, input: { prompt: "host", nested: { count: 1 } } });
	// @ts-expect-error host task creation requires a conversation ID
	tx.task(ordinaryKind, { input: { prompt: "host", nested: { count: 1 } } });
}

function verifyTaskCreation(
	tx: BaseTaskTx<Checkpoint>,
	coreTx: CoreTaskTx<Checkpoint>,
	outputRef: TaskOutputRef<Progress>,
): void {
	tx.task(ordinaryKind, { input: { prompt: "literal", nested: { count: 1 } } });
	const exact = { input: { prompt: "variable", nested: { count: 1 } } };
	tx.task(ordinaryKind, exact);
	tx.task(ordinaryKind, { ...exact });
	// @ts-expect-error ordinary transactions cannot create core tasks
	tx.task(coreKind, { input: { prompt: "core", nested: { count: 1 } } });
	coreTx.task(coreKind, { input: { prompt: "core", nested: { count: 1 } } });

	// @ts-expect-error input literals reject visible top-level extras
	tx.task(ordinaryKind, { input: { prompt: "extra", nested: { count: 1 }, extra: 1 } });
	const extraInput = { prompt: "extra", nested: { count: 1 }, extra: 1 };
	// @ts-expect-error input variables reject visible top-level extras
	tx.task(ordinaryKind, { input: extraInput });
	const inputBase = { prompt: "extra", nested: { count: 1 } };
	// @ts-expect-error input spreads reject visible top-level extras
	tx.task(ordinaryKind, { input: { ...inputBase, extra: 1 } });
	const extraSpec = { input: { prompt: "extra", nested: { count: 1 } }, extra: 1 };
	// @ts-expect-error specs reject visible extras
	tx.task(ordinaryKind, extraSpec);
	// @ts-expect-error spread specs reject visible extras
	tx.task(ordinaryKind, { ...extraSpec });

	// Deep exactness is outside the contract.
	tx.task(ordinaryKind, { input: { prompt: "nested", nested: { count: 1, extension: true } } });
	tx.task(outputKind, { input: { prompt: "output", nested: { count: 1 } }, output: outputRef });
	// @ts-expect-error no-output kinds reject output refs
	tx.task(ordinaryKind, { input: { prompt: "output", nested: { count: 1 } }, output: outputRef });
}

function verifyAddresses(): void {
	const rewindable = conversationValue<boolean>("plugin.plan", { rewind: true });
	const defaulted = conversationValue<boolean>("plugin.plan", { key: "defaulted", rewind: true, default: false });
	const sticky = conversationValue<string>("plugin.mode", { rewind: false });
	const events = conversationList<string>("plugin.events", { rewind: true });
	const plainSession = sessionValue<string>("plugin.plain-name");
	const defaultedSession = sessionValue<string>("plugin.name", { default: "pico" });
	const directPlainSession = defineValue<string>({ type: "session" }, "plugin.direct-session");
	const directDefaultedSession = defineValue<string>({ type: "session" }, "plugin.direct-session-default", {
		default: "session",
	});
	const directDefaultedTask = defineValue<string>({ type: "task", taskId: 1 }, "plugin.direct-task-default", {
		default: "task",
	});
	const directPlainConversation = defineValue<boolean>(
		{ type: "conversation", conversationId: 1 },
		"plugin.direct-conversation",
		{ rewind: true },
	);
	const directDefaultedConversation = defineValue<boolean>(
		{ type: "conversation", conversationId: 1 },
		"plugin.direct-conversation-default",
		{ rewind: false, default: false },
	);
	const bound = rewindable.bind(1);
	const defaultedBound = defaulted.bind(1);
	const internalDefaulted = internalConversationValue<string, true>("pi.internal-default", {
		rewind: true,
		default: "internal",
	});
	const internalDefaultedBound = internalDefaulted.bind(1);
	const boundList: List<string> = events.bind(1);
	void sticky;
	void bound;
	void defaultedBound;
	void internalDefaulted;
	void internalDefaultedBound;
	void boundList;
	void plainSession;
	void defaultedSession;
	void directPlainSession;
	void directDefaultedSession;
	void directDefaultedTask;
	void directPlainConversation;
	void directDefaultedConversation;

	type AddressAssertions = [
		Assert<Equal<(typeof rewindable)["rewind"], true>>,
		Assert<Equal<(typeof sticky)["rewind"], false>>,
		Assert<Equal<ResolvedValue<typeof plainSession>, string | undefined>>,
		Assert<Equal<ResolvedValue<typeof defaultedSession>, string>>,
		Assert<Equal<ResolvedValue<typeof directPlainSession>, string | undefined>>,
		Assert<Equal<ResolvedValue<typeof directDefaultedSession>, string>>,
		Assert<Equal<ResolvedValue<typeof directDefaultedTask>, string>>,
		Assert<Equal<ResolvedValue<typeof directPlainConversation>, boolean | undefined>>,
		Assert<Equal<ResolvedValue<typeof directDefaultedConversation>, boolean>>,
		Assert<Equal<(typeof directDefaultedSession)["default"], string>>,
		Assert<Equal<(typeof directDefaultedTask)["default"], string>>,
		Assert<Equal<(typeof directDefaultedConversation)["default"], boolean>>,
		Assert<Equal<ResolvedValue<typeof rewindable>, boolean | undefined>>,
		Assert<Equal<ResolvedValue<typeof defaulted>, boolean>>,
		Assert<Equal<ResolvedValue<typeof bound>, boolean | undefined>>,
		Assert<Equal<ResolvedValue<typeof defaultedBound>, boolean>>,
		Assert<Equal<(typeof defaultedBound)["default"], boolean>>,
		Assert<Equal<ResolvedValue<typeof internalDefaulted>, string>>,
		Assert<Equal<ResolvedValue<typeof internalDefaultedBound>, string>>,
		Assert<Equal<(typeof defaultedSession)["default"], string>>,
		Assert<Extract<PublicScope, { type: "shared" }> extends never ? true : false>,
	];
	const assertions = null as unknown as AddressAssertions;
	void assertions;

	// @ts-expect-error public bound constructors do not accept shared scope
	defineValue<string>({ type: "shared", id: 1 }, "plugin.shared");
	// @ts-expect-error public bound constructors do not accept shared scope
	defineList<string>({ type: "shared", id: 1 }, "plugin.shared");
	// @ts-expect-error conversation addresses require an explicit rewind policy
	defineValue<string>({ type: "conversation", conversationId: 1 }, "plugin.value");
	// @ts-expect-error session addresses are sticky
	defineValue<string>({ type: "session" }, "plugin.value", { rewind: true });
	defineInternalList<JsonValue>({ type: "shared", id: 1 }, "pi.output");
}

function verifyResolvedTransactionReads(tx: TxState, boundTx: BoundTxState, scratch: ScratchReader): void {
	const plainSession = defineValue<string>({ type: "session" }, "plugin.tx-plain");
	const defaultedSession = defineValue<string>({ type: "session" }, "plugin.tx-default", { default: "x" });
	const defaultedTask = defineValue<number>({ type: "task", taskId: 1 }, "plugin.scratch-default", {
		default: 1,
	});
	const defaultedConversation = defineValue<boolean>(
		{ type: "conversation", conversationId: 1 },
		"plugin.tx-conversation-default",
		{ rewind: true, default: false },
	);
	const plainDefinition = conversationValue<number>("plugin.bound-plain", { rewind: true });
	const defaultedDefinition = conversationValue<number>("plugin.bound-default", { rewind: false, default: 1 });
	const plainRead = tx.value(plainSession).get();
	const defaultedRead = tx.value(defaultedSession).get();
	const defaultedConversationRead = tx.value(defaultedConversation).get();
	const plainDefinitionRead = boundTx.value(plainDefinition).get();
	const defaultedDefinitionRead = boundTx.value(defaultedDefinition).get();
	const scratchRead = scratch.value(defaultedTask).get();
	type ReadAssertions = [
		Assert<Equal<Awaited<typeof plainRead>, string | undefined>>,
		Assert<Equal<Awaited<typeof defaultedRead>, string>>,
		Assert<Equal<Awaited<typeof defaultedConversationRead>, boolean>>,
		Assert<Equal<Awaited<typeof plainDefinitionRead>, number | undefined>>,
		Assert<Equal<Awaited<typeof defaultedDefinitionRead>, number>>,
		Assert<Equal<Awaited<typeof scratchRead>, number>>,
	];
	const assertions = null as unknown as ReadAssertions;
	void assertions;
}

type FakeDuplicateConfigs = { one: { value: 1 }; two: { value: 2 } };
type FakeReservedConfig = { one: { set: 1 }; two: Record<never, never> };
type FakeDuplicateHooks = { one: { before: 1 }; two: { before: 2 } };
type RealConfigs = { one: { model: 1 }; two: { retry: 2 } };
type RealHooks = { one: { before: 1 }; two: { after: 2 } };
type BundleAssertions = [Assert<DisjointBundles<RealConfigs, "set" | "get">>, Assert<DisjointBundles<RealHooks>>];
type BadBundleAssertions = [
	// @ts-expect-error duplicate bundle keys are rejected by the assertion
	Assert<DisjointBundles<FakeDuplicateConfigs, "set" | "get">>,
	// @ts-expect-error reserved config keys are rejected by the assertion
	Assert<DisjointBundles<FakeReservedConfig, "set" | "get">>,
	// @ts-expect-error duplicate hook keys are rejected by the assertion
	Assert<DisjointBundles<FakeDuplicateHooks>>,
];

type ExactInputAssertion = Assert<
	Equal<ExactJsonInput<Input, Input & { readonly extension: boolean }>["extension"], never>
>;
type CheckpointAssertion = Assert<
	{ readonly phase: "deferred"; readonly handle: Stored<DeferredHandle> } extends TaskCheckpoint ? true : false
>;
type HydrationAssertions = [
	Assert<Extract<InputOutcome, { status: "placed" }>["input"] extends Entry ? true : false>,
	Assert<
		Equal<
			Extract<InputOutcome, { status: "done" }>["answer"] extends infer A | undefined
				? NonNullable<A> extends { message: infer M }
					? M
					: never
				: never,
			AssistantMessage
		>
	>,
	ExtendsJson<StoredInputResult>,
];
type KindShape = TaskKind<Input, Checkpoint, Result, Failure, Aborted>;
type RunningAssertion = Assert<"output" extends keyof RunningTask<Input, Checkpoint> ? false : true>;

declare const storedAssertions: StoredAssertions;
declare const hookAssertions: HookAssertions;
declare const kindAssertions: KindAssertions;
declare const jobAssertions: JobAssertions;
declare const entryAssertions: EntryAssertions;
declare const bundleAssertions: BundleAssertions;
declare const badBundleAssertions: BadBundleAssertions;
declare const exactInputAssertion: ExactInputAssertion;
declare const checkpointAssertion: CheckpointAssertion;
declare const hydrationAssertions: HydrationAssertions;
declare const kindShape: KindShape;
declare const runningAssertion: RunningAssertion;
void storedAssertions;
void hookAssertions;
void kindAssertions;
void jobAssertions;
void entryAssertions;
void bundleAssertions;
void badBundleAssertions;
void exactInputAssertion;
void checkpointAssertion;
void hydrationAssertions;
void kindShape;
void runningAssertion;
void verifyNoOutputRuntime;
void verifyOutput;
void verifyJobMutation;
void verifyEntryInputs;
void verifyHostTaskCreation;
void verifyTaskCreation;
void verifyAddresses;
void verifyResolvedTransactionReads;
void (null as Message | null);
void (null as CoreAbortTaskRuntime<Input, Checkpoint> | null);
