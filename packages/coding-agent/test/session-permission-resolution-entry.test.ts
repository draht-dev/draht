import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type PermissionResolutionEntry,
	type SessionHeader,
	SessionManager,
} from "../src/core/session-manager.ts";

function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

function readLines(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

describe("PermissionResolutionEntry", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `perm-resolution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const resolution = {
		requestId: "req-0001",
		toolCallId: "call_abc123",
		toolName: "bash",
		cwd: "/private/tmp/project",
		detail: { command: "rm -rf build", operation: "execute" },
		offeredOptionIds: ["approve", "approve-always", "deny"],
		decision: "approved" as const,
		chosenOptionId: "approve",
		decidedBy: { surface: "attach" as const, clientId: "client-7" },
		requestedAt: "2026-08-21T10:00:00.000Z",
		deadline: "2026-08-21T10:05:00.000Z",
	};

	it("writes the resolution to the session JSONL and survives a reload", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		if (!sessionFile) throw new Error("expected a persisted session file");

		// _persist buffers everything in memory until the FIRST assistant message,
		// so nothing reaches disk before this pair is appended.
		session.appendMessage({ role: "user", content: "delete the build dir", timestamp: 1 });
		session.appendMessage(assistantMessage("on it", 2));

		const permissionId = session.appendPermissionResolution(resolution);
		expect(permissionId).toBeTruthy();

		// --- the raw file ---
		const lines = readLines(sessionFile);
		const header = JSON.parse(lines[0]) as SessionHeader;
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(CURRENT_SESSION_VERSION).toBe(3);

		const last = JSON.parse(lines[lines.length - 1]) as PermissionResolutionEntry;
		expect(last.type).toBe("permission_resolution");
		expect(last.id).toBe(permissionId);
		expect(last.id.length).toBeGreaterThan(0);
		expect(typeof last.parentId).toBe("string");
		expect((last.parentId ?? "").length).toBeGreaterThan(0);
		expect(last.timestamp.length).toBeGreaterThan(0);
		expect(Number.isNaN(Date.parse(last.timestamp))).toBe(false);

		expect(last.requestId).toBe("req-0001");
		expect(last.toolCallId).toBe("call_abc123");
		expect(last.toolName).toBe("bash");
		expect(last.cwd).toBe("/private/tmp/project");
		expect(last.detail).toEqual({ command: "rm -rf build", operation: "execute" });
		expect(last.offeredOptionIds).toEqual(["approve", "approve-always", "deny"]);
		expect(last.decision).toBe("approved");
		expect(last.chosenOptionId).toBe("approve");
		expect(last.decidedBy).toEqual({ surface: "attach", clientId: "client-7" });
		expect(last.requestedAt).toBe("2026-08-21T10:00:00.000Z");
		expect(last.deadline).toBe("2026-08-21T10:05:00.000Z");

		// --- reload through the real reader ---
		const reopened = SessionManager.open(sessionFile);
		const entries = reopened.getEntries();
		const reloaded = entries.find((e): e is PermissionResolutionEntry => e.type === "permission_resolution");
		expect(reloaded).toBeDefined();
		expect(reloaded?.id).toBe(permissionId);
		expect(reloaded?.decidedBy.surface).toBe("attach");

		expect(reopened.getHeader()?.version).toBe(3);

		const tree = reopened.getTree();
		expect(tree).toHaveLength(1);
		const flattened: string[] = [];
		const walk = (nodes: ReturnType<typeof reopened.getTree>): void => {
			for (const node of nodes) {
				flattened.push(node.entry.type);
				walk(node.children);
			}
		};
		walk(tree);
		expect(flattened).toEqual(["message", "message", "permission_resolution"]);

		// The record must never enter LLM context.
		const context = reopened.buildSessionContext();
		expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

		// The entry is the leaf after reload: the next message parents off it.
		const nextId = reopened.appendMessage({ role: "user", content: "done?", timestamp: 3 });
		const next = reopened.getEntry(nextId);
		expect(next?.parentId).toBe(permissionId);
	});

	it("records a denial with a null chosen option and no deadline", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		session.appendMessage({ role: "user", content: "read the key", timestamp: 1 });
		session.appendMessage(assistantMessage("checking", 2));

		const id = session.appendPermissionResolution({
			requestId: "req-0002",
			toolCallId: "call_def456",
			toolName: "read",
			cwd: "/private/tmp/project",
			detail: { path: "/private/tmp/project/.env" },
			offeredOptionIds: ["approve", "deny"],
			decision: "denied",
			chosenOptionId: "deny",
			decidedBy: { surface: "tui", clientId: null },
			requestedAt: "2026-08-21T10:10:00.000Z",
			deadline: null,
		});

		const lines = readLines(sessionFile);
		const last = JSON.parse(lines[lines.length - 1]) as PermissionResolutionEntry;
		expect(last.type).toBe("permission_resolution");
		expect(last.id).toBe(id);
		expect(last.decision).toBe("denied");
		expect(last.chosenOptionId).toBe("deny");
		expect(last.deadline).toBeNull();
		expect(last.decidedBy).toEqual({ surface: "tui", clientId: null });
		expect(last.detail).toEqual({ path: "/private/tmp/project/.env" });
	});

	it("records an expiry with no chosen option", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		session.appendMessage({ role: "user", content: "go", timestamp: 1 });
		session.appendMessage(assistantMessage("working", 2));

		session.appendPermissionResolution({
			requestId: "req-0003",
			toolCallId: "call_ghi789",
			toolName: "bash",
			cwd: "/private/tmp/project",
			detail: { command: "npm publish" },
			offeredOptionIds: ["approve", "deny"],
			decision: "expired",
			chosenOptionId: null,
			decidedBy: { surface: "system", clientId: null },
			requestedAt: "2026-08-21T10:20:00.000Z",
			deadline: "2026-08-21T10:25:00.000Z",
		});

		const lines = readLines(sessionFile);
		const last = JSON.parse(lines[lines.length - 1]) as PermissionResolutionEntry;
		expect(last.decision).toBe("expired");
		expect(last.chosenOptionId).toBeNull();
		expect(last.decidedBy.surface).toBe("system");
	});
});
