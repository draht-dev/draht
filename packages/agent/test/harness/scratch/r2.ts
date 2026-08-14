// Minimal real-provider AgentHarness example.
// Run from packages/agent: node test/harness/scratch/r2.ts
// Requires ANTHROPIC_API_KEY.

import { createModels } from "../../../../ai/src/models.ts";
import { anthropicProvider } from "../../../../ai/src/providers/anthropic.ts";
import { AgentHarness, MemorySessionRepo } from "../../../src/index.ts";

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("model not found");

const auth = await models.getAuth(model.provider);
console.log(`model: ${model.provider}/${model.id}`);
console.log(`auth:  ${auth ? `configured via ${auth.source}` : "not configured"}\n`);
if (!auth) process.exit(1);

const repo = new MemorySessionRepo();
const session = await repo.create({});
const { harness } = await AgentHarness.create({
	session,
	models,
	model,
	activeToolNames: [],
	systemPrompt: "You are terse.",
});

harness.events.on("message_update", ({ event }) => {
	if (event.type === "text_delta") process.stdout.write(event.delta);
});

try {
	process.stdout.write("assistant: ");
	const result = await harness.prompt("Spit out one sentence");
	process.stdout.write("\n");

	if (!result.ok) throw result.error;
	console.log(`result: ${result.value.kind}`);
	if ("finalMessage" in result.value && result.value.finalMessage) {
		console.log(`stop:   ${result.value.finalMessage.stopReason}`);
		console.log(`cost:   $${result.value.finalMessage.usage.cost.total.toFixed(6)}`);
	}
} finally {
	await harness.close();
	await repo.close();
}
