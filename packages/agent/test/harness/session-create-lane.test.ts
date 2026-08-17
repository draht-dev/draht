// Implements Part 8, slice 2.
// Full state validation is R1; harness-wide close admission is R6.

import { describe, expect, expectTypeOf, it } from "vitest";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { SessionInvariantError, StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage, StorageDecorator } from "../../src/harness/session/testing/index.ts";
import type {
	Entry,
	LaneConfiguration,
	LaneState,
	Session,
	SessionMetadata,
	Write,
} from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;
const ROOT_ID = "00000000-0000-7000-8000-000000000001";
const MISSING_ID = "00000000-0000-7000-8000-000000000099";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
} satisfies SessionMetadata;
const configuration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;
const idleLaneState = { currentOperationId: null, pendingNextRun: [] } satisfies LaneState;

function rootTransaction(): Write[] {
	return [
		sessionWrites.insertEntry({ id: ROOT_ID, parentId: null, type: "custom", customType: "root" }),
		storedValues.setValue(storedValues.laneLeaf("main"), ROOT_ID),
		storedValues.setValue(storedValues.laneState("main"), idleLaneState),
	];
}

function commitSession(session: Session, transaction: Write[]) {
	return session.mutate("main", (mutator) => mutator.commit(transaction));
}

function expectedLaneWrites(name: string, at: string | null, value: LaneConfiguration): Write[] {
	return [
		storedValues.setValue(storedValues.laneConfig(name), value),
		storedValues.setValue(storedValues.laneLeaf(name), at),
		storedValues.setValue(storedValues.laneState(name), idleLaneState),
	];
}

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

class RejectingCommitStorage extends StorageDecorator {
	rejection: Error | undefined;

	override commit(transaction: Write[]) {
		return this.rejection === undefined ? super.commit(transaction) : Promise.reject(this.rejection);
	}
}

class BlockingCommitStorage extends StorageDecorator {
	block = false;
	private readonly admittedGate = deferred();
	private readonly releaseGate = deferred();

	get admitted(): Promise<void> {
		return this.admittedGate.promise;
	}

	override async commit(transaction: Write[]) {
		if (this.block) {
			this.admittedGate.resolve();
			await this.releaseGate.promise;
		}
		return super.commit(transaction);
	}

	release(): void {
		this.releaseGate.resolve();
	}
}

