import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/harness/session/index.ts";
import { createStorageConformance, type StorageFixture } from "../../src/harness/session/testing/index.ts";

const NOW = 1_700_000_000_000;

const conformance = createStorageConformance(() => {
	const storage = new MemoryStorage({ now: () => NOW });
	return Promise.resolve<StorageFixture>({
		storage,
		[Symbol.asyncDispose]: () => storage.close(),
	});
});

describe("MemoryStorage conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("MemoryStorage", () => {
	it("uses the injected clock once per transaction", async () => {
		let timestamp = NOW;
		const storage = new MemoryStorage({ now: () => timestamp++ });

		const first = await storage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: "first",
						parentId: null,
						type: "custom",
						customType: "note",
					},
				},
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "first" },
			],
		});
		const second = await storage.commit({
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "second" }],
		});

		expect(first.timestamp).toBe(NOW);
		expect(second.timestamp).toBe(NOW + 1);
		expect((await storage.getEntries(["first"])).get("first")?.timestamp).toBe(first.timestamp);
		await storage.close();
	});
});
