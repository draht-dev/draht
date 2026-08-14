import { strictEqual } from "node:assert/strict";
import { bench, describe } from "vitest";
import {
	SESSION_REPO_CATALOG_BENCHMARK_DATASETS,
	SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS,
	seedSessionRepoCatalogBenchmark,
} from "../../src/harness/session/testing/index.ts";
import { type SessionRepoBenchmarkFixture, sessionRepoBenchmarkTargets } from "./session-repo-targets.ts";

const BENCHMARK_TIME_MS = 500;
const BENCHMARK_WARMUP_TIME_MS = 100;

interface PreparedCatalogFixture {
	readonly datasetName: string;
	readonly targetName: string;
	readonly fixture: SessionRepoBenchmarkFixture;
}

let benchmarkSink = 0;
const allFixtures: SessionRepoBenchmarkFixture[] = [];
const catalogFixtures: PreparedCatalogFixture[] = [];

process.once("beforeExit", () => {
	void Promise.all(allFixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
});

// Vitest 4's benchmark runner does not execute normal test lifecycle hooks.
// Prepare one immutable catalog per backend/dataset before registration.
for (const dataset of SESSION_REPO_CATALOG_BENCHMARK_DATASETS) {
	for (const target of sessionRepoBenchmarkTargets) {
		const fixture = await target.createFixture();
		allFixtures.push(fixture);
		await seedSessionRepoCatalogBenchmark(fixture.repo, dataset);
		for (const scenario of SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS) {
			strictEqual(await scenario.run(fixture.repo), scenario.expectedResult(dataset));
		}
		catalogFixtures.push({ datasetName: dataset.name, targetName: target.name, fixture });
	}
}

for (const dataset of SESSION_REPO_CATALOG_BENCHMARK_DATASETS) {
	for (const scenario of SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS) {
		describe(`${scenario.name} (${dataset.name})`, () => {
			for (const target of sessionRepoBenchmarkTargets) {
				const prepared = catalogFixtures.find(
					(candidate) => candidate.datasetName === dataset.name && candidate.targetName === target.name,
				);
				if (prepared === undefined) throw new Error("Benchmark fixture was not initialized");

				bench(
					target.name,
					async () => {
						benchmarkSink = await scenario.run(prepared.fixture.repo);
					},
					{
						time: BENCHMARK_TIME_MS,
						iterations: 10,
						warmupTime: BENCHMARK_WARMUP_TIME_MS,
						warmupIterations: 5,
					},
				);
			}
		});
	}
}

void benchmarkSink;
