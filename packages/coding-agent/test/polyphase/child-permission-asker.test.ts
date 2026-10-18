/**
 * The parent side of the permission bridge: a child's ask is decided under THIS session's current
 * rules and mode, shown to the human one dialog at a time when it still needs one, forwarded one
 * level up when this session has no UI, and `unavailable` when nobody can be asked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createChildPermissionAsker } from "../../src/core/builtins/subagent.ts";
import type {
	ExtensionContext,
	ExtensionUIDialogOptions,
	PermissionAskDetail,
} from "../../src/core/extensions/types.ts";
import type { PermissionMode } from "../../src/core/multi-agent/index.ts";
import {
	type ParentPermissionAsk,
	type ParentPermissionBridge,
	toChildPermissionInput,
} from "../../src/core/polyphase/permission-bridge.ts";
import { disposePolyphaseSession, getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { ChildPermissionRequest, ChildPermissionVerdict } from "../../src/core/polyphase/types.ts";
import { comparablePath } from "../../src/utils/canonical-path.ts";

interface ConfirmCall {
	title: string;
	message: string;
	detail?: PermissionAskDetail;
	signal?: AbortSignal;
}

const dirs: string[] = [];
const sessionKeys: object[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	// Global rules come from the agent dir; the developer's own ~/.draht must not decide these tests.
	vi.stubEnv(ENV_AGENT_DIR, tempDir("asker-agent-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const key of sessionKeys.splice(0)) disposePolyphaseSession(key, "test");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: {
	mode?: PermissionMode;
	hasUI?: boolean;
	confirm?: (call: ConfirmCall) => Promise<boolean>;
	rules?: string;
	upstream?: ParentPermissionBridge;
}) {
	const project = tempDir("asker-project-");
	if (options.rules !== undefined) {
		mkdirSync(join(project, ".draht"), { recursive: true });
		writeFileSync(join(project, ".draht", "permissions.yml"), options.rules);
	}
	const confirms: ConfirmCall[] = [];
	const sessionKey = {};
	sessionKeys.push(sessionKey);
	const session = getPolyphaseSession(sessionKey, undefined);
	session.setPermissionModeProvider(() => options.mode ?? "ask");
	const ctx = {
		cwd: project,
		hasUI: options.hasUI ?? true,
		isProjectTrusted: () => true,
		sessionManager: sessionKey,
		ui: {
			confirm: (title: string, message: string, dialog?: ExtensionUIDialogOptions) => {
				const call: ConfirmCall = { title, message, detail: dialog?.detail, signal: dialog?.signal };
				confirms.push(call);
				return options.confirm ? options.confirm(call) : Promise.resolve(true);
			},
		},
	} as unknown as ExtensionContext;
	const asker = createChildPermissionAsker(ctx, session, { agentLabel: "reviewer#1", upstream: options.upstream });
	const request = (overrides: Partial<ChildPermissionRequest> = {}): ChildPermissionRequest => ({
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "npm test" },
		via: [],
		cwd: project,
		...overrides,
	});
	return { asker, confirms, request, project };
}

const live = () => new AbortController().signal;

describe("createChildPermissionAsker", () => {
	it("approves without a dialog when the session is in yolo mode", async () => {
		const { asker, confirms, request } = setup({ mode: "yolo" });
		await expect(asker(request(), live())).resolves.toEqual({ kind: "approved" });
		expect(confirms).toHaveLength(0);
	});

	it("approves a benign command without a dialog when the session is in auto mode", async () => {
		const { asker, confirms, request } = setup({ mode: "auto" });
		await expect(asker(request(), live())).resolves.toEqual({ kind: "approved" });
		expect(confirms).toHaveLength(0);
	});

	it("still asks in auto mode when the command trips the danger filter", async () => {
		const { asker, confirms, request } = setup({ mode: "auto" });
		await expect(asker(request({ input: { command: "rm -rf build" } }), live())).resolves.toEqual({
			kind: "approved",
		});
		expect(confirms).toHaveLength(1);
	});

	it("denies by the session's own deny rule without asking", async () => {
		const { asker, confirms, request } = setup({
			mode: "yolo",
			rules: 'rules:\n  - tool: bash\n    pattern: "npm test*"\n    action: deny\n',
		});
		const verdict = await asker(request(), live());
		expect(verdict.kind).toBe("denied");
		expect(verdict.kind === "denied" ? verdict.reason : "").toContain("deny");
		expect(confirms).toHaveLength(0);
	});

	it("asks the human with the subagent named, the command shown and the child's cwd", async () => {
		const { asker, confirms, request, project } = setup({ mode: "ask" });
		await expect(asker(request(), live())).resolves.toEqual({ kind: "approved" });
		expect(confirms).toHaveLength(1);
		const call = confirms[0];
		expect(call?.title).toContain("reviewer#1");
		expect(call?.detail).toMatchObject({ kind: "tool_permission", toolName: "bash", command: "npm test" });
		expect(call?.detail?.summary?.join("\n")).toContain("reviewer#1");
		expect(call?.detail?.cwd).toBe(comparablePath(project));
	});

	it("reports the human's refusal as a denial the child can explain", async () => {
		const { asker, request } = setup({ mode: "ask", confirm: async () => false });
		const verdict = await asker(request(), live());
		expect(verdict).toEqual({ kind: "denied", reason: "Denied by the user in the parent session" });
	});

	it("names the whole chain for an ask forwarded from deeper down", async () => {
		const { asker, confirms, request } = setup({ mode: "ask" });
		await asker(request({ via: ["helper#2"] }), live());
		expect(confirms[0]?.title).toContain("reviewer#1 › helper#2");
	});

	it("shows one dialog at a time: a second ask waits for the first to be answered", async () => {
		const answers: ((value: boolean) => void)[] = [];
		const { asker, confirms, request } = setup({
			mode: "ask",
			confirm: () => new Promise<boolean>((resolve) => answers.push(resolve)),
		});

		const first = asker(request({ toolCallId: "a" }), live());
		const second = asker(request({ toolCallId: "b" }), live());
		await new Promise((resolve) => setImmediate(resolve));
		expect(confirms).toHaveLength(1);

		answers[0]?.(true);
		await expect(first).resolves.toEqual({ kind: "approved" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(confirms).toHaveLength(2);

		answers[1]?.(false);
		await expect(second).resolves.toMatchObject({ kind: "denied" });
	});

	it("never shows an ask that was withdrawn while it waited in the queue", async () => {
		const answers: ((value: boolean) => void)[] = [];
		const { asker, confirms, request } = setup({
			mode: "ask",
			confirm: () => new Promise<boolean>((resolve) => answers.push(resolve)),
		});
		const controller = new AbortController();

		const first = asker(request({ toolCallId: "a" }), live());
		const second = asker(request({ toolCallId: "b" }), controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		answers[0]?.(true);

		await expect(first).resolves.toEqual({ kind: "approved" });
		await expect(second).resolves.toEqual({ kind: "cancelled" });
		expect(confirms).toHaveLength(1);
	});

	it("judges the path a child buried behind junk keys, instead of a pathless grep in the project", async () => {
		const { asker, confirms, request } = setup({ mode: "ask", confirm: async () => false });
		const junk = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), 0]));
		// Exactly what a child's gate hands the bridge for this call.
		const input = toChildPermissionInput({ ...junk, pattern: ".", path: "/etc/passwd" });

		const verdict = await asker(request({ toolName: "grep", input }), live());

		expect(verdict.kind).toBe("denied");
		expect(confirms).toHaveLength(1);
		expect(confirms[0]?.detail?.path).toBe("/etc/passwd");
	});

	it("is unavailable when this session has no UI and no parent to forward to", async () => {
		const { asker, confirms, request } = setup({ mode: "ask", hasUI: false });
		await expect(asker(request(), live())).resolves.toEqual({ kind: "unavailable" });
		expect(confirms).toHaveLength(0);
	});

	it("forwards up without a UI, naming itself and making paths absolute", async () => {
		const forwarded: ParentPermissionAsk[] = [];
		const upstream: ParentPermissionBridge = {
			ask: async (ask): Promise<ChildPermissionVerdict> => {
				forwarded.push(ask);
				return { kind: "approved" };
			},
		};
		// grep is allowed by default; this rule makes even a pathless grep need a human.
		const { asker, request } = setup({
			mode: "ask",
			hasUI: false,
			upstream,
			rules: "rules:\n  - tool: grep\n    action: approve\n",
		});
		const childCwd = "/somewhere/child";

		await expect(
			asker(
				request({ toolName: "read", input: { path: "../outside/a.ts" }, via: ["helper#2"], cwd: childCwd }),
				live(),
			),
		).resolves.toEqual({ kind: "approved" });
		await asker(request({ toolName: "grep", input: { pattern: "x" }, cwd: childCwd }), live());

		// The parent above evaluates against ITS child's cwd: a relative path would name another file.
		expect(forwarded[0]).toMatchObject({
			toolName: "read",
			input: { path: "/somewhere/outside/a.ts" },
			via: ["reviewer#1", "helper#2"],
		});
		// A pathless read-only tool searches the child's cwd, so the forwarded ask says so.
		expect(forwarded[1]?.input).toEqual({ pattern: "x", path: childCwd });
	});

	it("forwards a home-relative path as the file the tool would open, not as one inside the child's cwd", async () => {
		const forwarded: ParentPermissionAsk[] = [];
		const upstream: ParentPermissionBridge = {
			ask: async (ask): Promise<ChildPermissionVerdict> => {
				forwarded.push(ask);
				return { kind: "approved" };
			},
		};
		const { asker, request } = setup({ mode: "ask", hasUI: false, upstream });

		await asker(request({ toolName: "read", input: { path: "~/.ssh/id_rsa" }, cwd: "/somewhere/child" }), live());

		expect(forwarded[0]?.input.path).toBe(join(homedir(), ".ssh", "id_rsa"));
	});

	it("does not forward what this session's own policy already decides", async () => {
		const forwarded: ParentPermissionAsk[] = [];
		const upstream: ParentPermissionBridge = {
			ask: async (ask): Promise<ChildPermissionVerdict> => {
				forwarded.push(ask);
				return { kind: "denied", reason: "should not have been asked" };
			},
		};
		const { asker, request } = setup({ mode: "auto", hasUI: false, upstream });
		await expect(asker(request(), live())).resolves.toEqual({ kind: "approved" });
		expect(forwarded).toHaveLength(0);
	});

	it("is unavailable, never a guess, when the session's context has gone stale", async () => {
		const { request } = setup({ mode: "ask" });
		const sessionKey = {};
		sessionKeys.push(sessionKey);
		const staleCtx = {
			get cwd(): string {
				throw new Error("This extension ctx is stale");
			},
		} as unknown as ExtensionContext;
		const asker = createChildPermissionAsker(staleCtx, getPolyphaseSession(sessionKey, undefined), {
			agentLabel: "reviewer#1",
		});
		await expect(asker(request(), live())).resolves.toEqual({ kind: "unavailable" });
	});
});
