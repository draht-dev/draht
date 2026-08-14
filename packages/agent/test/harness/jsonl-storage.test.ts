import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage, type JsonlStorageHeader } from "../../src/harness/session/jsonl/index.ts";
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
