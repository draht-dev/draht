import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AcpHarnessSession,
	createAcpHarnessSession,
	type PermissionRequestEvent,
	type ToolCallEvent,
} from "@draht/geist-acp";
import type { SituationPrompt } from "@draht/geist-core";
import type { AgentLaunchSpec } from "@draht/geist-protocol";

import { DRAHT_EDIT_CONTENT, DRAHT_EDIT_FILENAME, DRAHT_TOOL_CALL_ID } from "./fixtures/faux-agent-entry.ts";

// Spawn the REAL draht-acp shim (faux-configured, keyless) exactly how a real
// launch spec runs an ACP agent: `bun run <entry>` over stdio.
const FAUX_AGENT_PATH = fileURLToPath(new URL("./fixtures/faux-agent-entry.ts", import.meta.url));
const LAUNCH_SPEC: AgentLaunchSpec = { cmd: "bun", args: ["run", FAUX_AGENT_PATH] };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A real git worktree with one commit, so "dirty" has meaningful semantics. */
function makeGitWorktree(): string {
	const cwd = mkdtempSync(join(tmpdir(), "draht-acp-e2e-"));
	git(cwd, ["init", "--quiet"]);
	git(cwd, ["config", "user.email", "test@draht.local"]);
	git(cwd, ["config", "user.name", "Draht Test"]);
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

test("keyless e2e: real geist-acp client vs real draht-acp agent — tool update, permission gate, dirty git, clean stop", async () => {
	// Keyless by construction: the spawned shim uses a faux provider + in-memory
	// model registry, so no ANTHROPIC_API_KEY (or any credential) is ever read
	// and no network call is made — this is exactly "same fake-headset script
	// green vs draht-acp" (spec §16 M3).
	session = await createAcpHarnessSession(LAUNCH_SPEC, cwd);
	expect(session.status).toBe("running");
	const pid = session.pid;
	expect(typeof pid).toBe("number");

	const toolCalls: ToolCallEvent[] = [];
	session.onToolCall((event) => toolCalls.push(event));

	// Answer the permission request the shim raises before the gated write runs,
	// choosing "allow".
	const permissions: PermissionRequestEvent[] = [];
	const boundSession = session;
	session.onPermissionRequest((event) => {
		permissions.push(event);
		const allow = event.options.find((option) => option.kind === "allow_once") ?? event.options[0];
		void boundSession.answerPermission(event.requestId, allow.optionId);
	});

	const prompt: SituationPrompt = { blocks: [{ type: "text", text: "apply the draht edit" }] };
	await session.dispatch(prompt);

	// The tool call the agent's AgentSession ran was surfaced over ACP (both the
	// initial tool_call and its completion update carry the same id).
	expect(toolCalls.map((event) => event.toolCallId)).toContain(DRAHT_TOOL_CALL_ID);
	expect(toolCalls.some((event) => event.isUpdate && event.status === "completed")).toBe(true);

	// The permission round-trip happened exactly once, with the shim's options.
	expect(permissions).toHaveLength(1);
	expect(permissions[0].options.map((option) => option.optionId)).toEqual(["allow", "reject"]);
	expect(permissions[0].toolCall.toolCallId).toBe(DRAHT_TOOL_CALL_ID);

	// The gated write actually landed on disk with the exact expected bytes —
	// the non-fakeable proof the permission gate let the real tool run.
	const editPath = join(cwd, DRAHT_EDIT_FILENAME);
	expect(existsSync(editPath)).toBe(true);
	expect(readFileSync(editPath, "utf8")).toBe(DRAHT_EDIT_CONTENT);

	// git in the session cwd is genuinely dirty (the untracked edit).
	const porcelain = git(cwd, ["status", "--porcelain"]).trim();
	expect(porcelain.length).toBeGreaterThan(0);
	expect(porcelain).toContain(DRAHT_EDIT_FILENAME);

	// Status reflects git truth, not the agent's claim (spec §12).
	expect(session.status).toBe("awaiting_review");

	// stop() terminates the subprocess and reflects it.
	await session.stop();
	expect(session.status).toBe("stopped");
	expect(session.pid).toBeUndefined();
	// The OS confirms the pid is gone (ESRCH). pid was captured before stop.
	expect(() => process.kill(pid as number, 0)).toThrow();

	session = undefined; // already stopped; keep afterEach idempotent
});
