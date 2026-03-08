import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	SessionCreatedPayload,
	SessionDestroyedPayload,
	SessionStartedPayload,
	SessionStoppedPayload,
} from "../session/event-bus";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

describe("SessionManager domain events", () => {
	let bus: EventBus;
	let manager: SessionManager;

	beforeEach(() => {
		bus = new EventBus();
		manager = new SessionManager(bus);
	});

	// 1. create() emits session:created with correct payload
	test("create() emits session:created with { sessionId, createdAt }", () => {
		const cb = mock((_payload: SessionCreatedPayload) => {});
		bus.on("session:created", cb);

		const session = manager.create();

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: session.id, createdAt: session.createdAt });
	});

	// 2. create(['echo', 'hi']) emits session:created synchronously
	test('create(["echo", "hi"]) emits session:created synchronously', () => {
		const cb = mock((_payload: SessionCreatedPayload) => {});
		bus.on("session:created", cb);

		manager.create(["echo", "hi"]);

		// synchronous — no await needed
		expect(cb).toHaveBeenCalledTimes(1);
	});

	// 3. After proc.ready, emits session:started with { sessionId }
	test("after proc.ready resolves, emits session:started with { sessionId }", async () => {
		const cb = mock((_payload: SessionStartedPayload) => {});
		bus.on("session:started", cb);

		const session = manager.create(["echo", "hi"]);
		await session.process!.ready;

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: session.id });

		await session.process!.exited;
	});

	// 4. After proc.exited, emits session:stopped with { sessionId, exitCode: 0 }
	test("after proc.exited resolves, emits session:stopped with { sessionId, exitCode: 0 }", async () => {
		const cb = mock((_payload: SessionStoppedPayload) => {});
		bus.on("session:stopped", cb);

		const session = manager.create(["echo", "hi"]);
		await session.process!.exited;

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: session.id, exitCode: 0 });
	});

	// 5. destroy() on a no-process session emits session:destroyed
	test("destroy(id) on a no-process session emits session:destroyed with { sessionId }", () => {
		const cb = mock((_payload: SessionDestroyedPayload) => {});
		bus.on("session:destroyed", cb);

		const session = manager.create();
		manager.destroy(session.id);

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: session.id });
	});

	// 6. destroy(nonExistent) emits NO events
	test("destroy(nonExistentId) emits NO events", () => {
		const destroyedCb = mock((_payload: SessionDestroyedPayload) => {});
		bus.on("session:destroyed", destroyedCb);

		const result = manager.destroy("00000000-0000-4000-8000-000000000000");

		expect(result).toBe(false);
		expect(destroyedCb).toHaveBeenCalledTimes(0);
	});

	// 7. create() with no command does NOT emit session:started or session:stopped
	test("create() with no command does NOT emit session:started or session:stopped", async () => {
		const startedCb = mock((_payload: SessionStartedPayload) => {});
		const stoppedCb = mock((_payload: SessionStoppedPayload) => {});
		bus.on("session:started", startedCb);
		bus.on("session:stopped", stoppedCb);

		manager.create();

		// Allow microtasks to flush
		await Promise.resolve();

		expect(startedCb).toHaveBeenCalledTimes(0);
		expect(stoppedCb).toHaveBeenCalledTimes(0);
	});

	// 8. Creating two sessions emits session:created twice with correct sessionIds
	test("creating two sessions emits session:created twice with correct sessionIds", () => {
		const payloads: SessionCreatedPayload[] = [];
		bus.on("session:created", (p) => payloads.push(p));

		const s1 = manager.create();
		const s2 = manager.create();

		expect(payloads).toHaveLength(2);
		expect(payloads[0]?.sessionId).toBe(s1.id);
		expect(payloads[1]?.sessionId).toBe(s2.id);
	});
});
