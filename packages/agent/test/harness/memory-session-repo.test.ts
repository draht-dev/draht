import { describe, expect, it } from "vitest";
import { MemorySessionRepo } from "../../src/harness/session/index.ts";
import { createSessionRepoConformance, type SessionRepoFixture } from "../../src/harness/session/testing/index.ts";

const NOW = 1_700_000_000_000;
const STORAGE_VERSION = 1;

const conformance = createSessionRepoConformance(() => {
	const repo = new MemorySessionRepo({ now: () => NOW });
	return Promise.resolve<SessionRepoFixture>({
		repo,
		storageVersion: STORAGE_VERSION,
		[Symbol.asyncDispose]: () => repo.close(),
	});
});

describe("MemorySessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

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

	it("captures fork options before waiting for its snapshot boundary", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const source = await repo.create({ id: "source" });
		const rootId = "00000000-0000-7000-8000-000000000001";
		const childId = "00000000-0000-7000-8000-000000000002";
		const commit = source.commit({
			writes: [
				{ kind: "entry", entry: { id: rootId, parentId: null, type: "custom", customType: "root" } },
				{ kind: "entry", entry: { id: childId, parentId: rootId, type: "custom", customType: "child" } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: childId },
			],
		});
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
