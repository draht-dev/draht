import { type Api, createModels, fauxProvider, type Model } from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessClosed } from "../../../src/harness/agent-harness.ts";
import { Lane } from "../../../src/harness/runtime2/lane.ts";
import { restoreLane } from "../../../src/harness/runtime2/restore.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { LaneConfiguration, Session } from "../../../src/harness/session/types.ts";
import { ControlledMemoryStorage, deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

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
		lane: new Lane("main", session, models, await restoreLane(session, "main"), (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
		),
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
	return lane.command((state) => {
		observed?.push(state.configuration.thinkingLevel);
		const next = { ...state, configuration: { ...state.configuration, thinkingLevel } };
		return {
			kind: "commit",
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
			materialize: () => thinkingLevel,
		};
	});
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

describe("runtime2 Lane commands", () => {
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

	it("derives queued configuration updates from the latest committed state", async () => {
		const { lane, model, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const modelUpdate = lane.setModel(model);
		await commitStarted.promise;
		const thinkingUpdate = lane.setThinkingLevel("high");
		releaseCommit.resolve();
		await Promise.all([modelUpdate, thinkingUpdate]);

		expect(lane.state.configuration).toEqual({
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel: "high",
			activeToolNames: [],
		});
	});

	it("returns a promise value without holding the lane line", async () => {
		const { lane } = await createLane();
		const completion = deferred();
		let completed = false;
		const joined = lane
			.command(() => ({ kind: "return", result: completion.promise }))
			.then(() => {
				completed = true;
			});

		await lane.setThinkingLevel("high");
		expect(completed).toBe(false);
		completion.resolve();
		await joined;
	});

	it("returns an expected rejection without faulting the lane", async () => {
		const { lane } = await createLane();
		const rejection = new Error("declined");

		await expect(lane.command(() => ({ kind: "reject", error: rejection }))).rejects.toBe(rejection);
		expect(await lane.getLeafId()).toBeNull();
		await lane.setThinkingLevel("high");
	});

	it("passes bounded reads and commit metadata through the serialized command", async () => {
		const { lane } = await createLane();
		let storedConfiguration: LaneConfiguration | undefined;
		let memoryPublished = false;

		const commit = await lane.command(async (state, reader) => {
			storedConfiguration = (await reader.getRegister("lane.config", "main"))?.value;
			const configuration: LaneConfiguration = { ...state.configuration, thinkingLevel: "high" };
			const next = { ...state, configuration };
			return {
				kind: "commit",
				transaction: {
					writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration }],
				},
				next,
				materialize: (commit) => {
					memoryPublished = lane.state === next;
					return commit;
				},
			};
		});

		expect(storedConfiguration).toEqual(configuration);
		expect(memoryPublished).toBe(true);
		expect(commit.seqs).toHaveLength(1);
		expect(commit.timestamp).toEqual(expect.any(Number));
	});

	it("rejects thenable materialization after publishing committed memory", async () => {
		const { lane, session } = await createLane();

		await expect(
			// @ts-expect-error Exercise the runtime guard against untyped callers.
			lane.command((state) => {
				const configuration: LaneConfiguration = { ...state.configuration, thinkingLevel: "high" };
				return {
					kind: "commit",
					transaction: {
						writes: [
							{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration },
						],
					},
					next: { ...state, configuration },
					materialize: async () => undefined,
				};
			}),
		).rejects.toThrow("Lane command materialize() must be synchronous");

		expect(lane.state.configuration.thinkingLevel).toBe("high");
		expect((await session.getRegister("lane.config", "main"))?.value.thinkingLevel).toBe("high");
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

		const command = setThinkingLevel(lane, "high");
		await commitStarted.promise;

		expect(lane.state.configuration.thinkingLevel).toBe("off");
		releaseCommit.resolve();
		expect(await command).toBe("high");
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

	it("plans queued commands from the latest committed memory", async () => {
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
