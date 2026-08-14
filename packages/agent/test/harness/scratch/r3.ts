// AgentHarness R3 durable retry and reattachment example.
// Run from packages/agent: node test/harness/scratch/r3.ts
// Uses the faux provider and makes no external requests.

import { createModels, fauxAssistantMessage, fauxProvider } from "@draht/ai";
import { AgentHarness, MemorySessionRepo } from "../../../src/index.ts";

const repo = new MemorySessionRepo();
const session = await repo.create({});
const metadata = session.metadata;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
	fauxAssistantMessage("retry succeeded"),
]);

const first = await AgentHarness.create({
	session,
	models,
	model: faux.getModel(),
	activeToolNames: [],
	retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
});

const admission = await first.harness.accept({ kind: "prompt", prompt: "run the retry example" });
if (!admission.ok) throw admission.error;
const operationId = admission.value.operationId;
const waiting = await first.harness.drive({ operationId, waitForRetry: false });
console.log("first drive:", waiting);
console.log("provider calls before detach:", faux.state.callCount);
await first.harness.close();

const reopenedSession = await repo.open(metadata);
const reopenedModels = createModels();
reopenedModels.setProvider(faux.provider);
const second = await AgentHarness.create({
	session: reopenedSession,
	models: reopenedModels,
	model: faux.getModel(),
	activeToolNames: [],
});
second.harness.events.on("message_update", ({ event }) => {
	if (event.type === "text_delta") process.stdout.write(event.delta);
});

try {
	process.stdout.write("assistant: ");
	const result = await second.harness.drive({ operationId, waitForRetry: true });
	process.stdout.write("\n");
	console.log("reattached drive:", result);
	console.log("provider calls after completion:", faux.state.callCount);
} finally {
	await second.harness.close();
	await repo.close();
}
