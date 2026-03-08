import { beforeEach, describe, expect, mock, test } from "bun:test";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

describe("SessionManager.destroyAll()", () => {
	let bus: EventBus;
	let manager: SessionManager;

	beforeEach(() => {
		bus = new EventBus();
		manager = new SessionManager(bus);
	});

	test("destroyAll() on empty manager returns 0", () => {
		expect(manager.destroyAll()).toBe(0);
	});

	test("destroyAll() with 3 sessions returns 3 and list() is empty after", () => {
		manager.create();
		manager.create();
		manager.create();
		expect(manager.destroyAll()).toBe(3);
		expect(manager.list()).toHaveLength(0);
	});

	test("destroyAll() with 1 session returns 1 and that session is no longer in get()", () => {
		const session = manager.create();
		expect(manager.destroyAll()).toBe(1);
		expect(manager.get(session.id)).toBeUndefined();
	});

	test("destroyAll() emits session:destroyed for each session", () => {
		const spy = mock(() => {});
		bus.on("session:destroyed", spy);

		manager.create();
		manager.create();
		manager.create();

		manager.destroyAll();

		expect(spy).toHaveBeenCalledTimes(3);
	});

	test("destroyAll() is safe to call twice — second call returns 0", () => {
		manager.create();
		manager.create();
		manager.destroyAll();
		expect(manager.destroyAll()).toBe(0);
	});

	test("destroyAll() with live processes — kills each process", async () => {
		const s1 = manager.create(["cat"]);
		const s2 = manager.create(["cat"]);
		const proc1 = s1.process!;
		const proc2 = s2.process!;

		await proc1.ready;
		await proc2.ready;

		manager.destroyAll();

		await proc1.exited;
		await proc2.exited;

		expect(proc1.status).toBe("stopped");
		expect(proc2.status).toBe("stopped");
	});
});
