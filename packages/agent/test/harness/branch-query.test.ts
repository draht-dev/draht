import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepository } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionBackend, InMemorySessionRepository } from "../../src/harness/session/memory-repo.ts";
import type { Session } from "../../src/harness/session/session.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

const ownedRepositories: AsyncDisposable[] = [];

afterEach(async () => {
	for (const repository of ownedRepositories.splice(0)) await repository[Symbol.asyncDispose]();
});

async function verifyBranchQueries(session: Session): Promise<{ tail: string; fullPath: string[] }> {
	const root = await session.appendMessage(createUserMessage("root"));
	const custom = await session.appendCustomEntry("note", { value: 1 });
	const child = await session.appendMessage(createAssistantMessage("child"));
	const compaction = await session.appendCompaction("summary", child, 100, undefined, undefined, undefined, [
		createAssistantMessage("child"),
	]);
	const recentCustom = await session.appendCustomEntry("note", { value: 2 });
	const tail = await session.appendMessage(createUserMessage("tail"));
	await session.moveTo(root);
	const sibling = await session.appendMessage(createUserMessage("sibling"));

	expect((await session.findEntriesOnBranch()).map((entry) => entry.id)).toEqual([sibling, root]);
	expect(await session.findEntriesOnBranch({ start: null })).toEqual([]);
	expect((await session.findEntriesOnBranch({ start: tail, order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
		root,
		custom,
		child,
		compaction,
		recentCustom,
		tail,
	]);
	expect(
		(await session.findEntriesOnBranch({ start: tail, stopAtType: "compaction" })).map((entry) => entry.id),
	).toEqual([tail, recentCustom, compaction]);
	expect(
		(await session.findEntriesOnBranch({ start: tail, stopAtType: "compaction", type: "message" })).map(
			(entry) => entry.id,
		),
	).toEqual([tail]);
	expect(
		(await session.findEntriesOnBranch({ start: tail, stopAtId: child, order: "oldestFirst" })).map(
			(entry) => entry.id,
		),
	).toEqual([root, custom, child]);
	expect((await session.findEntriesOnBranch({ start: tail, stopAtType: "custom" })).map((entry) => entry.id)).toEqual([
		tail,
		recentCustom,
	]);
	expect(
		(
			await session.findEntriesOnBranch({
				start: tail,
				stopAtType: "custom",
				order: "oldestFirst",
			})
		).map((entry) => entry.id),
	).toEqual([root, custom]);
	expect(
		(await session.findEntriesOnBranch({ start: tail, type: "message", order: "oldestFirst" })).map(
			(entry) => entry.id,
		),
	).toEqual([root, child, tail]);
	expect((await session.findEntriesOnBranch({ start: tail, customType: "note" })).map((entry) => entry.id)).toEqual([
		recentCustom,
		custom,
	]);
	expect((await session.findEntriesOnBranch({ start: tail, limit: 1 })).map((entry) => entry.id)).toEqual([tail]);
	expect(
		(
			await session.findEntriesOnBranch({
				start: tail,
				type: "message",
				order: "oldestFirst",
				limit: 1,
			})
		).map((entry) => entry.id),
	).toEqual([root]);
	expect(await session.findEntryOnBranch({ start: tail, type: "compaction" })).toMatchObject({ id: compaction });
	await expect(session.findEntriesOnBranch({ start: "missing" })).rejects.toMatchObject({ code: "not_found" });
	await expect(session.findEntriesOnBranch({ limit: 0 })).rejects.toThrow("limit must be a positive integer");
	return { tail, fullPath: [root, custom, child, compaction, recentCustom, tail] };
}

describe("bounded session branch queries", () => {
	it("provides identical in-memory query semantics", async () => {
		const repo = new InMemorySessionRepository();
		ownedRepositories.push(repo);
		const session = await repo.create({ id: "memory" });
		const expected = await verifyBranchQueries(session);
		const reopened = await repo.open(await session.getMetadata());
		expect(
			(await reopened.findEntriesOnBranch({ start: expected.tail, order: "oldestFirst" })).map((entry) => entry.id),
		).toEqual(expected.fullPath);
	});

	it("rejects corrupt parent chains in array-backed readers", async () => {
		const backend = new InMemorySessionBackend();
		ownedRepositories.push(backend);
		const storage = await backend.create({ id: "corrupt-memory" });
		await storage.appendEntry({
			type: "message",
			id: "orphan",
			parentId: "missing-parent",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("orphan"),
		});

		expect(
			(await storage.findEntriesOnBranch({ start: "orphan", stopAtId: "orphan" })).map((entry) => entry.id),
		).toEqual(["orphan"]);
		expect(
			(await storage.findEntriesOnBranch({ start: "orphan", stopAtType: "message" })).map((entry) => entry.id),
		).toEqual(["orphan"]);
		await expect(storage.findEntriesOnBranch({ start: "orphan" })).rejects.toMatchObject({
			code: "invalid_session",
			message: "Entry missing-parent not found",
		});
		await storage.appendEntry({
			type: "message",
			id: "cycle-a",
			parentId: "cycle-b",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: createUserMessage("a"),
		});
		await storage.appendEntry({
			type: "message",
			id: "cycle-b",
			parentId: "cycle-a",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: createUserMessage("b"),
		});
		await expect(storage.findEntriesOnBranch({ start: "cycle-b" })).rejects.toMatchObject({
			code: "invalid_session",
			message: "Session branch contains a cycle at cycle-b",
		});
	});

	it("provides identical JSONL query semantics", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepository({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		ownedRepositories.push(repo);
		const session = await repo.create({ id: "jsonl", cwd: root });
		const expected = await verifyBranchQueries(session);
		const reopened = await repo.open(await session.getMetadata());
		expect(
			(await reopened.findEntriesOnBranch({ start: expected.tail, order: "oldestFirst" })).map((entry) => entry.id),
		).toEqual(expected.fullPath);
	});
});
