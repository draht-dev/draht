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
