import { describe, expect, it, vi } from "vitest";
import { AgentLimiter, LimiterAbortedError } from "../../src/core/polyphase/limiter.ts";

describe("AgentLimiter", () => {
	it("grants FIFO up to capacity and calls onQueued only for waiters", async () => {
		const limiter = new AgentLimiter(2);
		const onQueued = vi.fn();
		const order: number[] = [];

		const first = await limiter.acquire();
		const second = await limiter.acquire();
		const thirdPromise = limiter.acquire({ onQueued }).then((lease) => {
			order.push(3);
			return lease;
		});
		const fourthPromise = limiter.acquire({ onQueued }).then((lease) => {
			order.push(4);
			return lease;
		});
		const fifthPromise = limiter.acquire({ onQueued }).then((lease) => {
			order.push(5);
			return lease;
		});

		expect(onQueued).toHaveBeenCalledTimes(3);
		expect(limiter.stats()).toEqual({ capacity: 2, active: 2, queued: 3 });

		first.release();
		const third = await thirdPromise;
		second.release();
		const fourth = await fourthPromise;
		third.release();
		const fifth = await fifthPromise;

		expect(order).toEqual([3, 4, 5]);
		fourth.release();
		fifth.release();
	});

	it("aborting a queued acquire rejects it and the next waiter is granted after releases", async () => {
		const limiter = new AgentLimiter(2);
		const first = await limiter.acquire();
		const second = await limiter.acquire();

		const thirdController = new AbortController();
		const fourthController = new AbortController();

		const third = limiter.acquire({ signal: thirdController.signal });
		const fourth = limiter.acquire({ signal: fourthController.signal });
		const fifth = limiter.acquire();

		expect(limiter.stats().queued).toBe(3);

		fourthController.abort();
		await expect(fourth).rejects.toBeInstanceOf(LimiterAbortedError);
		expect(limiter.stats().queued).toBe(2);

		first.release();
		const thirdLease = await third;
		expect(limiter.stats().queued).toBe(1);

		second.release();
		const fifthLease = await fifth;
		expect(limiter.stats().queued).toBe(0);

		thirdLease.release();
		fifthLease.release();
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const limiter = new AgentLimiter(1);
		const controller = new AbortController();
		controller.abort();
		await expect(limiter.acquire({ signal: controller.signal })).rejects.toBeInstanceOf(LimiterAbortedError);
		expect(limiter.stats()).toEqual({ capacity: 1, active: 0, queued: 0 });
	});

	it("does not over-grant when a lease is released twice", async () => {
		const limiter = new AgentLimiter(1);
		const lease = await limiter.acquire();
		const waiter = limiter.acquire();
		lease.release();
		lease.release();
		const waiterLease = await waiter;
		expect(limiter.stats()).toEqual({ capacity: 1, active: 1, queued: 0 });
		waiterLease.release();
	});

	it("a second release on the same lease does not grant a second queued waiter beyond capacity", async () => {
		const limiter = new AgentLimiter(1);
		const first = await limiter.acquire();
		const secondPromise = limiter.acquire();
		const thirdPromise = limiter.acquire();

		first.release();
		const second = await secondPromise;
		first.release();
		await Promise.resolve();
		await Promise.resolve();

		expect(limiter.stats()).toEqual({ capacity: 1, active: 1, queued: 1 });

		second.release();
		const third = await thirdPromise;
		third.release();
	});

	it("wakes queued waiters when capacity grows", async () => {
		const limiter = new AgentLimiter(1);
		const a = await limiter.acquire();
		const bPromise = limiter.acquire();
		const cPromise = limiter.acquire();
		expect(limiter.stats().queued).toBe(2);

		limiter.setCapacity(4);
		const [b, c] = await Promise.all([bPromise, cPromise]);
		expect(limiter.stats()).toEqual({ capacity: 4, active: 3, queued: 0 });
		a.release();
		b.release();
		c.release();
	});

	it("rejectAll rejects every waiter", async () => {
		const limiter = new AgentLimiter(1);
		await limiter.acquire();
		const queued = limiter.acquire();
		const reason = new Error("disposed");
		limiter.rejectAll(reason);
		await expect(queued).rejects.toBe(reason);
		expect(limiter.stats().queued).toBe(0);
	});

	it("normalizes non-finite and fractional capacity to a safe integer", async () => {
		const nanLimiter = new AgentLimiter(Number.NaN);
		expect(nanLimiter.capacity).toBe(1);

		const fractionalLimiter = new AgentLimiter(2.5);
		expect(fractionalLimiter.capacity).toBe(2);

		fractionalLimiter.setCapacity(Number.NaN);
		expect(fractionalLimiter.capacity).toBe(1);
	});

	it("rejects without ever granting a lease when onQueued aborts synchronously", async () => {
		const limiter = new AgentLimiter(1);
		const first = await limiter.acquire();
		const controller = new AbortController();

		const queued = limiter.acquire({ signal: controller.signal, onQueued: () => controller.abort() });
		await expect(queued).rejects.toBeInstanceOf(LimiterAbortedError);
		expect(limiter.stats().queued).toBe(0);

		first.release();
		expect(limiter.stats()).toEqual({ capacity: 1, active: 0, queued: 0 });
	});

	it("rejects and frees the slot when onQueued throws, instead of leaking the waiter", async () => {
		const limiter = new AgentLimiter(1);
		const first = await limiter.acquire();

		const queued = limiter.acquire({
			onQueued: () => {
				throw new Error("boom");
			},
		});
		await expect(queued).rejects.toThrow("boom");
		expect(limiter.stats()).toEqual({ capacity: 1, active: 1, queued: 0 });

		first.release();
		expect(limiter.stats()).toEqual({ capacity: 1, active: 0, queued: 0 });

		const third = await limiter.acquire();
		expect(limiter.stats()).toEqual({ capacity: 1, active: 1, queued: 0 });
		third.release();
	});

	it("isolates a throwing onChange listener so other listeners and the grant queue still run", async () => {
		const limiter = new AgentLimiter(1);
		const order: string[] = [];
		limiter.onChange(() => {
			throw new Error("boom");
		});
		limiter.onChange(() => order.push("second"));

		const first = await limiter.acquire();
		const waiter = limiter.acquire();
		first.release();
		const waiterLease = await waiter;

		expect(order).toEqual(["second", "second", "second"]);
		expect(limiter.stats()).toEqual({ capacity: 1, active: 1, queued: 0 });
		waiterLease.release();
	});

	it("fires onChange on grant, release and capacity change", async () => {
		const limiter = new AgentLimiter(1);
		const listener = vi.fn();
		const unsubscribe = limiter.onChange(listener);

		const lease = await limiter.acquire();
		expect(listener).toHaveBeenCalledTimes(1);

		lease.release();
		expect(listener).toHaveBeenCalledTimes(2);

		limiter.setCapacity(2);
		expect(listener).toHaveBeenCalledTimes(3);

		unsubscribe();
		await limiter.acquire();
		expect(listener).toHaveBeenCalledTimes(3);
	});
});
