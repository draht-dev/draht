import { strictEqual } from "node:assert/strict";
import { bench, describe } from "vitest";
import {
	STORAGE_BENCHMARK_DATASETS,
	STORAGE_READ_BENCHMARK_SCENARIOS,
	STORAGE_WRITE_BENCHMARK_SCENARIOS,
	seedStorageBenchmark,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

const BENCHMARK_TIME_MS = 500;
const BENCHMARK_WARMUP_TIME_MS = 100;
const WRITE_ITERATIONS = 30;
const WRITE_WARMUP_ITERATIONS = 5;

interface PreparedReadFixture {
	readonly datasetName: string;
	readonly targetName: string;
	readonly fixture: StorageFixture;
}

interface PreparedWriteFixtures {
	readonly scenarioName: string;
	readonly targetName: string;
	readonly pendingFixtures: StorageFixture[];
}

let benchmarkSink = 0;
const allFixtures: StorageFixture[] = [];
const readFixtures: PreparedReadFixture[] = [];
const writeFixtures: PreparedWriteFixtures[] = [];

process.once("beforeExit", () => {
	void Promise.all(allFixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
});

// Vitest 4's benchmark runner does not execute normal test lifecycle hooks.
// Prepare read fixtures and one write fixture per warmup/measured iteration
// before registration. Vitest 5 can express the same lifecycle with each
// registration's beforeAll/beforeEach/afterEach/afterAll hooks.
for (const dataset of STORAGE_BENCHMARK_DATASETS) {
	for (const target of storageBenchmarkTargets) {
		const fixture = await target.createFixture();
		allFixtures.push(fixture);
		await seedStorageBenchmark(fixture.storage, dataset);
		for (const scenario of STORAGE_READ_BENCHMARK_SCENARIOS) {
			strictEqual(await scenario.run(fixture.storage, dataset), scenario.expectedResult(dataset));
		}
		readFixtures.push({ datasetName: dataset.name, targetName: target.name, fixture });
	}
}

for (const scenario of STORAGE_WRITE_BENCHMARK_SCENARIOS) {
	for (const target of storageBenchmarkTargets) {
		const validationFixture = await target.createFixture();
		allFixtures.push(validationFixture);
		await scenario.prepare?.(validationFixture.storage);
		strictEqual(await scenario.run(validationFixture.storage), scenario.writeCount);

		const pendingFixtures: StorageFixture[] = [];
		for (let index = 0; index < WRITE_WARMUP_ITERATIONS + WRITE_ITERATIONS; index++) {
			const fixture = await target.createFixture();
			allFixtures.push(fixture);
			await scenario.prepare?.(fixture.storage);
			pendingFixtures.push(fixture);
		}
		writeFixtures.push({ scenarioName: scenario.name, targetName: target.name, pendingFixtures });
	}
}

for (const dataset of STORAGE_BENCHMARK_DATASETS) {
	for (const scenario of STORAGE_READ_BENCHMARK_SCENARIOS) {
		describe(`${scenario.name} (${dataset.name})`, () => {
			for (const target of storageBenchmarkTargets) {
				const prepared = readFixtures.find(
					(candidate) => candidate.datasetName === dataset.name && candidate.targetName === target.name,
				);
				if (prepared === undefined) throw new Error("Benchmark fixture was not initialized");

				bench(
					target.name,
					async () => {
						benchmarkSink = await scenario.run(prepared.fixture.storage, dataset);
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

for (const scenario of STORAGE_WRITE_BENCHMARK_SCENARIOS) {
	describe(scenario.name, () => {
		for (const target of storageBenchmarkTargets) {
			const prepared = writeFixtures.find(
				(candidate) => candidate.scenarioName === scenario.name && candidate.targetName === target.name,
			);
			if (prepared === undefined) throw new Error("Benchmark fixtures were not initialized");

			bench(
				target.name,
				async () => {
					const fixture = prepared.pendingFixtures.shift();
					if (fixture === undefined) throw new Error("Benchmark fixture pool was exhausted");
					benchmarkSink = await scenario.run(fixture.storage);
				},
				{
					time: 0,
					iterations: WRITE_ITERATIONS,
					warmupTime: 0,
					warmupIterations: WRITE_WARMUP_ITERATIONS,
				},
			);
		}
	});
}

void benchmarkSink;
