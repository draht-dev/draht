import { describe, expect, test } from "bun:test";
import type { DestroyableManager, StoppableServer } from "../gateway/lifecycle";
import { GatewayLifecycle } from "../gateway/lifecycle";

/** Builds a mock StoppableServer that records calls. */
function makeServer(): StoppableServer & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		stop() {
			calls.push("stop");
		},
	};
}

/** Builds a mock DestroyableManager that returns `count` from destroyAll(). */
function makeManager(count = 0): DestroyableManager & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		destroyAll() {
			calls.push("destroy");
			return count;
		},
	};
}

describe("GatewayLifecycle", () => {
	test("shutdown() calls server.stop() then manager.destroyAll()", async () => {
		const allCalls: string[] = [];
		const server: StoppableServer = {
			stop() {
				allCalls.push("stop");
			},
		};
		const manager: DestroyableManager = {
			destroyAll() {
				allCalls.push("destroy");
				return 0;
			},
		};

		const lifecycle = new GatewayLifecycle(server, manager);
		await lifecycle.shutdown();

		expect(allCalls).toEqual(["stop", "destroy"]);
	});

	test("shutdown() returns the count from destroyAll()", async () => {
		const server = makeServer();
		const manager = makeManager(3);

		const lifecycle = new GatewayLifecycle(server, manager);
		const result = await lifecycle.shutdown();

		expect(result).toBe(3);
	});

	test("shutdown() on empty manager resolves to 0", async () => {
		const server = makeServer();
		const manager = makeManager(0);

		const lifecycle = new GatewayLifecycle(server, manager);
		expect(await lifecycle.shutdown()).toBe(0);
	});

	test("shutdown() is idempotent — second call does not re-invoke stop/destroyAll", async () => {
		const server = makeServer();
		const manager = makeManager(1);

		const lifecycle = new GatewayLifecycle(server, manager);
		await lifecycle.shutdown();
		await lifecycle.shutdown();

		expect(server.calls.filter((c) => c === "stop")).toHaveLength(1);
		expect(manager.calls.filter((c) => c === "destroy")).toHaveLength(1);
	});

	test("shutdown() concurrent calls are safe — stop called once", async () => {
		const server = makeServer();
		const manager = makeManager(2);

		const lifecycle = new GatewayLifecycle(server, manager);
		const [r1, r2] = await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);

		expect(server.calls.filter((c) => c === "stop")).toHaveLength(1);
		expect(manager.calls.filter((c) => c === "destroy")).toHaveLength(1);
		expect(r1).toBe(2);
		expect(r2).toBe(2);
	});
});
