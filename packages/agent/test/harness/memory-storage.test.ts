import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/harness/session/memory.ts";

const NOW = 1_700_000_000_000;

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
