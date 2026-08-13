import { describe, it } from "vitest";
import { MemorySessionRepo } from "../../src/harness/session/index.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import {
	type ConformanceCase,
	createSessionRepoConformance,
	createStorageConformance,
	type SessionRepoFixture,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";

const NOW = 1_700_000_000_000;
const STORAGE_VERSION = 1;

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
	"MemoryStorage conformance",
	createStorageConformance(() => {
		const storage = new MemoryStorage({ now: () => NOW });
		return Promise.resolve<StorageFixture>({
			storage,
			[Symbol.asyncDispose]: () => storage.close(),
		});
	}),
);

registerConformance(
	"MemorySessionRepo conformance",
	createSessionRepoConformance(() => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		return Promise.resolve<SessionRepoFixture>({
			repo,
			storageVersion: STORAGE_VERSION,
			[Symbol.asyncDispose]: () => repo.close(),
		});
	}),
);