describe("StorageBackedSession.createLane", () => {
	it("completes the package-internal Session contract", () => {
		expectTypeOf<StorageBackedSession>().toMatchTypeOf<Session>();
	});

	it("atomically creates configured lane views at an entry or at the root", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.clearCommitAttempts();

		const rooted = await session.createLane("rooted", ROOT_ID, configuration);
		const empty = await session.createLane("empty", null, configuration);

		expect(storage.getCommitAttempts()).toEqual([
			expectedLaneWrites("rooted", ROOT_ID, configuration),
			expectedLaneWrites("empty", null, configuration),
		]);
		expect(await rooted.getLeafId()).toBe(ROOT_ID);
		expect((await rooted.findEntriesOnBranch()).map((entry: Entry) => entry.id)).toEqual([ROOT_ID]);
		expect(await empty.getLeafId()).toBeNull();
		expect(await empty.findEntriesOnBranch()).toEqual([]);
		expect(await session.getValue(storedValues.laneConfig("rooted"))).toMatchObject({ value: configuration });
		expect(await session.getValue(storedValues.laneState("rooted"))).toMatchObject({ value: idleLaneState });
		await session.close();
	});

	it("passes configuration directly to storage", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.clearCommitAttempts();
		const supplied = {
			model: { ...configuration.model },
			thinkingLevel: configuration.thinkingLevel,
			activeToolNames: [...configuration.activeToolNames],
		};

		await session.createLane("captured", ROOT_ID, supplied);

		expect((await session.getValue(storedValues.laneConfig("captured")))?.value).toBe(supplied);
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close();
	});

	// Slice 2 defines classifiable session failures. Mapping them to AgentHarness
	// LaneExists/InvalidLane/UnknownTarget results and publishing events belong to later runtime slices.
	it("rejects invalid lane names before storage admission with a classifiable validation error", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.clearCommitAttempts();

		await expect(session.createLane("", ROOT_ID, configuration)).rejects.toMatchObject({
			name: "SessionInvalidLaneError",
			lane: "",
		});
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("rejects existing configured lanes and fresh unconfigured main without writing", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		await session.createLane("existing", ROOT_ID, configuration);
		storage.clearCommitAttempts();

		for (const name of ["existing", "main"]) {
			await expect(session.createLane(name, null, configuration)).rejects.toMatchObject({
				name: "SessionLaneExistsError",
				lane: name,
			});
		}
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("rejects unknown non-null anchors without writing", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.clearCommitAttempts();

		await expect(session.createLane("missing-target", MISSING_ID, configuration)).rejects.toMatchObject({
			name: "SessionUnknownTargetError",
			targetId: MISSING_ID,
		});
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("fails fast on every partial lane-register combination instead of repairing it", async () => {
		const partialWrites: Write[] = [
			storedValues.setValue(storedValues.laneConfig("broken"), configuration),
			storedValues.setValue(storedValues.laneLeaf("broken"), null),
			storedValues.setValue(storedValues.laneState("broken"), idleLaneState),
			storedValues.setValue(storedValues.laneLastResult("broken"), {
				operationId: ROOT_ID,
				kind: "navigation",
				leafId: null,
				oldLeafId: ROOT_ID,
				outcome: "completed",
			}),
		];

		for (let mask = 1; mask < 1 << partialWrites.length; mask++) {
			const hasAllRequiredRegisters = (mask & 0b0111) === 0b0111;
			if (hasAllRequiredRegisters) continue;
			const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
			const session = new StorageBackedSession(metadata, storage);
			await commitSession(
				session,
				partialWrites.filter((_, index) => (mask & (1 << index)) !== 0),
			);
			storage.clearCommitAttempts();

			await expect(session.createLane("broken", null, configuration)).rejects.toBeInstanceOf(SessionInvariantError);
			expect(storage.getCommitAttempts()).toEqual([]);
			await session.close();
		}
	});

	it("serializes concurrent duplicate creation so exactly one transaction wins", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.clearCommitAttempts();

		const results = await Promise.allSettled([
			session.createLane("race", ROOT_ID, configuration),
			session.createLane("race", null, configuration),
		]);

		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ reason: { name: "SessionLaneExistsError", lane: "race" } });
		expect(storage.getCommitAttempts()).toHaveLength(1);
		const leaf = await session.view("race").getLeafId();
		expect([ROOT_ID, null]).toContain(leaf);
		await session.close();
	});

	it("orders lane creation with appends submitted through the prospective view", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await commitSession(session, rootTransaction());

		const creating = session.createLane("created-first", ROOT_ID, configuration);
		const appended = session.view("created-first").appendCustomEntry("note");
		const [, entryId] = await Promise.all([creating, appended]);
		expect(await session.view("created-first").getLeafId()).toBe(entryId);
		expect(await session.getEntry(entryId)).toMatchObject({ parentId: ROOT_ID, customType: "note" });

		const rejectedAppend = session.view("append-first").appendCustomEntry("note");
		const laterCreation = session.createLane("append-first", ROOT_ID, configuration);
		await expect(rejectedAppend).rejects.toBeInstanceOf(SessionInvariantError);
		await laterCreation;
		expect(await session.view("append-first").getLeafId()).toBe(ROOT_ID);
		expect(await session.findEntries({ customType: "note" })).toHaveLength(1);
		await session.close();
	});

	it("propagates commit failure without publishing partial lane state", async () => {
		const storage = new RejectingCommitStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		const rejection = new Error("commit failed");
		storage.rejection = rejection;

		await expect(session.createLane("failed", ROOT_ID, configuration)).rejects.toBe(rejection);
		storage.rejection = undefined;
		expect(await session.getValue(storedValues.laneConfig("failed"))).toBeUndefined();
		expect(await session.getValue(storedValues.laneLeaf("failed"))).toBeUndefined();
		expect(await session.getValue(storedValues.laneState("failed"))).toBeUndefined();
		await session.close();
	});

	it("drains creation after its commit is admitted to storage and rejects creation after close", async () => {
		const storage = new BlockingCommitStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.block = true;

		const creation = session.createLane("admitted", ROOT_ID, configuration);
		await storage.admitted;
		const close = session.close();
		storage.release();

		await creation;
		await close;
		await expect(session.createLane("late", null, configuration)).rejects.toThrow("Session is closed");
	});

	it("rejects queued duplicate creation when close seals the lane mutation line", async () => {
		const storage = new BlockingCommitStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, rootTransaction());
		storage.block = true;

		const admitted = session.createLane("queued", ROOT_ID, configuration);
		await storage.admitted;
		const queued = session.createLane("queued", null, configuration);
		const close = session.close();
		storage.release();

		await admitted;
		await expect(queued).rejects.toThrow("Session is closed");
		await close;
	});
});
