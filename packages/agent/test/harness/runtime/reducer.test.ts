import { createModels, fauxAssistantMessage, fauxProvider } from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type HarnessEvent, type LaneSnapshot } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { reduceLaneSnapshot } from "../../../src/harness/runtime/reducer.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { Session } from "../../../src/harness/session/types.ts";

const sessions: Session[] = [];

async function createFixture(options: { deferred?: boolean } = {}) {
	const session = new StorageBackedSession(
		{ id: `reducer-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(options.deferred === true ? { streamOptions: { deferred: true } } : {}),
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux };
}

async function settleEvents(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function fold(snapshot: LaneSnapshot, events: HarnessEvent[]): LaneSnapshot {
	let current = snapshot;
	for (const event of events) {
		const reduced = reduceLaneSnapshot(current, event);
		if ("rebase" in reduced) throw new Error(`Unexpected rebase for ${event.type}`);
		current = reduced;
	}
	return current;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("lane snapshot reducer", () => {
	it("folds an ordinary run to the authoritative resnapshot", async () => {
		const { lane, faux } = await createFixture();
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		await settleEvents();

		expect(fold(watch.snapshot, events)).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("folds suspend and resume without closing the operation early", async () => {
		const { lane, faux } = await createFixture({ deferred: true });
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "suspended" },
		});
		await settleEvents();
		let replica = fold(watch.snapshot, events);
		expect(replica.operation).toMatchObject({ kind: "run", deferred: { poll: 0 } });
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));

		events.length = 0;
		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		await settleEvents();
		replica = fold(watch.snapshot, events);
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("folds standalone compaction and preserves segment semantics", async () => {
		const { lane, faux } = await createFixture();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("summary")]);

		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { status: "completed" } },
		});
		await settleEvents();
		const replica = fold(watch.snapshot, events);

		expect(replica.operation).toBeNull();
		expect(replica.lastResult).toMatchObject({ kind: "compaction", status: "completed" });
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("replicates globally ordered queue changes", async () => {
		const { lane } = await createFixture();
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});

		await lane.nextRun("next", undefined, BACKGROUND_CONTEXT);
		const steer = await lane.steer("steer", undefined, BACKGROUND_CONTEXT);
		await lane.followUp("follow", undefined, BACKGROUND_CONTEXT);
		if (!steer.ok) throw steer.error;
		await lane.cancelQueued(steer.value.entryId, BACKGROUND_CONTEXT);
		await settleEvents();

		const replica = fold(watch.snapshot, events);
		expect(replica.queues.map((item) => item.kind)).toEqual(["nextRun", "followUp"]);
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("keeps in-run compaction segments inside the open run", async () => {
		const { lane } = await createFixture();
		const snapshot = (await lane.watch(BACKGROUND_CONTEXT)).snapshot;
		const running: LaneSnapshot = {
			...snapshot,
			operation: {
				id: "run",
				kind: "run",
				startedAt: 1,
				fromTipId: null,
				status: "open",
				runningTools: [],
			},
		};
		const started = reduceLaneSnapshot(running, {
			type: "compaction_start",
			lane: "main",
			runId: "run",
			reason: "threshold",
			startedAt: 2,
		});
		if ("rebase" in started) throw new Error("Unexpected segment rebase");
		const ended = reduceLaneSnapshot(started, {
			type: "compaction_end",
			lane: "main",
			runId: "run",
			reason: "threshold",
			status: "declined",
			endedAt: 3,
		});
		expect(ended).toMatchObject({ operation: { id: "run", kind: "run" } });
	});

	it("marks navigation completion for rebase", async () => {
		const { lane } = await createFixture();
		const snapshot = (await lane.watch(BACKGROUND_CONTEXT)).snapshot;
		const reduced = reduceLaneSnapshot(
			{
				...snapshot,
				operation: {
					id: "navigation",
					kind: "navigation",
					startedAt: 1,
					fromTipId: null,
					status: "open",
					runningTools: [],
				},
			},
			{
				type: "navigation_end",
				lane: "main",
				runId: "navigation",
				status: "completed",
				fromTipId: null,
				tipId: "target",
				endedAt: 2,
			},
		);
		expect(reduced).toEqual({ rebase: true });
	});
});
