import { describe, expect, it } from "vitest";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemorySessionRepo } from "../../src/harness/session/index.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;
function uuidTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

describe("MemorySessionRepo metadata", () => {
	it("uses its injected clock for generated session identity and metadata", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const session = await repo.create({});

		expect(session.metadata.createdAt).toBe(NOW);
		expect(uuidTimestamp(session.metadata.id)).toBe(NOW);
		await Promise.all([session.close(), repo.close()]);
	});

	it("returns a fresh facade after close while retaining one session and storage", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const first = await repo.create({ id: "session" });
		const firstView = first.view("main");
		const admittedWrite = first.setName("preserved");

		await expect(repo.open(first.metadata)).rejects.toThrow("already open");
		await Promise.all([admittedWrite, first.close()]);
		await expect(first.getName()).rejects.toThrow("Session is closed");
		await expect(firstView.getName()).rejects.toThrow("Session is closed");

		const second = await repo.open(first.metadata);
		expect(second).not.toBe(first);
		expect(await second.getName()).toBe("preserved");
		await second.close();
		await repo.close();
	});

	it("captures fork options before waiting for its snapshot boundary", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const source = await repo.create({ id: "source" });
		const rootId = "00000000-0000-7000-8000-000000000001";
		const childId = "00000000-0000-7000-8000-000000000002";
		const commit = source.mutate("main", (mutator) =>
			mutator.commit([
				sessionWrites.insertEntry({ id: rootId, parentId: null, type: "custom", customType: "root" }),
				sessionWrites.insertEntry({ id: childId, parentId: rootId, type: "custom", customType: "child" }),
				storedValues.setValue(storedValues.laneLeaf("main"), childId),
			]),
		);
		const options = { id: "fork", entryId: childId, position: "before" as "before" | "at" };
		const fork = repo.fork(source.metadata, options);
		options.entryId = rootId;
		options.position = "at";

		await commit;
		const forked = await fork;
		expect(await forked.getLeafId()).toBe(rootId);
		await Promise.all([source.close(), forked.close(), repo.close()]);
	});
});
