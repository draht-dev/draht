import type { AssistantMessage } from "@draht/ai";
import { expectTypeOf, it } from "vitest";
import type {
	AgentHarnessStreamOptions,
	HarnessEvent,
	HookInvocation,
	LaneConfiguration,
	OperationState,
	RegisterSetWrite,
	Session,
	SessionTree,
	SettledAssistantMessage,
	Write,
} from "../../src/index.ts";

it("exposes correlated durable and public harness contracts", () => {
	const configuration = {
		model: { provider: "provider", modelId: "model" },
		thinkingLevel: "off",
		activeToolNames: [],
	} satisfies LaneConfiguration;
	const registerWrite = {
		kind: "register",
		op: "set",
		namespace: "lane.config",
		key: "main",
		value: configuration,
	} satisfies RegisterSetWrite;
	const entryWrite = {
		kind: "entry",
		entry: {
			id: "entry",
			parentId: null,
			type: "message",
			message: { role: "user", content: "hello", timestamp: 1 },
		},
	} satisfies Write;

	expectTypeOf(registerWrite.namespace).toEqualTypeOf<"lane.config">();
	expectTypeOf(entryWrite.entry.type).toEqualTypeOf<"message">();
	expectTypeOf<OperationState["kind"]>().toEqualTypeOf<"run" | "compaction" | "navigation">();
	expectTypeOf<Extract<SettledAssistantMessage["stopReason"], "pending">>().toEqualTypeOf<never>();
	expectTypeOf<Extract<HarnessEvent, { type: "run_start" }>["lane"]>().toEqualTypeOf<string>();
	expectTypeOf<Extract<HarnessEvent, { type: "fact_update" }>["lane"]>().toEqualTypeOf<undefined>();
	expectTypeOf<HookInvocation<"before_tool">>().toMatchTypeOf<{
		lane: string;
		runId: string;
		toolCallId: string;
		toolName: string;
	}>();
	expectTypeOf<Session["createLane"]>().toEqualTypeOf<
		(name: string, at: string | null, laneConfiguration: LaneConfiguration) => Promise<SessionTree>
	>();

	const compileTimeFailures = () => {
		// @ts-expect-error lane.config requires a complete LaneConfiguration
		const invalidRegister: RegisterSetWrite = {
			kind: "register",
			op: "set",
			namespace: "lane.config",
			key: "main",
			value: "model",
		};
		// @ts-expect-error callers cannot supply the harness-owned abort signal
		const invalidOptions: AgentHarnessStreamOptions = { signal: new AbortController().signal };
		// @ts-expect-error pending provider messages are not settled
		const unsettled: SettledAssistantMessage = { stopReason: "pending" } as AssistantMessage;
		void invalidRegister;
		void invalidOptions;
		void unsettled;
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});
