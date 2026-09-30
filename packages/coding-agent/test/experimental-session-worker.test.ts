import { afterEach, describe, expect, test } from "vitest";
import {
	type ExperimentalSessionWorker,
	startExperimentalSessionWorker,
} from "../src/cli/experimental/session-worker.ts";

const workers = new Set<ExperimentalSessionWorker>();
const fixtureUrl = new URL("fixtures/session-worker-fixture.ts", import.meta.url);

afterEach(async () => {
	await Promise.all([...workers].map((worker) => worker.close()));
	workers.clear();
});

describe("experimental session worker controller", () => {
	test("starts a real child, validates readiness, and closes idempotently", async () => {
		const worker = await startExperimentalSessionWorker("ready", { workerUrl: fixtureUrl });
		workers.add(worker);

		expect(worker.sessionId).toBe("ready");
		expect(worker.pid).not.toBe(process.pid);
		expect(processExists(worker.pid)).toBe(true);

		await Promise.all([worker.close(), worker.close()]);
		expect(processExists(worker.pid)).toBe(false);
		await expect(worker.terminated).resolves.toBeUndefined();
	});

	test("times out and kills a child that never reports readiness", async () => {
		await expect(
			startExperimentalSessionWorker("startup-hang", {
				workerUrl: fixtureUrl,
				startupTimeoutMs: 10,
			}),
		).rejects.toThrow(/startup timed out/);
	});

	test.each([
		["failure event", "fail", /fixture startup failed/],
		["exit before readiness", "exit", /exited before readiness/],
		["invalid ready identity", "mismatch", /invalid identity/],
	] as const)("rejects %s", async (_label, sessionId, message) => {
		await expect(startExperimentalSessionWorker(sessionId, { workerUrl: fixtureUrl })).rejects.toThrow(message);
	});

	test("kills a worker that ignores graceful shutdown", async () => {
		const worker = await startExperimentalSessionWorker("hang", {
			workerUrl: fixtureUrl,
			shutdownTimeoutMs: 10,
		});
		workers.add(worker);

		await worker.close();
		expect(processExists(worker.pid)).toBe(false);
	});

	test("reports an unexpected exit after readiness", async () => {
		const worker = await startExperimentalSessionWorker("ready", { workerUrl: fixtureUrl });
		workers.add(worker);

		process.kill(worker.pid, "SIGKILL");
		await expect(worker.terminated).resolves.toEqual(
			expect.objectContaining({ message: expect.stringMatching(/exited unexpectedly.*SIGKILL/) }),
		);
		expect(processExists(worker.pid)).toBe(false);
	});
});

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
