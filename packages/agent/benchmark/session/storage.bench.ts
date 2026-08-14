import { strictEqual } from "node:assert/strict";
import { bench, describe } from "vitest";
import {
	STORAGE_BENCHMARK_DATASETS,
	STORAGE_READ_BENCHMARK_SCENARIOS,
	STORAGE_WRITE_BENCHMARK_SCENARIOS,
	seedStorageBenchmark,
	type StorageFixture,
} from "../../src/harness/session/testing/index.ts";
import {
	registerReadBenchmarks,
	WRITE_BENCHMARK_ITERATIONS,
	WRITE_BENCHMARK_OPTIONS,
	WRITE_BENCHMARK_WARMUP_ITERATIONS,
} from "./benchmark.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

interface PreparedWriteFixtures {
	readonly scenarioName: string;
	readonly targetName: string;
	readonly pendingFixtures: StorageFixture[];
}

const allFixtures: StorageFixture[] = [];
const writeFixtures: PreparedWriteFixtures[] = [];

process.once("beforeExit", async () => {
	await Promise.all(allFixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
});

await registerReadBenchmarks({
	datasets: STORAGE_BENCHMARK_DATASETS,
	targets: storageBenchmarkTargets,
	scenarios: STORAGE_READ_BENCHMARK_SCENARIOS,
	prepare(fixture, dataset) {
		return seedStorageBenchmark(fixture.storage, dataset);
	},
	getSubject(fixture) {
		return fixture.storage;
	},
});

// Vitest 4's benchmark runner does not execute normal test lifecycle hooks.
// Prepare one write fixture per warmup/measured iteration before registration.
// Vitest 5 can express the same lifecycle with each registration's hooks.
for (const scenario of STORAGE_WRITE_BENCHMARK_SCENARIOS) {
	for (const target of storageBenchmarkTargets) {
		const validationFixture = await target.createFixture();
		allFixtures.push(validationFixture);
		await scenario.prepare?.(validationFixture.storage);
		strictEqual(await scenario.run(validationFixture.storage), scenario.writeCount);

		const pendingFixtures: StorageFixture[] = [];
		for (
			let index = 0;
			index < WRITE_BENCHMARK_WARMUP_ITERATIONS + WRITE_BENCHMARK_ITERATIONS;
			index++
		) {
			const fixture = await target.createFixture();
			allFixtures.push(fixture);
			await scenario.prepare?.(fixture.storage);
			pendingFixtures.push(fixture);
		}
		writeFixtures.push({ scenarioName: scenario.name, targetName: target.name, pendingFixtures });
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
					await scenario.run(fixture.storage);
				},
				WRITE_BENCHMARK_OPTIONS,
			);
		}
	});
}
