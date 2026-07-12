#!/usr/bin/env bun
/**
 * Deterministic in-repo mock ACP agent (spec §16 M3: "a tiny deterministic
 * stdio process in-repo"; R35-M3.2). Runs as a real spawned stdio subprocess —
 * exactly how a real harness binary runs — so the e2e test exercises the true
 * `spawn → ndJsonStream → ACP handshake → prompt turn` integration, not an
 * in-process shortcut.
 *
 * Run directly: `bun run test/fixtures/mock-agent.ts` (ACP over stdin/stdout).
 * Importing this module (e.g. for the shared constants below) does NOT start
 * the agent — the stdio wiring is guarded by `import.meta.main`.
 *
 * On `session/prompt` it deterministically:
 *   (a) advertises images/resume at `initialize` and modes at `session/new`,
 *       and commands via `available_commands_update` (ACP's real sources);
 *   (b) emits a `tool_call` `session/update`;
 *   (c) emits an `available_commands_update`;
 *   (d) requests permission mid-turn and blocks until the client answers;
 *   (e) only if allowed, writes a file into the session `cwd` (making `git`
 *       genuinely dirty — the non-fakeable proof of "dirty git →
 *       awaiting_review") and reports the tool call completed;
 *   (f) returns a real `end_turn` stop reason.
 *
 * NOTHING is written to stdout except ACP messages — logs go to stderr — or the
 * newline-delimited JSON stream would be corrupted.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
	type AgentApp,
	agent,
	type ContentBlock,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

/** File the mock writes into the session cwd — the test asserts it lands. */
export const MOCK_EDIT_FILENAME = "mock-agent-edit.txt";
/** Exact bytes the mock writes — the test asserts them verbatim. */
export const MOCK_EDIT_CONTENT = "edited by the geist mock ACP agent\n";
/** Tool-call id the mock reports — the test asserts it was surfaced. */
export const MOCK_TOOL_CALL_ID = "mock-tool-1";
/** Commands the mock advertises — the test asserts `capabilities.commands`. */
export const MOCK_COMMANDS = ["plan", "review"] as const;

/**
 * When a prompt's text contains this sentinel the mock enters LONG-RUNNING
 * mode: it emits a single in-progress tool call and then blocks the turn
 * indefinitely, only ending it if the client sends `session/cancel` (spec §16
 * M7 "stop cancels cleanly"). This is the fixture variant the stop/cancel e2e
 * needs — a turn that is genuinely still in flight when the client stops it.
 */
export const MOCK_LONG_RUNNING_SENTINEL = "geist-long-running";
/** Tool-call id the long-running mode reports before it blocks. */
export const MOCK_LONG_RUNNING_TOOL_CALL_ID = "mock-long-tool-1";

/** Concatenates the text blocks of a prompt (mock only inspects text). */
function promptText(blocks: readonly ContentBlock[]): string {
	return blocks.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

/** Builds the mock `AgentApp` without connecting it to any transport. */
export function buildMockAgent(): AgentApp {
	const cwdBySession = new Map<string, string>();
	// Per-session resolvers for LONG-RUNNING turns, fired by `session/cancel`.
	const cancelWaiters = new Map<string, () => void>();

	return agent({ name: "geist-mock-agent" })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: true, audio: false, embeddedContext: true },
				sessionCapabilities: { resume: {} },
			},
			agentInfo: { name: "geist-mock-agent", version: "0.0.0" },
		}))
		.onRequest(methods.agent.session.new, ({ params }) => {
			const sessionId = `mock-session-${cwdBySession.size + 1}`;
			cwdBySession.set(sessionId, params.cwd);
			return {
				sessionId,
				modes: {
					currentModeId: "code",
					availableModes: [
						{ id: "code", name: "Code" },
						{ id: "ask", name: "Ask" },
					],
				},
			};
		})
		.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
			const cwd = cwdBySession.get(params.sessionId);
			if (cwd === undefined) throw new Error(`unknown session ${params.sessionId}`);
			const editPath = join(cwd, MOCK_EDIT_FILENAME);

			// LONG-RUNNING mode: emit one in-flight tool call, then block the turn
			// until the client cancels (or force-stops the subprocess). This is the
			// "turn genuinely in flight" the stop/cancel e2e needs — nothing after
			// the tool call is emitted, so any later listener firing is a bug.
			if (promptText(params.prompt).includes(MOCK_LONG_RUNNING_SENTINEL)) {
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: MOCK_LONG_RUNNING_TOOL_CALL_ID,
						title: "Long-running mock work",
						kind: "other",
						status: "in_progress",
					},
				});
				await new Promise<void>((resolve) => cancelWaiters.set(params.sessionId, resolve));
				cancelWaiters.delete(params.sessionId);
				return { stopReason: "cancelled" };
			}

			// (b) a tool call the client can surface
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: MOCK_TOOL_CALL_ID,
					title: "Apply mock edit",
					kind: "edit",
					status: "in_progress",
					locations: [{ path: editPath }],
				},
			});

			// (c) advertise commands — ACP's only command-advertisement mechanism
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: MOCK_COMMANDS.map((name) => ({ name, description: `Mock ${name}` })),
				},
			});

			// (d) request permission and BLOCK until the client answers
			const permission = await client.request(methods.client.session.requestPermission, {
				sessionId: params.sessionId,
				toolCall: {
					toolCallId: MOCK_TOOL_CALL_ID,
					title: "Apply mock edit",
					kind: "edit",
					status: "pending",
					locations: [{ path: editPath }],
				},
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "reject", name: "Reject", kind: "reject_once" },
				],
			});
			const approved = permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow";

			// (e) only edit when allowed — proving the permission gate controls the write
			if (approved) {
				writeFileSync(editPath, MOCK_EDIT_CONTENT, "utf8");
			}
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: MOCK_TOOL_CALL_ID,
					status: approved ? "completed" : "failed",
				},
			});

			// (f) a real stop reason ends the turn
			return { stopReason: "end_turn" };
		})
		.onNotification(methods.agent.session.cancel, ({ params }) => {
			// End an in-flight LONG-RUNNING turn gracefully; a no-op otherwise
			// (the deterministic turn has no long-running work to abort).
			cancelWaiters.get(params.sessionId)?.();
		});
}

if (import.meta.main) {
	const outgoing = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
	const incoming = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
	buildMockAgent().connect(ndJsonStream(outgoing, incoming));
}
