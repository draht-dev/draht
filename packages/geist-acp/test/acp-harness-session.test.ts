import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SituationPrompt } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

import {
	type AcpHarnessSession,
	createAcpHarnessSession,
	type PermissionRequestEvent,
	type ToolCallEvent,
} from "../src/acp-harness-session.js";
import { MOCK_COMMANDS, MOCK_EDIT_CONTENT, MOCK_EDIT_FILENAME, MOCK_TOOL_CALL_ID } from "./fixtures/mock-agent.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./fixtures/mock-agent.ts", import.meta.url));
const LAUNCH_SPEC: AgentLaunchSpec = { cmd: "bun", args: ["run", MOCK_AGENT_PATH] };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real git worktree with one commit, so "dirty" has meaningful semantics. */
function makeGitWorktree(): string {
	const cwd = mkdtempSync(join(tmpdir(), "geist-acp-e2e-"));
	git(cwd, ["init", "--quiet"]);
	git(cwd, ["config", "user.email", "test@geist.local"]);
	git(cwd, ["config", "user.name", "Geist Test"]);
	writeFileSync(join(cwd, "README.md"), "seed\n", "utf8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "--quiet", "-m", "initial"]);
	return cwd;
}

let cwd: string;
let session: AcpHarnessSession | undefined;

beforeEach(() => {
	cwd = makeGitWorktree();
	session = undefined;
});

afterEach(async () => {
	// Never leave a subprocess or temp worktree behind, even on assertion failure.
	if (session) await session.stop();
	rmSync(cwd, { recursive: true, force: true });
});

test("createAcpHarnessSession rejects (does not crash the host) when launchSpec.cmd does not exist", async () => {
	// A misconfigured command fails the spawn asynchronously via a ChildProcess
	// 'error' event (ENOENT). With no listener that would be an uncaught
	// exception crashing this test process; instead it must reject cleanly.
	const badSpec: AgentLaunchSpec = { cmd: "/nonexistent/definitely-not-a-real-binary", args: [] };

	let created: AcpHarnessSession | undefined;
	try {
		created = await createAcpHarnessSession(badSpec, cwd);
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message.length).toBeGreaterThan(0);
		return;
	} finally {
		// If it unexpectedly resolved, don't leak the subprocess.
		if (created) await created.stop();
	}

	throw new Error("expected createAcpHarnessSession to reject for a nonexistent cmd, but it resolved");
});

test("full ACP turn: tool events, permission round-trip, dirty git → awaiting_review, clean stop", async () => {
	session = await createAcpHarnessSession(LAUNCH_SPEC, cwd);

	// Capabilities negotiated at the handshake (spec §9.2). The mock advertises
	// images (initialize) + resume (initialize) + modes (session/new); commands
	// only arrive as a runtime update, so they are not yet known here.
	expect(session.capabilities.images).toBe(true);
	expect(session.capabilities.resume).toBe(true);
	expect(session.capabilities.modes).toBe(true);
	expect(session.capabilities.commands).toBe(false);
	expect(session.status).toBe("running");
	const pid = session.pid;
	expect(typeof pid).toBe("number");

	const toolCalls: ToolCallEvent[] = [];
	session.onToolCall((event) => toolCalls.push(event));

	// Answer the permission request the mock raises mid-turn, choosing "allow".
	const permissions: PermissionRequestEvent[] = [];
	const boundSession = session;
	session.onPermissionRequest((event) => {
		permissions.push(event);
		const allow = event.options.find((option) => option.kind === "allow_once") ?? event.options[0];
		void boundSession.answerPermission(event.requestId, allow.optionId);
	});

	const prompt: SituationPrompt = {
		blocks: [{ type: "text", text: "make the primary button blue" }],
	};
	await session.dispatch(prompt);

	// The tool call the mock emitted was surfaced (both the initial call and its
	// completion update carry the same id).
	const seenToolCallIds = toolCalls.map((event) => event.toolCallId);
	expect(seenToolCallIds).toContain(MOCK_TOOL_CALL_ID);
	expect(toolCalls.some((event) => event.isUpdate && event.status === "completed")).toBe(true);

	// The permission round-trip happened exactly once, with the mock's options.
	expect(permissions).toHaveLength(1);
	expect(permissions[0].options.map((option) => option.optionId)).toEqual(["allow", "reject"]);
	expect(permissions[0].toolCall.toolCallId).toBe(MOCK_TOOL_CALL_ID);

	// Commands were advertised during the turn and are now reflected live.
	expect(session.capabilities.commands).toBe(true);

	// The mock's edit actually landed on disk with the exact expected bytes.
	const editPath = join(cwd, MOCK_EDIT_FILENAME);
	expect(existsSync(editPath)).toBe(true);
	expect(readFileSync(editPath, "utf8")).toBe(MOCK_EDIT_CONTENT);

	// git in the session cwd is genuinely dirty (the untracked edit).
	const porcelain = git(cwd, ["status", "--porcelain"]).trim();
	expect(porcelain.length).toBeGreaterThan(0);
	expect(porcelain).toContain(MOCK_EDIT_FILENAME);

	// Status reflects git truth, not the agent's claim (spec §12).
	expect(session.status).toBe("awaiting_review");

	// Sanity: the mock advertised the commands we expected.
	expect([...MOCK_COMMANDS]).toEqual(["plan", "review"]);

	// stop() terminates the subprocess and reflects it.
	await session.stop();
	expect(session.status).toBe("stopped");
	expect(session.pid).toBeUndefined();
	// The OS confirms the pid is gone (ESRCH). pid was captured before stop.
	expect(() => process.kill(pid as number, 0)).toThrow();

	session = undefined; // already stopped; keep afterEach idempotent
});
