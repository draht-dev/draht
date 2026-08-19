import type { Usage } from "@draht/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	JSONL_STORAGE_VERSION,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
} from "../../src/harness/session/jsonl/index.ts";
import type { Entry, Session } from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

function uuidTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

describe("JSONL v3 migration", () => {
	let fileSystem: NodeExecutionEnv;
	let repo: JsonlSessionRepo;

	beforeEach(() => {
		fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
	});

	afterEach(async () => {
		await repo.close(BACKGROUND_CONTEXT);
	});

	async function writeLegacyV3Fixture(
		records: readonly unknown[],
		headerOptions: { parentSession?: string } = {},
	): Promise<{ path: string; content: string }> {
		const directory = getOrThrow(await fileSystem.joinPath(["sessions", "--workspace--"], BACKGROUND_CONTEXT));
		getOrThrow(await fileSystem.createDir(directory, undefined, BACKGROUND_CONTEXT));
		const relativePath = getOrThrow(await fileSystem.joinPath([directory, "legacy.jsonl"], BACKGROUND_CONTEXT));
		const path = getOrThrow(await fileSystem.absolutePath(relativePath, BACKGROUND_CONTEXT));
		const content = `${[
			{
				type: "session",
				version: 3,
				id: "legacy",
				timestamp: new Date(NOW).toISOString(),
				cwd: "/workspace",
				...headerOptions,
			},
			...records,
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		getOrThrow(await fileSystem.writeFile(path, content, BACKGROUND_CONTEXT));
		return { path, content };
	}

	it("discovers legacy v3 session files without rewriting them", async () => {
		const { path, content } = await writeLegacyV3Fixture([], { parentSession: "/old-session.jsonl" });

		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const after = getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT));

		expect(metadata).toMatchObject({
			id: "legacy",
			createdAt: NOW,
			storageVersion: JSONL_STORAGE_VERSION,
			cwd: "/workspace",
			path,
			legacyParentSessionPath: "/old-session.jsonl",
		});
		expect(Number.isFinite(metadata?.modifiedAt)).toBe(true);
		expect(after).toBe(content);
	});

	it("opens an empty legacy session with an idle unconfigured main lane", async () => {
		await writeLegacyV3Fixture([]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		expect(await session.findEntries(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBeNull();
		expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
		expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("imports a custom entry without rewriting opaque data references", async () => {
		const messageTimestamp = NOW + 1_000;
		const customTimestamp = NOW + 2_000;
		const message = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: messageTimestamp,
		} satisfies AgentMessage;
		const data = {
			legacyReference: "message-1",
			nested: { legacyReference: "custom-1" },
		};
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(messageTimestamp).toISOString(),
				message,
			},
			{
				type: "custom",
				id: "custom-1",
				parentId: "message-1",
				timestamp: new Date(customTimestamp).toISOString(),
				customType: "checkpoint",
				data,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [messageEntry, customEntry] = entries;
		if (messageEntry === undefined || customEntry === undefined) {
			throw new Error("Legacy custom chain was not imported");
		}
		expect(messageEntry.seq).toBe(1);
		expect(customEntry).toMatchObject({
			type: "custom",
			parentId: messageEntry.id,
			seq: 2,
			timestamp: customTimestamp,
			customType: "checkpoint",
			data,
		});
		expect(customEntry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(uuidTimestamp(customEntry.id)).toBe(customTimestamp);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(customEntry.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("imports a custom message as a current message entry", async () => {
		const parentTimestamp = NOW + 1_000;
		const customMessageTimestamp = NOW + 2_000;
		const parentMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: parentTimestamp,
		} satisfies AgentMessage;
		const content = [{ type: "text", text: "legacy custom message" }];
		const details = { status: "complete" };
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(parentTimestamp).toISOString(),
				message: parentMessage,
			},
			{
				type: "custom_message",
				id: "custom-message-1",
				parentId: "message-1",
				timestamp: new Date(customMessageTimestamp).toISOString(),
				customType: "status",
				content,
				details,
				display: false,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [parentEntry, customMessageEntry] = entries;
		if (parentEntry === undefined || customMessageEntry === undefined) {
			throw new Error("Legacy custom message chain was not imported");
		}
		expect(parentEntry.seq).toBe(1);
		expect(customMessageEntry).toMatchObject({
			type: "message",
			parentId: parentEntry.id,
			seq: 2,
			timestamp: customMessageTimestamp,
			message: {
				role: "custom",
				customType: "status",
				content,
				details,
				display: false,
				timestamp: customMessageTimestamp,
			},
		});
		expect(customMessageEntry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(uuidTimestamp(customMessageEntry.id)).toBe(customMessageTimestamp);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(customMessageEntry.id);
		expect((await session.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	describe("importing branch summaries", () => {
		const branchPointTimestamp = NOW + 1_000;
		const abandonedResponseTimestamp = NOW + 2_000;
		const summaryTimestamp = NOW + 3_000;
		const details = { reason: "navigation" };
		const usage = {
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.23 },
		} satisfies Usage;
		const branchPointMessage = {
			role: "user",
			content: [{ type: "text", text: "Try the first approach" }],
			timestamp: branchPointTimestamp,
		} satisfies AgentMessage;
		const abandonedResponse = {
			role: "assistant",
			content: [{ type: "text", text: "Implemented the first approach" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 20,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			},
			stopReason: "stop",
			timestamp: abandonedResponseTimestamp,
		} satisfies AgentMessage;

		async function openFixture(fromHook?: true) {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "branch-point",
					parentId: null,
					timestamp: new Date(branchPointTimestamp).toISOString(),
					message: branchPointMessage,
				},
				{
					type: "message",
					id: "abandoned-response",
					parentId: "branch-point",
					timestamp: new Date(abandonedResponseTimestamp).toISOString(),
					message: abandonedResponse,
				},
				{
					type: "branch_summary",
					id: "summary",
					parentId: "branch-point",
					timestamp: new Date(summaryTimestamp).toISOString(),
					fromId: "branch-point",
					summary: "Summary of the abandoned branch",
					details,
					usage,
					...(fromHook === undefined ? {} : { fromHook }),
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(3);
			const [branchPoint, abandoned, branchSummary] = entries;
			if (branchPoint === undefined || abandoned === undefined || branchSummary === undefined) {
				throw new Error("Legacy branch summary chain was not imported");
			}
			return { session, branchPoint, abandoned, branchSummary };
		}

		it("preserves payload and remaps references", async () => {
			const { session, branchPoint, abandoned, branchSummary } = await openFixture();

			expect(abandoned.parentId).toBe(branchPoint.id);
			expect(branchSummary).toMatchObject({
				type: "branch_summary",
				parentId: branchPoint.id,
				seq: 3,
				timestamp: summaryTimestamp,
				fromId: branchPoint.id,
				summary: "Summary of the abandoned branch",
				details,
				usage,
				fromHook: false,
			});
			expect(branchSummary.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(branchSummary.id)).toBe(summaryTimestamp);
			expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(branchSummary.id);
			await session.close(BACKGROUND_CONTEXT);
		});

		it("preserves an explicit fromHook flag", async () => {
			const { session, branchSummary } = await openFixture(true);

			expect(branchSummary).toMatchObject({ type: "branch_summary", fromHook: true });
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	describe("importing compactions", () => {
		const excludedTimestamp = NOW + 1_000;
		const retainedTimestamp = NOW + 2_000;
		const compactionTimestamp = NOW + 3_000;
		const excludedMessage = {
			role: "user",
			content: [{ type: "text", text: "old context" }],
			timestamp: excludedTimestamp,
		} satisfies AgentMessage;
		const retainedMessage = {
			role: "user",
			content: [{ type: "text", text: "retain this context" }],
			timestamp: retainedTimestamp,
		} satisfies AgentMessage;
		const details = { strategy: "default" };
		const usage = {
			input: 120,
			output: 30,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: { input: 1.2, output: 0.3, cacheRead: 0.1, cacheWrite: 0.05, total: 1.65 },
		} satisfies Usage;

		async function openFixture(fromHook?: true) {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "excluded-message",
					parentId: null,
					timestamp: new Date(excludedTimestamp).toISOString(),
					message: excludedMessage,
				},
				{
					type: "message",
					id: "retained-message",
					parentId: "excluded-message",
					timestamp: new Date(retainedTimestamp).toISOString(),
					message: retainedMessage,
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "retained-message",
					timestamp: new Date(compactionTimestamp).toISOString(),
					summary: "Summary of the earlier context",
					firstKeptEntryId: "retained-message",
					tokensBefore: 12_000,
					details,
					usage,
					...(fromHook === undefined ? {} : { fromHook }),
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(3);
			const [excluded, retained, compaction] = entries;
			if (excluded === undefined || retained === undefined || compaction === undefined) {
				throw new Error("Legacy compaction chain was not imported");
			}
			return { session, excluded, retained, compaction };
		}

		it("materializes the retained tail and preserves the payload", async () => {
			const { session, excluded, retained, compaction } = await openFixture();

			expect(retained).toMatchObject({ parentId: excluded.id, seq: 2 });
			expect(compaction).toMatchObject({
				type: "compaction",
				parentId: retained.id,
				seq: 3,
				timestamp: compactionTimestamp,
				summary: "Summary of the earlier context",
				retainedTail: [retainedMessage],
				tokensBefore: 12_000,
				details,
				usage,
				fromHook: false,
			});
			expect(compaction).not.toHaveProperty("firstKeptEntryId");
			expect(compaction.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(compaction.id)).toBe(compactionTimestamp);
			expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(compaction.id);
			await session.close(BACKGROUND_CONTEXT);
		});

		it("preserves an explicit fromHook flag", async () => {
			const { session, compaction } = await openFixture(true);

			expect(compaction).toMatchObject({ type: "compaction", fromHook: true });
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("remaps a legacy message chain and exposes it through current APIs", async () => {
		const firstTimestamp = NOW + 1_000;
		const secondTimestamp = NOW + 2_000;
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: firstTimestamp,
		} satisfies AgentMessage;
		const secondMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: secondTimestamp,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(firstTimestamp).toISOString(),
				message: firstMessage,
			},
			{
				type: "message",
				id: "message-2",
				parentId: "message-1",
				timestamp: new Date(secondTimestamp).toISOString(),
				message: secondMessage,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [first, second] = entries;
		if (first === undefined || second === undefined) throw new Error("Legacy message chain was not imported");
		expect(first).toMatchObject({ parentId: null, seq: 1, timestamp: firstTimestamp, message: firstMessage });
		expect(second).toMatchObject({ parentId: first.id, seq: 2, timestamp: secondTimestamp, message: secondMessage });
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(second.id);
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([first.id, second.id]);
		expect((await session.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	describe("opening a legacy v3 message session", () => {
		const entryTimestamp = NOW + 1_234;
		const message = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		let session: Session<JsonlSessionMetadata>;
		let path: string;
		let content: string;
		let beforeMtime: number;

		beforeEach(async () => {
			({ path, content } = await writeLegacyV3Fixture([
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date(entryTimestamp).toISOString(),
					message,
				},
			]));
			beforeMtime = getOrThrow(await fileSystem.fileInfo(path, BACKGROUND_CONTEXT)).mtimeMs;
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");
			session = await repo.open(metadata, BACKGROUND_CONTEXT);
		});

		afterEach(async () => {
			await session?.close(BACKGROUND_CONTEXT);
		});

		async function importedEntry(): Promise<Entry> {
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(1);
			const [entry] = entries;
			if (entry === undefined) throw new Error("Legacy message was not imported");
			return entry;
		}

		it("exposes the legacy message through the current entry API", async () => {
			expect(await importedEntry()).toMatchObject({
				type: "message",
				parentId: null,
				seq: 1,
				timestamp: entryTimestamp,
				message,
			});
		});

		it("remints the entry id as a UUIDv7 with the legacy timestamp", async () => {
			const entry = await importedEntry();

			expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(entry.id)).toBe(entryTimestamp);
		});

		it("initializes an idle unconfigured main lane at the imported entry", async () => {
			const entry = await importedEntry();

			expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(entry.id);
			expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				pendingNextRun: [],
			});
			expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		});

		it("leaves the legacy source untouched after open and close", async () => {
			await session.close(BACKGROUND_CONTEXT);

			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
			expect(getOrThrow(await fileSystem.fileInfo(path, BACKGROUND_CONTEXT)).mtimeMs).toBe(beforeMtime);
		});
	});
});
