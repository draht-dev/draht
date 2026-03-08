import { describe, expect, mock, test } from "bun:test";
import { EventBus } from "../session/event-bus";

describe("EventBus", () => {
	// 1. Constructs without error
	test("new EventBus() constructs without error", () => {
		expect(() => new EventBus()).not.toThrow();
	});

	// 2. session:created listener receives correct payload
	test('on("session:created") receives correct payload on emit', () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		const createdAt = new Date();
		bus.on("session:created", cb);
		bus.emit("session:created", { sessionId: "x", createdAt });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: "x", createdAt });
	});

	// 3. session:started listener receives { sessionId }
	test('on("session:started") receives { sessionId } payload', () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		bus.on("session:started", cb);
		bus.emit("session:started", { sessionId: "abc" });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: "abc" });
	});

	// 4. session:stopped listener receives { sessionId, exitCode }
	test('on("session:stopped") receives { sessionId, exitCode } payload', () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		bus.on("session:stopped", cb);
		bus.emit("session:stopped", { sessionId: "def", exitCode: 0 });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: "def", exitCode: 0 });
	});

	// 5. session:destroyed listener receives { sessionId }
	test('on("session:destroyed") receives { sessionId } payload', () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		bus.on("session:destroyed", cb);
		bus.emit("session:destroyed", { sessionId: "ghi" });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ sessionId: "ghi" });
	});

	// 6. Fan-out: multiple listeners on same event are each called
	test("multiple listeners on same event all receive the event (fan-out)", () => {
		const bus = new EventBus();
		const cb1 = mock(() => {});
		const cb2 = mock(() => {});
		const createdAt = new Date();
		bus.on("session:created", cb1);
		bus.on("session:created", cb2);
		bus.emit("session:created", { sessionId: "x", createdAt });
		expect(cb1).toHaveBeenCalledTimes(1);
		expect(cb2).toHaveBeenCalledTimes(1);
	});

	// 7. bus.off() unsubscribes the listener
	test("bus.off() removes the listener — cb is NOT called after off()", () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		bus.on("session:started", cb);
		bus.off("session:started", cb);
		bus.emit("session:started", { sessionId: "z" });
		expect(cb).toHaveBeenCalledTimes(0);
	});

	// 8. bus.on() returns an unsubscribe function
	test("bus.on() returns an unsubscribe function that removes the listener", () => {
		const bus = new EventBus();
		const cb = mock(() => {});
		const unsub = bus.on("session:started", cb);
		unsub();
		bus.emit("session:started", { sessionId: "z" });
		expect(cb).toHaveBeenCalledTimes(0);
	});

	// 9. After unsubscribing one, remaining listeners still fire
	test("unsubscribing one listener leaves other listeners intact", () => {
		const bus = new EventBus();
		const cb1 = mock(() => {});
		const cb2 = mock(() => {});
		const unsub1 = bus.on("session:started", cb1);
		bus.on("session:started", cb2);
		unsub1();
		bus.emit("session:started", { sessionId: "q" });
		expect(cb1).toHaveBeenCalledTimes(0);
		expect(cb2).toHaveBeenCalledTimes(1);
	});

	// 10. Emitting with no listeners does not throw
	test("emitting an event with no listeners does not throw", () => {
		const bus = new EventBus();
		expect(() => bus.emit("session:created", { sessionId: "x", createdAt: new Date() })).not.toThrow();
	});
});
