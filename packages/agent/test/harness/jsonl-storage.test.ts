import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage, type JsonlStorageHeader } from "../../src/harness/session/jsonl/index.ts";
import type { StorageStateSnapshot } from "../../src/harness/session/storage-state.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

function header(id: string): JsonlStorageHeader {
	return {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		id,
		storageVersion: 1,
		createdAt: NOW,
		cwd: "/workspace",
	};
}

function preparedSnapshot(): Pick<StorageStateSnapshot, "entries" | "registers"> {
	return {
		entries: new Map([
			[
				"root",
				{
					id: "root",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 1 },
					seq: 1,
					timestamp: NOW,
				},
			],
		]),
		registers: [
			{ namespace: "lane.leaf", key: "main", value: "root", seq: 2 },
			{ namespace: "lane.state", key: "main", value: { currentOperationId: null, pendingNextRun: [] }, seq: 3 },
			{ namespace: "fact.name", key: "", value: "forked", seq: 4 },
		],
	};
}

describe("JsonlStorage snapshot creation", () => {
	it("atomically publishes and opens a prepared snapshot", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "fork.jsonl", now: () => NOW };
		const storage = await JsonlStorage.createFromSnapshot(options, header("fork"), preparedSnapshot());

		const lines = getOrThrow(await fileSystem.readTextFile("fork.jsonl"))
			.trimEnd()
			.split("\n");
		expect(lines.slice(1).every((line) => !Array.isArray(JSON.parse(line)))).toBe(true);
		expect((await storage.getEntries(["root"])).get("root")?.timestamp).toBe(NOW);
		expect((await storage.getRegister("lane.leaf", "main"))?.value).toBe("root");
		expect((await storage.getRegister("lane.state", "main"))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
		expect((await storage.getRegister("fact.name", ""))?.value).toBe("forked");
		expect(await storage.getStats()).toEqual({
			messageCount: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(await storage.scanUsage({ order: "asc" })).toEqual([]);
		expect((await storage.commit({ writes: [] })).firstSeq).toBe(5);
		expect(getOrThrow(await fileSystem.exists("fork.jsonl.tmp"))).toBe(false);
		await storage.close();

		const reopened = await JsonlStorage.open(options);
		expect((await reopened.getEntries(["root"])).has("root")).toBe(true);
		expect((await reopened.getRegister("fact.name", ""))?.value).toBe("forked");
		await reopened.close();
	});

	it("removes the temporary file when publication fails", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await fileSystem.createDir("blocked.jsonl"));

		await expect(
			JsonlStorage.createFromSnapshot(
				{ fileSystem, path: "blocked.jsonl", now: () => NOW },
				header("blocked"),
				preparedSnapshot(),
			),
		).rejects.toThrow("Failed to publish JSONL storage");
		expect(getOrThrow(await fileSystem.exists("blocked.jsonl.tmp"))).toBe(false);
		expect(getOrThrow(await fileSystem.fileInfo("blocked.jsonl"))).toMatchObject({ kind: "directory" });
	});
});

describe("JsonlStorage persistence", () => {
	it("writes one line per transaction and replays stamped state", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		const storage = await JsonlStorage.create(options, header("round-trip"));
		const committed = await storage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: "root",
						parentId: null,
						type: "message",
						message: { role: "user", content: "hello", timestamp: 1 },
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "root" },
				{
					kind: "usage",
					row: {
						id: "usage",
						entryId: "root",
						adjustment: false,
						usage: {
							input: 1,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 3,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
			],
		});
		await storage.commit({
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "name" }],
		});

		const lines = getOrThrow(await fileSystem.readTextFile("session.jsonl"))
			.trimEnd()
			.split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(header("round-trip"));
		expect(JSON.parse(lines[1]!)).toHaveLength(3);
		expect(Array.isArray(JSON.parse(lines[2]!))).toBe(false);
		await storage.close();

		const reopened = await JsonlStorage.open(options);
		expect((await reopened.getEntries(["root"])).get("root")).toEqual({
			id: "root",
			parentId: null,
			type: "message",
			message: { role: "user", content: "hello", timestamp: 1 },
			seq: committed.seqs[0],
			timestamp: committed.timestamp,
		});
		expect(await reopened.getRegister("lane.leaf", "main")).toEqual({
			namespace: "lane.leaf",
			key: "main",
			value: "root",
			seq: committed.seqs[1],
		});
		expect((await reopened.scanUsage({ order: "asc" })).map(({ id, seq }) => ({ id, seq }))).toEqual([
			{ id: "usage", seq: committed.seqs[2] },
		]);
		expect(await reopened.getStats()).toEqual({
			messageCount: 1,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const next = await reopened.commit({ writes: [] });
		expect(next.firstSeq).toBe(5);
		await reopened.close();
	});
});

