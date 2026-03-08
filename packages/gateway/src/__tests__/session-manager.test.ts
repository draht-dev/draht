import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { SessionProcess } from "../session/session-process";

describe("SessionManager", () => {
	let manager: SessionManager;

	beforeEach(() => {
		manager = new SessionManager(new EventBus());
	});

	test("list() starts empty", () => {
		expect(manager.list()).toEqual([]);
	});

	test("create() adds session to list — list has length 1 and id matches", () => {
		const session = manager.create();
		const list = manager.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.id).toBe(session.id);
	});

	test("get(id) returns the correct session (deep equality)", () => {
		const session = manager.create();
		const found = manager.get(session.id);
		expect(found).toEqual(session);
	});

	test("get(nonExistentId) returns undefined", () => {
		expect(manager.get("non-existent-id")).toBeUndefined();
	});

	test("destroy(id) removes session from list and get returns undefined", () => {
		const session = manager.create();
		manager.destroy(session.id);
		expect(manager.list()).toHaveLength(0);
		expect(manager.get(session.id)).toBeUndefined();
	});

	test("destroy(id) returns true on success", () => {
		const session = manager.create();
		expect(manager.destroy(session.id)).toBe(true);
	});

	test("destroy(nonExistentId) returns false", () => {
		expect(manager.destroy("does-not-exist")).toBe(false);
	});

	test("multiple sessions coexist — create 3, list has length 3", () => {
		manager.create();
		manager.create();
		manager.create();
		expect(manager.list()).toHaveLength(3);
	});

	test("destroy is selective — destroy A, list contains only B", () => {
		const a = manager.create();
		const b = manager.create();
		manager.destroy(a.id);
		const list = manager.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.id).toBe(b.id);
	});

	// Phase 2 additions

	test('create() with no args → status === "starting", process === undefined', () => {
		const session = manager.create();
		expect(session.status).toBe("starting");
		expect(session.process).toBeUndefined();
	});

	test('create(["echo", "hello"]) → session.process is defined (instanceof SessionProcess)', async () => {
		const session = manager.create(["echo", "hello"]);
		expect(session.process).toBeInstanceOf(SessionProcess);
		await session.process?.exited;
	});

	test('destroy(id) on live process → process is killed → after await proc.exited → status === "stopped"', async () => {
		const session = manager.create(["cat"]);
		const proc = session.process!;
		expect(proc).toBeInstanceOf(SessionProcess);
		await proc.ready;

		manager.destroy(session.id);
		await proc.exited;

		expect(proc.status).toBe("stopped");
	});

	test('after process exits naturally → session.status === "stopped"', async () => {
		const session = manager.create(["echo", "done"]);
		expect(session.process).toBeInstanceOf(SessionProcess);
		await session.process!.exited;
		expect(session.status).toBe("stopped");
	});
});
