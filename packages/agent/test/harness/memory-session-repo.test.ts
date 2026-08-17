import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
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
		const session = await repo.create({}, BACKGROUND_CONTEXT);

		expect(session.metadata.createdAt).toBe(NOW);
		expect(uuidTimestamp(session.metadata.id)).toBe(NOW);
		await Promise.all([session.close(BACKGROUND_CONTEXT), repo.close(BACKGROUND_CONTEXT)]);
	});

	it("returns a fresh facade after close while retaining one session and storage", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const first = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
		const firstView = first.view("main");
		const admittedWrite = first.setName("preserved", BACKGROUND_CONTEXT);

		await expect(repo.open(first.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
		await Promise.all([admittedWrite, first.close(BACKGROUND_CONTEXT)]);
		await expect(first.getName(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(firstView.getName(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");

		const second = await repo.open(first.metadata, BACKGROUND_CONTEXT);
		expect(second).not.toBe(first);
		expect(await second.getName(BACKGROUND_CONTEXT)).toBe("preserved");
		await second.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("captures fork options before waiting for its snapshot boundary", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
		const rootId = "00000000-0000-7000-8000-000000000001";
		const childId = "00000000-0000-7000-8000-000000000002";
		const commit = source.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						sessionWrites.insertEntry({ id: rootId, parentId: null, type: "custom", customType: "root" }),
						sessionWrites.insertEntry({ id: childId, parentId: rootId, type: "custom", customType: "child" }),
						storedValues.setValue(storedValues.laneLeaf("main"), childId),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const options = { id: "fork", entryId: childId, position: "before" as "before" | "at" };
		const fork = repo.fork(source.metadata, options, BACKGROUND_CONTEXT);
		options.entryId = rootId;
		options.position = "at";

		await commit;
		const forked = await fork;
		expect(await forked.getLeafId(BACKGROUND_CONTEXT)).toBe(rootId);
		await Promise.all([
			source.close(BACKGROUND_CONTEXT),
			forked.close(BACKGROUND_CONTEXT),
			repo.close(BACKGROUND_CONTEXT),
		]);
	});
});
