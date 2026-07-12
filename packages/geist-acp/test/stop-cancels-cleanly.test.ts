import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SituationPrompt } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

import {
	type AcpHarnessSession,
	createAcpHarnessSession,
	type PlanUpdateEvent,
	type ToolCallEvent,
} from "../src/acp-harness-session.js";
import { MOCK_LONG_RUNNING_SENTINEL, MOCK_LONG_RUNNING_TOOL_CALL_ID } from "./fixtures/mock-agent.js";

/**
 * "Stop cancels cleanly" (spec §16 M7 ✅). These exercise the REAL ACP client
 * and a REAL spawned subprocess (Phase 35a machinery) — this file lives in
 * `geist-acp/test` rather than `geist-core` because only geist-acp owns the
 * subprocess/ACP wiring; geist-core stays harness-free. The mock runs a
 * genuinely in-flight turn (a tool call, then it blocks) so a mid-turn stop is
 * a real cancellation, not a race against an already-finished turn.
 */

const MOCK_AGENT_PATH = fileURLToPath(new URL("./fixtures/mock-agent.ts", import.meta.url));
const LAUNCH_SPEC: AgentLaunchSpec = { cmd: "bun", args: ["run", MOCK_AGENT_PATH] };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const LONG_RUNNING_PROMPT: SituationPrompt = {
	blocks: [{ type: "text", text: `${MOCK_LONG_RUNNING_SENTINEL}: refactor everything` }],
};

let cwd: string;
let session: AcpHarnessSession | undefined;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "geist-acp-stop-"));
	session = undefined;
});

afterEach(async () => {
	// Never leave a subprocess or temp dir behind, even on assertion failure.
	if (session) await session.stop();
	rmSync(cwd, { recursive: true, force: true });
});

/** Fires a long-running prompt without awaiting it, tracking whether it settled. */
function dispatchInFlight(target: AcpHarnessSession): { settled: () => boolean } {
	let settled = false;
	// The turn never ends on its own here, so dispatch only settles once the
	// connection is torn down under it — observe (and swallow) that rejection.
	target
		.dispatch(LONG_RUNNING_PROMPT)
		.catch(() => {})
		.finally(() => {
			settled = true;
		});
	return { settled: () => settled };
}

/** Spins until the in-flight tool call is surfaced or a timeout elapses. */
async function waitForInFlightToolCall(toolCalls: ToolCallEvent[]): Promise<void> {
	const start = Date.now();
	while (toolCalls.length === 0 && Date.now() - start < 5000) await delay(10);
	expect(toolCalls.map((event) => event.toolCallId)).toContain(MOCK_LONG_RUNNING_TOOL_CALL_ID);
}

test("stop() force-cancels an in-flight turn: subprocess exits (ESRCH), no tool/plan listener fires after stop", async () => {
	session = await createAcpHarnessSession(LAUNCH_SPEC, cwd);
	const pid = session.pid;
	expect(typeof pid).toBe("number");

	const toolCalls: ToolCallEvent[] = [];
	const planUpdates: PlanUpdateEvent[] = [];
	let stopped = false;
	const afterStop: string[] = [];
	session.onToolCall((event) => {
		if (stopped) afterStop.push(`tool:${event.toolCallId}`);
		toolCalls.push(event);
	});
	session.onPlanUpdate((event) => {
		if (stopped) afterStop.push("plan");
		planUpdates.push(event);
	});

	const inFlight = dispatchInFlight(session);
	await waitForInFlightToolCall(toolCalls);

	// The turn is genuinely still running when we stop it.
	expect(session.status).toBe("running");
	expect(inFlight.settled()).toBe(false);

	// STOP mid-turn — the whole point of the test.
	stopped = true;
	await session.stop();
	expect(session.status).toBe("stopped");
	expect(session.pid).toBeUndefined();
	// The OS confirms the subprocess is gone (ESRCH). pid was captured pre-stop.
	expect(() => process.kill(pid as number, 0)).toThrow();

	// Give any late/dangling update a chance to fire, then prove none did.
	await delay(100);
	expect(afterStop).toEqual([]);
	expect(planUpdates).toHaveLength(0);
	// Exactly the one in-flight tool call was ever surfaced.
	expect(toolCalls.map((event) => event.toolCallId)).toEqual([MOCK_LONG_RUNNING_TOOL_CALL_ID]);

	session = undefined; // already stopped; keep afterEach idempotent
});

test("cancel() ends the in-flight turn gracefully (spec §6 cancel+re-prompt), then stop() tears down cleanly", async () => {
	session = await createAcpHarnessSession(LAUNCH_SPEC, cwd);
	const pid = session.pid;
	expect(typeof pid).toBe("number");

	const toolCalls: ToolCallEvent[] = [];
	session.onToolCall((event) => toolCalls.push(event));

	// Await this one: cancel() makes the mock return `cancelled`, so dispatch
	// resolves on its own — the graceful path, unlike the force-stop above.
	const dispatchPromise = session.dispatch(LONG_RUNNING_PROMPT);
	await waitForInFlightToolCall(toolCalls);
	expect(session.status).toBe("running");

	await session.cancel();
	await dispatchPromise;
	// Turn ended and the long-running mock wrote nothing, so git is clean →
	// status returns to running rather than awaiting_review (spec §12).
	expect(session.status).toBe("running");

	// A subsequent stop still terminates the subprocess cleanly.
	await session.stop();
	expect(session.status).toBe("stopped");
	expect(session.pid).toBeUndefined();
	expect(() => process.kill(pid as number, 0)).toThrow();

	// Only the single in-flight tool call was ever surfaced.
	expect(toolCalls.map((event) => event.toolCallId)).toEqual([MOCK_LONG_RUNNING_TOOL_CALL_ID]);

	session = undefined; // already stopped; keep afterEach idempotent
});
