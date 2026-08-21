/**
 * Keyless stub provider (R32-FLEET.11).
 *
 * `registerFauxProvider` from "@draht/ai/compat" mutates the api-registry of the
 * calling process, so a test that spawns `draht` cannot reach it. This provider
 * is the same faux streaming core reached the only way a child process can be
 * configured — an environment variable read at startup — and registered through
 * the mechanism extensions already use for native providers
 * (`pi.registerProvider(provider)`, exactly as the built-in llama.cpp extension
 * registers its own).
 *
 * The reply is derived from the prompt rather than queued, because a spawned
 * binary answers however many turns its driver sends and no test can pre-load a
 * queue into another process.
 */

import type { Provider } from "@draht/ai";
import {
	type FauxContentBlock,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@draht/ai/providers/faux";

/** Provider id to pass as `--provider`. */
export const STUB_PROVIDER_ID = "draht-stub";
/** Model id to pass as `--model`. */
export const STUB_MODEL_ID = "stub-1";
/** Every stub reply starts with this, so assertions never match the prompt echo. */
export const STUB_REPLY_PREFIX = "stub: ";

/** Set truthy to register the provider in this process. */
export const STUB_PROVIDER_ENV = "DRAHT_STUB_PROVIDER";
/** Optional pacing knob, so a driver can send a second prompt mid-stream. */
export const STUB_PROVIDER_TOKENS_PER_SECOND_ENV = "DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND";
/**
 * Optional script of tool calls, so a spawned binary can be made to issue a REAL
 * tool call with no API key. JSON: an array of turn scripts, one per provider
 * turn — `[{ "toolCalls": [{ "id": "call-1", "name": "bash", "arguments": { "command": "true" } }], "text": "optional" }]`.
 * Once the scripts are exhausted the stub falls back to its text reply forever,
 * which is what ends a turn after the scripted call has run.
 */
export const STUB_PROVIDER_TOOL_CALLS_ENV = "DRAHT_STUB_TOOL_CALLS";

export function isStubProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[STUB_PROVIDER_ENV];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function stubTokensPerSecond(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env[STUB_PROVIDER_TOKENS_PER_SECOND_ENV];
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Text of the last user message, flattened; images become a stable placeholder. */
function lastUserText(messages: readonly { role: string; content: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "[image]"))
			.join("\n");
	}
	return "";
}

/** The deterministic answer the stub gives to a prompt. */
export function stubReplyFor(prompt: string): string {
	return `${STUB_REPLY_PREFIX}${prompt}`;
}

/** One provider turn of the scripted stub: tool calls, plus optional leading text. */
export interface StubTurnScript {
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
	text?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTurnScript(raw: unknown): StubTurnScript | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (raw.text !== undefined && typeof raw.text !== "string") return undefined;
	const toolCalls = raw.toolCalls ?? [];
	if (!Array.isArray(toolCalls)) return undefined;
	const parsed: StubTurnScript["toolCalls"] = [];
	for (const entry of toolCalls) {
		if (!isPlainObject(entry)) return undefined;
		if (typeof entry.id !== "string" || typeof entry.name !== "string") return undefined;
		const arguments_ = entry.arguments ?? {};
		if (!isPlainObject(arguments_)) return undefined;
		parsed.push({ id: entry.id, name: entry.name, arguments: arguments_ });
	}
	return { toolCalls: parsed, text: raw.text as string | undefined };
}

/**
 * Turn scripts from the environment, or `undefined` when the variable is absent
 * or malformed. Malformed input never throws: a spawned binary that dies on a
 * bad script would report a harness typo as a product failure, so the stub warns
 * once on stderr and answers with plain text exactly as it does today.
 */
export function parseStubToolCallScripts(env: NodeJS.ProcessEnv = process.env): StubTurnScript[] | undefined {
	const raw = env[STUB_PROVIDER_TOOL_CALLS_ENV];
	if (raw === undefined || raw.trim() === "") return undefined;
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		console.error(
			`${STUB_PROVIDER_TOOL_CALLS_ENV}: ignoring malformed JSON (${error instanceof Error ? error.message : String(error)})`,
		);
		return undefined;
	}
	if (!Array.isArray(decoded)) {
		console.error(`${STUB_PROVIDER_TOOL_CALLS_ENV}: ignoring value, expected an array of turn scripts`);
		return undefined;
	}
	const scripts: StubTurnScript[] = [];
	for (const entry of decoded) {
		const script = parseTurnScript(entry);
		if (!script) {
			console.error(`${STUB_PROVIDER_TOOL_CALLS_ENV}: ignoring value, expected an array of turn scripts`);
			return undefined;
		}
		scripts.push(script);
	}
	return scripts;
}

/**
 * Faux provider whose queued response re-queues itself, so the provider answers
 * every turn of a spawned session instead of erroring once the queue drains.
 */
export function createStubProvider(env: NodeJS.ProcessEnv = process.env): Provider {
	const handle = fauxProvider({
		provider: STUB_PROVIDER_ID,
		api: "faux-stub",
		models: [{ id: STUB_MODEL_ID, name: "Draht Stub", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		tokensPerSecond: stubTokensPerSecond(env),
		// The faux core picks a random chunk size between min and max; pinning both
		// makes the delta boundaries fixed at four characters, so "streamed in more
		// than one frame" is a fact about the stub rather than a coin flip.
		tokenSize: { min: 1, max: 1 },
	});

	const scripts = parseStubToolCallScripts(env);
	let turn = 0;

	const respond: FauxResponseFactory = (context) => {
		handle.appendResponses([respond]);
		const script = scripts?.[turn++];
		if (!script || script.toolCalls.length === 0) {
			return fauxAssistantMessage(script?.text ?? stubReplyFor(lastUserText(context.messages)));
		}
		const content: FauxContentBlock[] = [];
		if (script.text !== undefined) content.push(fauxText(script.text));
		for (const call of script.toolCalls) {
			content.push(fauxToolCall(call.name, call.arguments, { id: call.id }));
		}
		return fauxAssistantMessage(content, { stopReason: "toolUse" });
	};
	handle.setResponses([respond]);

	return handle.provider;
}
