// AgentHarness R4 context-bound tool example.
// Run from packages/agent: node test/harness/scratch/r4.ts
// Uses the faux provider and makes no external requests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@draht/ai";
import { InMemoryTelemetryContext } from "@draht/telemetry";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { AgentHarness, createReadTool, getOrThrow, MemorySessionRepo } from "../../../src/index.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-agent-r4-"));
const env = new NodeExecutionEnv({ cwd: directory });
const repo = new MemorySessionRepo();
const session = await repo.create({});
const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
const models = createModels();
models.setProvider(faux.provider);
const telemetry = new InMemoryTelemetryContext();

function printJson(label: string, value: unknown): void {
	console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
}
await env.writeFile("example.txt", "durable tool output\n");

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }, { id: "read-call" }), {
		stopReason: "toolUse",
	}),
	(context) => {
		const result = context.messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult" || result.content[0]?.type !== "text") {
			throw new Error("read result is missing");
		}
		return fauxAssistantMessage(`Observed: ${result.content[0].text.trim()}`);
	},
]);

const { harness } = await AgentHarness.create({
	session,
	models,
	model: faux.getModel(),
	tools: [createReadTool()],
	activeToolNames: ["read"],
	toolContext: { env },
	telemetryContext: telemetry,
});

for (const type of ["tool_start", "tool_end", "turn_end"] as const) {
	harness.events.on(type, (event) => {
		printJson(type, event);
	});
}
harness.hooks.on("before_tool", async ({ runId, toolCallId }) => {
	const state = await session.getRegister("op.state", runId);
	if (state?.value.kind !== "run" || state.value.phase.kind !== "tools") return undefined;
	printJson("invocation", {
		toolCallId,
		invocationId: state.value.phase.batch.calls[0]?.resultEntryId,
	});
	return undefined;
});

try {
	const admission = getOrThrow(await harness.accept({ kind: "prompt", prompt: "Read example.txt" }));
	printJson("accepted", admission);
	const driven = getOrThrow(await harness.drive({ operationId: admission.operationId }));
	printJson("drive", driven);
	console.log("verified:", getOrThrow(await env.readTextFile("example.txt")).trim());
	printJson("telemetry spans", telemetry.getSpans());
} finally {
	await harness.close();
	await env.cleanup();
	await repo.close();
	await rm(directory, { recursive: true, force: true });
}
