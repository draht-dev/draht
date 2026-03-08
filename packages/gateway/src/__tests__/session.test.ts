import { describe, expect, test } from "bun:test";
import { Session } from "../session/session";
import { SessionProcess } from "../session/session-process";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Session", () => {
	test("Session.create() returns an id matching UUID v4 format", () => {
		const session = Session.create();
		expect(session.id).toMatch(UUID_V4_REGEX);
	});

	test('Session.create() (no args) → status === "starting" and createdAt within 100ms of now', () => {
		const before = Date.now();
		const session = Session.create();
		const after = Date.now();

		expect(session.status).toBe("starting");
		expect(session.createdAt).toBeInstanceOf(Date);
		expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(session.createdAt.getTime()).toBeLessThanOrEqual(after + 100);
	});

	test("Two Session.create() calls produce different ids", () => {
		const a = Session.create();
		const b = Session.create();
		expect(a.id).not.toBe(b.id);
	});

	// Phase 2 additions

	test('Session.create() with no args → status === "starting"', () => {
		const session = Session.create();
		expect(session.status).toBe("starting");
	});

	test('Session.create(["echo", "hello"]) → session.process instanceof SessionProcess', async () => {
		const session = Session.create(["echo", "hello"]);
		expect(session.process).toBeInstanceOf(SessionProcess);
		// Clean up — wait for process to finish
		await session.process?.exited;
	});

	test("Session.create() with no command → session.process === undefined", () => {
		const session = Session.create();
		expect(session.process).toBeUndefined();
	});

	test('Session with a process: after await session.process.exited → session.status === "stopped"', async () => {
		const session = Session.create(["echo", "hello"]);
		expect(session.process).toBeInstanceOf(SessionProcess);
		await session.process!.exited;
		expect(session.status).toBe("stopped");
	});
});