describe("JsonlStorage snapshots", () => {
	it("captures one serialized boundary between commits", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		const storage = await JsonlStorage.create(options, header("snapshot"));

		const firstCommit = storage.commit({
			writes: [
				{ kind: "entry", entry: { id: "root", parentId: null, type: "custom", customType: "root" } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "root" },
			],
		});
		const snapshot = storage.snapshot();
		const secondCommit = storage.commit({
			writes: [
				{ kind: "entry", entry: { id: "child", parentId: "root", type: "custom", customType: "child" } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "child" },
			],
		});

		await firstCommit;
		const captured = await snapshot;
		await secondCommit;

		expect(captured.entries.map(({ id }) => id)).toEqual(["root"]);
		expect(captured.registers.find(({ namespace, key }) => namespace === "lane.leaf" && key === "main")?.value).toBe(
			"root",
		);
		expect((await storage.getEntries(["child"])).has("child")).toBe(true);
		expect((await storage.getRegister("lane.leaf", "main"))?.value).toBe("child");
		await storage.close();
	});
});

describe("JsonlStorage torn tail", () => {
	function entryWrite(id: string) {
		return {
			kind: "entry" as const,
			entry: {
				id,
				parentId: null,
				type: "message" as const,
				message: { role: "user" as const, content: id, timestamp: 1 },
			},
		};
	}

	async function seed() {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl" as const, now: () => NOW };
		const storage = await JsonlStorage.create(options, header("torn"));
		await storage.commit({ writes: [entryWrite("kept")] });
		await storage.close();
		const prefix = getOrThrow(await fileSystem.readTextFile("session.jsonl"));
		return { fileSystem, options, prefix };
	}

	it("discards an unterminated final object line and truncates before admitting writes", async () => {
		const { fileSystem, options, prefix } = await seed();
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify({
				kind: "entry",
				id: "torn",
				parentId: null,
				type: "message",
				message: { role: "user", content: "torn", timestamp: 1 },
				seq: 2,
				timestamp: NOW,
			}),
		);

		const reopened = await JsonlStorage.open(options);
		expect((await reopened.getEntries(["kept", "torn"])).has("torn")).toBe(false);
		expect((await reopened.getEntries(["kept"])).get("kept")?.id).toBe("kept");
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl"))).toBe(prefix);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp"))).toBe(false);

		const next = await reopened.commit({ writes: [entryWrite("after")] });
		expect(next.firstSeq).toBe(2);
		expect((await reopened.getEntries(["after"])).get("after")?.seq).toBe(2);
		await reopened.close();
	});

	it("discards a torn array line wholly", async () => {
		const { fileSystem, options, prefix } = await seed();
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify([
				{
					kind: "entry",
					id: "torn-a",
					parentId: null,
					type: "message",
					message: { role: "user", content: "torn-a", timestamp: 1 },
					seq: 2,
					timestamp: NOW,
				},
				{ kind: "register", op: "set", seq: 3, namespace: "fact.name", key: "", value: "lost" },
			]),
		);

		const reopened = await JsonlStorage.open(options);
		expect((await reopened.getEntries(["torn-a"])).has("torn-a")).toBe(false);
		expect(await reopened.getRegister("fact.name", "")).toBeUndefined();
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl"))).toBe(prefix);
		await reopened.close();
	});

	it("rejects a malformed interior line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n${JSON.stringify({
			kind: "register",
			op: "set",
			seq: 2,
			namespace: "fact.name",
			key: "",
			value: "after",
		})}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted);

		await expect(JsonlStorage.open(options)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl"))).toBe(corrupted);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp"))).toBe(false);
	});

	it("rejects a complete malformed final line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n`;
		await fileSystem.writeFile("session.jsonl", corrupted);

		await expect(JsonlStorage.open(options)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl"))).toBe(corrupted);
	});

	it("rejects a complete final line with invalid transaction framing", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}${JSON.stringify({ kind: "nope", seq: 2 })}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted);

		await expect(JsonlStorage.open(options)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl"))).toBe(corrupted);
	});

	it("rejects an unterminated header", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		await fileSystem.writeFile("session.jsonl", JSON.stringify(header("torn")).slice(0, -4));

		await expect(JsonlStorage.open(options)).rejects.toThrow(/missing header/);
	});
});
