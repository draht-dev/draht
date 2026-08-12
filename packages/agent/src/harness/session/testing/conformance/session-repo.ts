import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import type { LaneConfiguration, LaneState, UsageRow } from "../../types.ts";
import type { SessionRepoConformanceCase, SessionRepoFixture, SessionRepoFixtureFactory } from "../types.ts";

const ROOT_ID = "00000000-0000-7000-8000-000000000001";
const CHILD_ID = "00000000-0000-7000-8000-000000000002";
const SIBLING_ID = "00000000-0000-7000-8000-000000000003";
const USAGE_ID = "00000000-0000-7000-8000-000000000004";
const OPERATION_ID = "00000000-0000-7000-8000-000000000005";
const PENDING_ID = "00000000-0000-7000-8000-000000000006";
const idleLaneState = { currentOperationId: null, pendingNextRun: [] } satisfies LaneState;
const configuration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;

function usageRow(): Omit<UsageRow, "seq"> {
	return {
		id: USAGE_ID,
		adjustment: true,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createCase(
	factory: SessionRepoFixtureFactory,
	group: string,
	name: string,
	test: (fixture: SessionRepoFixture) => Promise<void>,
): SessionRepoConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture);
		},
	};
}

/** Creates fresh, runner-independent cases for the SessionRepo contract. */
export function createSessionRepoConformance(
	factory: SessionRepoFixtureFactory,
): readonly SessionRepoConformanceCase[] {
	return [
		createCase(
			factory,
			"lifecycle",
			"creates an unconfigured main lane and rejects duplicate ids",
			async ({ repo, storageVersion }) => {
				const session = await repo.create({ id: "session" });

				deepStrictEqual(session.metadata, {
					id: "session",
					createdAt: session.metadata.createdAt,
					storageVersion,
				});
				strictEqual(await session.getLeafId(), null);
				deepStrictEqual((await session.getRegister("lane.state", "main"))?.value, {
					currentOperationId: null,
					pendingNextRun: [],
				});
				strictEqual(await session.getRegister("lane.config", "main"), undefined);
				await rejects(repo.create({ id: "session" }));
				await session.close();
			},
		),
		createCase(
			factory,
			"lifecycle",
			"lists metadata and preserves state across close and reopen",
			async ({ repo }) => {
				const first = await repo.create({ id: "first" });
				await first.setName("preserved");
				const second = await repo.create({ id: "second", parentSessionId: "parent" });
				await second.close();

				const listed = await repo.list();
				deepStrictEqual(
					listed
						.map(({ id, parentSessionId }) => ({ id, parentSessionId }))
						.sort((left, right) => left.id.localeCompare(right.id)),
					[
						{ id: "first", parentSessionId: undefined },
						{ id: "second", parentSessionId: "parent" },
					],
				);
				await rejects(repo.open(first.metadata));
				await first.close();
				const reopened = await repo.open(first.metadata);
				strictEqual(await reopened.getName(), "preserved");
				await reopened.close();
			},
		),
		createCase(factory, "lifecycle", "deletes closed sessions without affecting other sessions", async ({ repo }) => {
			const removed = await repo.create({ id: "removed" });
			const retained = await repo.create({ id: "retained" });
			await Promise.all([removed.close(), retained.close()]);

			await repo.delete(removed.metadata);
			deepStrictEqual(
				(await repo.list()).map(({ id }) => id),
				["retained"],
			);
			await rejects(repo.open(removed.metadata));
			await rejects(repo.delete(removed.metadata));
		}),
		createCase(factory, "lifecycle", "reserves destination ids across concurrent publication", async ({ repo }) => {
			const source = await repo.create({ id: "source" });
			const results = await Promise.allSettled([
				repo.create({ id: "destination" }),
				repo.fork(source.metadata, { id: "destination" }),
			]);
			strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
			strictEqual(results.filter((result) => result.status === "rejected").length, 1);
			for (const result of results) {
				if (result.status === "fulfilled") await result.value.close();
			}
			await source.close();
		}),

		createCase(factory, "forks", "forks a fresh session before first attachment", async ({ repo }) => {
			const source = await repo.create({ id: "source" });
			const fork = await repo.fork(source.metadata, { id: "fork" });

			strictEqual(fork.metadata.id, "fork");
			strictEqual(fork.metadata.parentSessionId, "source");
			strictEqual(await fork.getLeafId(), null);
			strictEqual(await fork.getRegister("lane.config", "main"), undefined);
			deepStrictEqual((await fork.getRegister("lane.state", "main"))?.value, {
				currentOperationId: null,
				pendingNextRun: [],
			});
			deepStrictEqual(await fork.findEntries(), []);
			deepStrictEqual(await fork.getStats(), {
				messageCount: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await Promise.all([source.close(), fork.close()]);
		}),
		createCase(
			factory,
			"forks",
			"forks one configured branch with scoped facts and a zero ledger",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" });
				await source.commit({
					writes: [
						{ kind: "entry", entry: { id: ROOT_ID, parentId: null, type: "custom", customType: "root" } },
						{
							kind: "entry",
							entry: {
								id: CHILD_ID,
								parentId: ROOT_ID,
								type: "message",
								message: { role: "user", content: "child", timestamp: 1 },
							},
						},
						{
							kind: "entry",
							entry: { id: SIBLING_ID, parentId: ROOT_ID, type: "custom", customType: "sibling" },
						},
						{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: CHILD_ID },
						{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration },
						{
							kind: "register",
							op: "set",
							namespace: "lane.state",
							key: "main",
							value: { currentOperationId: OPERATION_ID, pendingNextRun: [PENDING_ID] },
						},
						{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "source name" },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "custom", value: { copied: true } },
						{ kind: "register", op: "set", namespace: "fact.label", key: ROOT_ID, value: "root label" },
						{ kind: "register", op: "set", namespace: "fact.label", key: SIBLING_ID, value: "sibling label" },
						{
							kind: "register",
							op: "set",
							namespace: "pending.entry",
							key: PENDING_ID,
							value: { type: "custom", customType: "pending" },
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.meta",
							key: OPERATION_ID,
							value: {
								operationId: OPERATION_ID,
								lane: "main",
								sourceLeafId: CHILD_ID,
								startedAt: 1,
								intent: { kind: "compaction" },
							},
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: OPERATION_ID,
							value: {
								kind: "compaction",
								control: { status: "running" },
								structural: { taskId: OPERATION_ID, status: "deciding" },
							},
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.tool_args",
							key: `${OPERATION_ID}:${ROOT_ID}:0`,
							value: { argument: true },
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.preparation",
							key: `${OPERATION_ID}:${OPERATION_ID}`,
							value: {
								kind: "compaction",
								messagesToSummarize: [],
								turnPrefixMessages: [],
								retainedTail: [],
								isSplitTurn: false,
								tokensBefore: 0,
								fileOps: { read: [], written: [], edited: [] },
								settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
							},
						},
						{ kind: "usage", row: usageRow() },
					],
				});

				const fork = await repo.fork(source.metadata, { id: "fork", entryId: CHILD_ID, position: "at" });

				deepStrictEqual(
					(await fork.findEntries({ order: "asc" })).map(({ id }) => id),
					[ROOT_ID, CHILD_ID],
				);
				strictEqual(await fork.getLeafId(), CHILD_ID);
				deepStrictEqual((await fork.getRegister("lane.config", "main"))?.value, configuration);
				deepStrictEqual((await fork.getRegister("lane.state", "main"))?.value, idleLaneState);
				strictEqual(await fork.getName(), "source name");
				deepStrictEqual(await fork.getCustomFact("custom"), { copied: true });
				strictEqual(await fork.getLabel(ROOT_ID), "root label");
				strictEqual(await fork.getLabel(SIBLING_ID), undefined);
				strictEqual(await fork.getRegister("lane.lastResult", "main"), undefined);
				strictEqual(await fork.getRegister("pending.entry", PENDING_ID), undefined);
				strictEqual(await fork.getRegister("op.meta", OPERATION_ID), undefined);
				strictEqual(await fork.getRegister("op.state", OPERATION_ID), undefined);
				strictEqual(await fork.getRegister("op.tool_args", `${OPERATION_ID}:${ROOT_ID}:0`), undefined);
				strictEqual(await fork.getRegister("op.preparation", `${OPERATION_ID}:${OPERATION_ID}`), undefined);
				const stats = await fork.getStats();
				strictEqual(stats.messageCount, 1);
				deepStrictEqual(stats.usage, {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				});
				await Promise.all([source.close(), fork.close()]);
			},
		),
		createCase(
			factory,
			"forks",
			"supports before placement and rejects unknown fork points atomically",
			async ({ repo }) => {
				const source = await repo.create({ id: "source" });
				await source.commit({
					writes: [
						{ kind: "entry", entry: { id: ROOT_ID, parentId: null, type: "custom", customType: "root" } },
						{
							kind: "entry",
							entry: { id: CHILD_ID, parentId: ROOT_ID, type: "custom", customType: "child" },
						},
						{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: CHILD_ID },
					],
				});

				const before = await repo.fork(source.metadata, { id: "before", entryId: CHILD_ID, position: "before" });
				strictEqual(await before.getLeafId(), ROOT_ID);
				deepStrictEqual(
					(await before.findEntries({ order: "asc" })).map(({ id }) => id),
					[ROOT_ID],
				);
				await rejects(repo.fork(source.metadata, { id: "failed", entryId: SIBLING_ID }));
				deepStrictEqual((await repo.list()).map(({ id }) => id).sort(), ["before", "source"]);
				await Promise.all([source.close(), before.close()]);
			},
		),
		createCase(factory, "forks", "forks a closed source session", async ({ repo }) => {
			const source = await repo.create({ id: "source" });
			await source.commit({
				writes: [
					{ kind: "entry", entry: { id: ROOT_ID, parentId: null, type: "custom", customType: "root" } },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: ROOT_ID },
				],
			});
			await source.close();

			const fork = await repo.fork(source.metadata, { id: "fork" });
			strictEqual(await fork.getLeafId(), ROOT_ID);
			await fork.close();
		}),

		createCase(factory, "forks", "forks the whole configured tree with fresh lane state", async ({ repo }) => {
			const source = await repo.create({ id: "source" });
			await source.commit({
				writes: [
					{ kind: "entry", entry: { id: ROOT_ID, parentId: null, type: "custom", customType: "root" } },
					{
						kind: "entry",
						entry: { id: CHILD_ID, parentId: ROOT_ID, type: "custom", customType: "child" },
					},
					{
						kind: "entry",
						entry: { id: SIBLING_ID, parentId: ROOT_ID, type: "custom", customType: "sibling" },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: CHILD_ID },
					{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "review", value: SIBLING_ID },
					{ kind: "register", op: "set", namespace: "lane.config", key: "review", value: configuration },
					{ kind: "register", op: "set", namespace: "lane.state", key: "review", value: idleLaneState },
				],
			});

			const fork = await repo.fork(source.metadata, { id: "fork", scope: "tree" });

			deepStrictEqual(
				(await fork.findEntries({ order: "asc" })).map(({ id }) => id),
				[ROOT_ID, CHILD_ID, SIBLING_ID],
			);
			strictEqual(await fork.getLeafId(), CHILD_ID);
			strictEqual(await fork.view("review").getLeafId(), SIBLING_ID);
			deepStrictEqual((await fork.getRegister("lane.config", "review"))?.value, configuration);
			deepStrictEqual((await fork.getRegister("lane.state", "review"))?.value, idleLaneState);
			await Promise.all([source.close(), fork.close()]);
		}),
		createCase(factory, "forks", "captures one coherent boundary between source commits", async ({ repo }) => {
			const source = await repo.create({ id: "source" });
			const firstCommit = source.commit({
				writes: [
					{ kind: "entry", entry: { id: ROOT_ID, parentId: null, type: "custom", customType: "first" } },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: ROOT_ID },
				],
			});
			const fork = repo.fork(source.metadata, { id: "fork" });
			const secondCommit = source.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: CHILD_ID, parentId: ROOT_ID, type: "custom", customType: "second" },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: CHILD_ID },
				],
			});

			const [, forked] = await Promise.all([firstCommit, fork]);
			await secondCommit;
			strictEqual(await forked.getLeafId(), ROOT_ID);
			deepStrictEqual(
				(await forked.findEntries({ order: "asc" })).map(({ id }) => id),
				[ROOT_ID],
			);
			await Promise.all([source.close(), forked.close()]);
		}),
	];
}
