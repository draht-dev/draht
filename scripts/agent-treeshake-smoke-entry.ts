import { Agent } from "@draht/agent-core";
import { createModels } from "@draht/ai";
import { anthropicProvider } from "@draht/ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFunction: models.streamSimple.bind(models),
});
