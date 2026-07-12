#!/usr/bin/env bun
/**
 * Keyless, spawnable `draht-acp` entry for the e2e proof (Phase 35 / M3;
 * R35-M3). It runs the REAL shim (`runDrahtAcpAgentStdio`) — the same code path
 * a real launch spec uses — but injects a `fauxProvider()` model via the shim's
 * `sessionOptions` seam, so the whole ACP turn runs with NO network and NO
 * credential (no `ANTHROPIC_API_KEY` or any other key is read). This is the
 * agent-side analogue of geist-acp's spawned mock agent from Phase 35a.
 *
 * The faux model is scripted to (1) emit a `write` tool call that edits a file
 * in the session `cwd`, then (2) return a final text turn. The shim gates the
 * write behind an ACP `session/request_permission` round-trip, so the edit only
 * lands after the client approves.
 *
 * Importing this module (for the shared constants) does NOT start the agent or
 * register the faux provider — that is guarded by `import.meta.main`.
 *
 * NOTHING is written to stdout except ACP messages (stray logs are rerouted to
 * stderr below) or the newline-delimited JSON stream would be corrupted.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { registerFauxProvider } from "@draht/ai/compat";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager } from "@draht/coding-agent";

import { type DrahtAcpAgentConfig, runDrahtAcpAgentStdio } from "../../src/draht-acp-agent.ts";

/** File the faux `write` tool edits in the session cwd — the test asserts it lands. */
export const DRAHT_EDIT_FILENAME = "draht-acp-edit.txt";
/** Exact bytes written — the test asserts them verbatim. */
export const DRAHT_EDIT_CONTENT = "edited by the draht-acp shim (faux model)\n";
/** Tool-call id the faux model emits — the test asserts it was surfaced over ACP. */
export const DRAHT_TOOL_CALL_ID = "draht-tool-1";

/**
 * Builds the shim config with a keyless faux provider, mirroring the hermetic
 * wiring `@draht/coding-agent`'s own test harness uses (in-memory auth, model
 * registry, session, and settings managers; a temp agent dir).
 */
function buildFauxConfig(): DrahtAcpAgentConfig {
	// Keep stdout pristine for the ACP ndJSON stream: reroute any stray logging.
	console.log = (...args: unknown[]) => console.error(...args);
	console.info = (...args: unknown[]) => console.error(...args);
	console.warn = (...args: unknown[]) => console.error(...args);
	console.debug = (...args: unknown[]) => console.error(...args);

	const faux = registerFauxProvider();
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: DRAHT_EDIT_FILENAME, content: DRAHT_EDIT_CONTENT }, { id: DRAHT_TOOL_CALL_ID }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done — applied the draht-acp edit"),
	]);

	const agentDir = mkdtempSync(join(tmpdir(), "draht-acp-agentdir-"));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	const settingsManager = SettingsManager.inMemory();

	return {
		name: "draht-acp-faux",
		sessionOptions: () => ({
			model,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
			// Per-session, in-memory: no session history is persisted to disk.
			sessionManager: SessionManager.inMemory(),
		}),
	};
}

if (import.meta.main) {
	runDrahtAcpAgentStdio(buildFauxConfig());
}
