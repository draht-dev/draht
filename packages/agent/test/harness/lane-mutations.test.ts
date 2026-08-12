import { describe, expect, it } from "vitest";
import { LaneMutationLine } from "../../src/harness/session/lane-mutations.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return {
		promise,
		resolve: () => {
			if (resolve === undefined) throw new Error("Deferred promise was not initialized");
			resolve();
		},
	};
}

describe("LaneMutationLine", () => {
	it("serializes each lane", async () => {
		const line = new LaneMutationLine();
		const gate = deferred();
		const order: string[] = [];
		const first = line.run("main", async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
			return "first";
		});
		const second = line.run("main", () => {
			order.push("second");
			return "second";
		});

		expect(order).toEqual(["first:start"]);
		gate.resolve();
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("continues the lane after a failed job while preserving the original failure", async () => {
		const line = new LaneMutationLine();
		const rejection = new Error("mutation failed");

		await expect(
			line.run("main", () => {
				throw rejection;
			}),
		).rejects.toBe(rejection);
		await expect(line.run("main", () => "next")).resolves.toBe("next");
	});

	it("seals queued and future jobs while draining the running job", async () => {
		const line = new LaneMutationLine();
		const gate = deferred();
		const running = line.run("main", async () => {
			await gate.promise;
			return "running";
		});
		await Promise.resolve();
		const queued = line.run("main", () => "queued");
		const closed = new Error("closed");

		const drained = line.seal(closed);
		await expect(line.run("other", () => "late")).rejects.toBe(closed);
		gate.resolve();
		await expect(running).resolves.toBe("running");
		await expect(queued).rejects.toBe(closed);
		await drained;
	});
});
