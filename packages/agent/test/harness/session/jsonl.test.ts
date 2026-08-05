import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";
import { FileError } from "../../../src/harness/types.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-jsonl-v4-"));
	tempDirs.push(directory);
	return directory;
}

function createRepository(root: string): JsonlSessionRepo {
	return new JsonlSessionRepo({
		fs: new NodeExecutionEnv({ cwd: root }),
		sessionsRoot: root,
		cwd: root,
	});
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const conformance = createSessionBackendConformance(async () => {
	const repository = createRepository(createTempDir());
	return {
		repository,
		[Symbol.asyncDispose]: () => repository[Symbol.asyncDispose](),
	} satisfies SessionBackendFixture;
});

describe("JsonlSessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("JSONL v4 persistence", () => {
	it("exposes the complete metadata contract", async () => {
		const root = createTempDir();
		await using repository = createRepository(root);
		const session = await repository.create({
			id: "metadata",
			cwd: "/workspace/project",
			parentSessionId: "parent",
			metadata: { owner: "agent", nested: { enabled: true } },
		});
		const metadata = await session.getMetadata();

		expect(metadata).toEqual({
			id: "metadata",
			createdAt: expect.any(Number),
			parentSessionId: "parent",
			path: join(root, "session-metadata.jsonl"),
			cwd: "/workspace/project",
			modifiedAt: statSync(metadata.path).mtimeMs,
			sourceFormat: 4,
			metadata: { owner: "agent", nested: { enabled: true } },
		});
		expect(await repository.list({ cwd: "/workspace/project" })).toEqual([metadata]);
		expect(await repository.list({ cwd: "/other/project" })).toEqual([]);
	});

	it("sorts listed sessions by current filesystem modification time", async () => {
		const root = createTempDir();
		await using repository = createRepository(root);
		const newest = await repository.create({ id: "newest", cwd: root });
		const newestMetadata = await newest.getMetadata();
		const oldest = await repository.create({ id: "oldest", cwd: root });
		const oldestMetadata = await oldest.getMetadata();
		const newestTime = new Date(1_700_000_002_000);
		const oldestTime = new Date(1_700_000_001_000);
		utimesSync(newestMetadata.path, newestTime, newestTime);
		utimesSync(oldestMetadata.path, oldestTime, oldestTime);

		const listed = await repository.list();

		expect(listed.map((metadata) => metadata.id)).toEqual(["newest", "oldest"]);
		expect(listed.map((metadata) => metadata.modifiedAt)).toEqual([
			statSync(newestMetadata.path).mtimeMs,
			statSync(oldestMetadata.path).mtimeMs,
		]);
	});

	it("writes one line per mutation and restores the shared sequence", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		const entryId = await session.appendCustomEntry("note", { value: 1 });
		await session.createLane("thread", entryId);
		await session.appendRecord({
			type: "operation_started",
			id: "run",
			lane: "thread",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await session.setName("Example");
		await session.setLabel(entryId, "checkpoint");
		await session.moveLane("main", null);
		await repository[Symbol.asyncDispose]();

		const lines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => line.kind)).toEqual(["header", "entry", "lane", "record", "fact", "fact", "lane"]);
		expect(lines.slice(1).map((line) => line.seq)).toEqual([1, 2, 3, 4, 5, 6]);

		await using reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect(await reopened.getLanes()).toEqual([
			{ lane: "main", leafId: null },
			{ lane: "thread", leafId: entryId },
		]);
		expect(await reopened.getName()).toBe("Example");
		expect(await reopened.getLabel(entryId)).toBe("checkpoint");
		expect((await reopened.findRecords()).map((record) => record.id)).toEqual(["run"]);
		expect(
			(
				await reopened.findRecords({
					type: "operation_started",
					operationKind: "run",
				})
			).map((record) => record.id),
		).toEqual(["run"]);
		expect((await reopened.findOpenOperations("thread", { limit: 2 })).map((record) => record.id)).toEqual(["run"]);
		expect((await reopened.getLog()).map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			(
				await reopened.appendRecord({
					type: "operation_finished",
					id: "finish",
					lane: "thread",
					runId: "run",
					outcome: "completed",
				})
			).seq,
		).toBe(7);
		expect(await reopened.findOpenOperations("thread", { limit: 2 })).toEqual([]);
	});

	it("recomputes fork message counts when reopening", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 });
		await source.appendMessage({ role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 });
		const fork = await repository.fork(await source.getMetadata(), { id: "fork", cwd: root });
		const metadata = await fork.getMetadata();
		await repository[Symbol.asyncDispose]();

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.getStats()).messageCount).toBe(2);
		await reopened.appendMessage({ role: "user", content: [{ type: "text", text: "three" }], timestamp: 3 });
		expect((await reopened.getStats()).messageCount).toBe(3);
		await reopenedRepository[Symbol.asyncDispose]();

		await using verificationRepository = createRepository(root);
		const verified = await verificationRepository.open(metadata);
		expect((await verified.getStats()).messageCount).toBe(3);
	});

	it("reopens a tree fork with its lanes and facts", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		const rootId = await source.appendCustomEntry("root");
		await source.createLane("thread", rootId);
		const mainId = await source.appendCustomEntry("main");
		const threadEntry = await source.appendEntry({ type: "custom", id: "thread", customType: "thread" }, "thread");
		const threadId = threadEntry.id;
		await source.setName("Source");
		await source.setLabel(threadId, "tip");
		const fork = await repository.fork(await source.getMetadata(), { scope: "tree", id: "fork", cwd: root });
		const metadata = await fork.getMetadata();
		await repository[Symbol.asyncDispose]();

		const importedEntryLines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((line) => line.kind === "entry");
		expect(importedEntryLines.map((line) => "lane" in line)).toEqual([false, false, false]);

		await using reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
			rootId,
			mainId,
			threadId,
		]);
		expect(await reopened.getLanes()).toEqual([
			{ lane: "main", leafId: mainId },
			{ lane: "thread", leafId: threadId },
		]);
		expect(await reopened.getName()).toBe("Source");
		expect(await reopened.getLabel(threadId)).toBe("tip");
		expect(await reopened.findRecords()).toEqual([]);
	});

	it("repairs a valid final line missing its newline", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		const firstId = await session.appendCustomEntry("first");
		await repository[Symbol.asyncDispose]();
		const unterminated = readFileSync(metadata.path, "utf8").trimEnd();
		writeFileSync(metadata.path, unterminated);

		const reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect(readFileSync(metadata.path, "utf8")).toBe(`${unterminated}\n`);
		const secondId = await reopened.appendCustomEntry("second");
		await reopenedRepository[Symbol.asyncDispose]();

		await using verificationRepository = createRepository(root);
		const verified = await verificationRepository.open(metadata);
		expect((await verified.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
			firstId,
			secondId,
		]);
	});

	it("fails to open when repairing a missing final newline fails", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		await repository[Symbol.asyncDispose]();
		writeFileSync(metadata.path, readFileSync(metadata.path, "utf8").trimEnd());

		const env = new NodeExecutionEnv({ cwd: root });
		const failingFs = new Proxy(env, {
			get(target, property) {
				if (property === "appendFile") {
					return () =>
						Promise.resolve({
							ok: false as const,
							error: new FileError("permission_denied", "repair denied", metadata.path),
						});
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await using failingRepository = new JsonlSessionRepo({
			fs: failingFs,
			sessionsRoot: root,
			cwd: root,
		});

		await expect(failingRepository.open(metadata)).rejects.toMatchObject({
			code: "storage",
			cause: { code: "permission_denied" },
		});
	});

	it("truncates a malformed final line", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("note", { value: "kept" });
		await repository[Symbol.asyncDispose]();
		const validPrefix = readFileSync(metadata.path, "utf8");
		appendFileSync(metadata.path, '{"kind":"entry"');

		await using reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect((await reopened.findEntries()).map((entry) => entry.id)).toHaveLength(1);
		expect(readFileSync(metadata.path, "utf8")).toBe(validPrefix);
		const appendedId = await reopened.appendCustomEntry("after-recovery");
		expect((await reopened.getEntry(appendedId))?.seq).toBe(2);
	});

	it("rejects a malformed middle line", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		await session.appendCustomEntry("second");
		await repository[Symbol.asyncDispose]();
		const lines = readFileSync(metadata.path, "utf8").trimEnd().split("\n");
		writeFileSync(metadata.path, `${lines[0]}\n${lines[1]}\nnot-json\n${lines[2]}\n`);

		await using reopenedRepository = createRepository(root);
		await expect(reopenedRepository.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("rejects a lane-bound entry that does not chain to the lane leaf", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const session = await repository.create({ id: "session", cwd: root });
		const metadata = await session.getMetadata();
		await session.appendCustomEntry("first");
		await session.appendCustomEntry("second");
		await repository[Symbol.asyncDispose]();

		const lines = readFileSync(metadata.path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		lines[2].parentId = null;
		writeFileSync(metadata.path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		await using reopenedRepository = createRepository(root);
		await expect(reopenedRepository.open(metadata)).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining("does not chain to the lane leaf"),
		});
	});

	it("does not move a lane for an imported entry without lane metadata", async () => {
		const root = createTempDir();
		const path = join(root, "session-import.jsonl");
		const header = { kind: "header", version: 4, id: "import", createdAt: 1, cwd: root };
		const importedEntry = {
			kind: "entry",
			type: "custom",
			id: "imported",
			customType: "note",
			parentId: null,
			seq: 1,
			timestamp: 1,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(importedEntry)}\n`);
		const metadata = {
			id: header.id,
			createdAt: header.createdAt,
			path,
			cwd: root,
			modifiedAt: statSync(path).mtimeMs,
			sourceFormat: 4 as const,
		};

		const importedRepository = createRepository(root);
		const imported = await importedRepository.open(metadata);
		expect(await imported.getLeafId()).toBeNull();
		expect((await imported.findEntries()).map((entry) => entry.id)).toEqual(["imported"]);
		await importedRepository[Symbol.asyncDispose]();

		appendFileSync(path, `${JSON.stringify({ kind: "lane", seq: 2, lane: "main", leafId: "imported" })}\n`);
		await using movedRepository = createRepository(root);
		const moved = await movedRepository.open(metadata);
		expect(await moved.getLeafId()).toBe("imported");
	});
});
