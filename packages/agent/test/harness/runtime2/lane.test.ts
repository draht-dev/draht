import { afterEach, describe, expect, it } from "vitest";
import type { Lane } from "../../../src/harness/runtime2/lane.ts";
import { restoreLane } from "../../../src/harness/runtime2/restore.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { CommitResult, LaneConfiguration, Session, Transaction } from "../../../src/harness/session/types.ts";

class ControlledMemoryStorage extends MemoryStorage {
	beforeNextCommit: (() => Promise<void>) | undefined;

	override async commit(transaction: Transaction): Promise<CommitResult> {
		const beforeCommit = this.beforeNextCommit;
		this.beforeNextCommit = undefined;
		await beforeCommit?.();
		return super.commit(transaction);
	}
}

const sessions: Session[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

async function createLane(): Promise<{ lane: Lane; session: Session; storage: ControlledMemoryStorage }> {
	const storage = new ControlledMemoryStorage();
	const session = new StorageBackedSession(
		{ id: `runtime2-lane-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		}),
	);
	return { lane: await restoreLane(session, "main"), session, storage };
}

function setThinkingLevel(
	lane: Lane,
	thinkingLevel: LaneConfiguration["thinkingLevel"],
	observed?: LaneConfiguration["thinkingLevel"][],
): Promise<LaneConfiguration["thinkingLevel"]> {
	return lane.transition((state) => {
		observed?.push(state.configuration.thinkingLevel);
		const next = { ...state, configuration: { ...state.configuration, thinkingLevel } };
		return {
			transaction: {
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.config",
						key: lane.name,
						value: next.configuration,
					},
				],
			},
			next,
			result: thinkingLevel,
		};
	});
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

describe("runtime2 Lane transitions", () => {
	it("publishes memory only after the durable commit succeeds", async () => {
		const { lane, session, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const transition = setThinkingLevel(lane, "high");
		await commitStarted.promise;

		expect(lane.state.configuration.thinkingLevel).toBe("off");
		releaseCommit.resolve();
		expect(await transition).toBe("high");
		expect(lane.state.configuration.thinkingLevel).toBe("high");
		expect((await session.getRegister("lane.config", "main"))?.value.thinkingLevel).toBe("high");
	});

	it("preserves memory when the durable commit fails", async () => {
		const { lane, session, storage } = await createLane();
		const failure = new Error("commit failed");
		storage.beforeNextCommit = async () => {
			throw failure;
		};

		await expect(setThinkingLevel(lane, "high")).rejects.toBe(failure);

		expect(lane.state.configuration.thinkingLevel).toBe("off");
		expect((await session.getRegister("lane.config", "main"))?.value.thinkingLevel).toBe("off");
	});

	it("plans queued transitions from the latest committed memory", async () => {
		const { lane, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		const observed: LaneConfiguration["thinkingLevel"][] = [];
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const first = setThinkingLevel(lane, "high", observed);
		await commitStarted.promise;
		const second = setThinkingLevel(lane, "medium", observed);
		await Promise.resolve();
		expect(observed).toEqual(["off"]);

		releaseCommit.resolve();
		expect(await Promise.all([first, second])).toEqual(["high", "medium"]);
		expect(observed).toEqual(["off", "high"]);
		expect(lane.state.configuration.thinkingLevel).toBe("medium");
	});
});
