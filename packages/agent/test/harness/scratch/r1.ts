// Minimal AgentHarness R1 runtime-shell example.
// Run from packages/agent: node test/harness/scratch/r1.ts
// Uses the faux provider and makes no external requests.

import { createModels, fauxProvider } from "@draht/ai";
import { AgentHarness, MemorySessionRepo } from "../../../src/index.ts";

const repo = new MemorySessionRepo();
const session = await repo.create({});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const { harness, suspended } = await AgentHarness.create({
	session,
	models,
	model: faux.getModel(),
	activeToolNames: [],
});

harness.events.on("config_update", (event) => {
	console.log(`config: ${event.property}`);
});
harness.events.on("lane_created", (event) => {
	console.log(`lane:   created ${event.lane} at ${event.at ?? "root"}`);
});

try {
	console.log("restored:", suspended);
	console.log("main:    ", await harness.inspectExecution());

	await harness.setThinkingLevel("high");
	const worker = await harness.createLane("worker", null);
	if (!worker.ok) throw worker.error;
	await worker.value.setThinkingLevel("low");

	console.log("lanes:   ", await harness.lanes());
	console.log("worker:  ", await worker.value.inspectExecution());
} finally {
	await harness.close();
	await repo.close();
}
