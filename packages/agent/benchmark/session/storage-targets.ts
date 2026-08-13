import { MemoryStorage } from "../../src/harness/session/memory.ts";
import type { StorageFixture } from "../../src/harness/session/testing/index.ts";

interface StorageBenchmarkTarget {
	readonly name: string;
	createFixture(): Promise<StorageFixture>;
}

const NOW = 1_700_000_000_000;

export const storageBenchmarkTargets = [
	{
		name: "memory",
		createFixture() {
			const storage = new MemoryStorage({ now: () => NOW });
			return Promise.resolve({
				storage,
				[Symbol.asyncDispose]: () => storage.close(),
			});
		},
	},
] satisfies readonly StorageBenchmarkTarget[];
