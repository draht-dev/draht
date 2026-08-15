import { type Api, createModels, fauxProvider, type Model } from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessClosed } from "../../../src/harness/agent-harness.ts";
import { Lane } from "../../../src/harness/runtime2/lane.ts";
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

async function createLane(): Promise<{
	lane: Lane;
	model: Model<Api>;
	session: Session;
	storage: ControlledMemoryStorage;
}> {
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
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		lane: new Lane("main", session, models, await restoreLane(session, "main")),
		model: faux.getModel(),
		session,
		storage,
	};
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
	it("reads and replaces configuration from owned state", async () => {
		const { lane, model, session } = await createLane();
		const activeToolNames = ["read"];

		await lane.setModel(model);
		await lane.setThinkingLevel("high");
		await lane.setActiveTools(activeToolNames);

		expect(await lane.getModel()).toBe(model);
		expect(await lane.getThinkingLevel()).toBe("high");
		expect(await lane.getActiveTools()).toBe(activeToolNames);
		expect((await session.getRegister("lane.config", "main"))?.value).toEqual({
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel: "high",
			activeToolNames,
		});
	});

	it("rejects work after sealing while an admitted commit finishes", async () => {
		const { lane, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const admitted = setThinkingLevel(lane, "high");
		await commitStarted.promise;
		const closed = new HarnessClosed();
		lane.seal(closed);

		await expect(lane.getLeafId()).rejects.toBe(closed);
		await expect(lane.setThinkingLevel("low")).rejects.toBe(closed);
		releaseCommit.resolve();
		await admitted;
		expect(lane.state.configuration.thinkingLevel).toBe("high");
	});

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
