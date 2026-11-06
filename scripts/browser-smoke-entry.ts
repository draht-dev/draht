import { createHost, memoryLinkPair, replicatedState } from "@draht/chord";
import { createAssistantMessageEventStream, validateToolArguments } from "@draht/ai";
import { complete, getModel, getProviders, streamSimple } from "@draht/ai/compat";
import { Agent, streamProxy } from "@draht/agent-core";
import { obj, str } from "@draht/schema";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const schema = obj({ prompt: str() });
const args = validateToolArguments(
	{ name: "prompt", description: "", parameters: schema },
	{ type: "toolCall", id: "1", name: "prompt", arguments: { prompt: 1 } },
);
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model }, streamFn: streamSimple });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	args.prompt,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof streamProxy,
	typeof createHost,
	typeof memoryLinkPair,
	replicatedState({ browser: true }).value.browser,
);
