import type { SessionMetadata, SessionRepo } from "../../types.ts";

export interface SessionRepoCatalogBenchmarkDataset {
	readonly name: string;
	readonly sessionCount: number;
}

interface SessionRepoCatalogReadBenchmarkScenario {
	readonly name: string;
	expectedResult(dataset: SessionRepoCatalogBenchmarkDataset): number;
	run(repo: SessionRepo): Promise<number>;
}

/** Package-internal deterministic session id shared by repository benchmark workloads. */
export function sessionRepoBenchmarkSessionId(index: number): string {
	return `benchmark-session-${index.toString().padStart(8, "0")}`;
}

function createCatalogDataset(scale: string, sessionCount: number): SessionRepoCatalogBenchmarkDataset {
	return {
		name: `synthetic catalog: ${scale} closed sessions`,
		sessionCount,
	};
}

/** Deterministic closed-session catalogs shared by repository measurements. */
export const SESSION_REPO_CATALOG_BENCHMARK_DATASETS: readonly SessionRepoCatalogBenchmarkDataset[] = [
	createCatalogDataset("100", 100),
	createCatalogDataset("1k", 1_000),
	createCatalogDataset("10k", 10_000),
];

/** Seeds one deterministic catalog and returns its durable metadata in creation order. */
export async function seedSessionRepoCatalogBenchmark(
	repo: SessionRepo,
	dataset: SessionRepoCatalogBenchmarkDataset,
): Promise<SessionMetadata[]> {
	const metadata: SessionMetadata[] = [];
	for (let index = 0; index < dataset.sessionCount; index++) {
		const session = await repo.create({ id: sessionRepoBenchmarkSessionId(index) });
		metadata.push(session.metadata);
		await session.close();
	}
	return metadata;
}

/** Shared catalog reads. Returning a number ensures each result is consumed. */
export const SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS: readonly SessionRepoCatalogReadBenchmarkScenario[] = [
	{
		name: "list sessions",
		expectedResult(dataset) {
			return dataset.sessionCount;
		},
		async run(repo) {
			return (await repo.list()).length;
		},
	},
];
