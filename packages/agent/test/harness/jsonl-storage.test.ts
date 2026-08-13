import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage, type JsonlStorageHeader } from "../../src/harness/session/jsonl.ts";
import {
	type ConformanceCase,
	createStorageConformance,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";
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

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describe(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

registerConformance(
	"JsonlStorage conformance",
	createStorageConformance(async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const storage = await JsonlStorage.create(
			{ fileSystem, path: "session.jsonl", now: () => NOW },
			header("session"),
		);
		return {
			storage,
			[Symbol.asyncDispose]: () => storage.close(),
		} satisfies StorageFixture;
	}),
);

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
