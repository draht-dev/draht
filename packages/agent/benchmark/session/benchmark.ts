import { strictEqual } from "node:assert/strict";
import { bench, describe } from "vitest";

export interface BenchmarkTarget<TFixture extends AsyncDisposable> {
	readonly name: string;
	createFixture(): Promise<TFixture>;
}

const READ_BENCHMARK_OPTIONS = {
	time: 500,
	iterations: 10,
	warmupTime: 100,
	warmupIterations: 5,
} as const;

export const WRITE_BENCHMARK_ITERATIONS = 30;
export const WRITE_BENCHMARK_WARMUP_ITERATIONS = 5;

export const WRITE_BENCHMARK_OPTIONS = {
	time: 0,
	iterations: WRITE_BENCHMARK_ITERATIONS,
	warmupTime: 0,
	warmupIterations: WRITE_BENCHMARK_WARMUP_ITERATIONS,
} as const;

interface NamedBenchmarkDataset {
	readonly name: string;
}

interface ReadBenchmarkScenario<TSubject, TDataset> {
	readonly name: string;
	expectedResult(dataset: TDataset): number;
	run(subject: TSubject, dataset: TDataset): Promise<number>;
}

interface RegisterReadBenchmarksOptions<
	TDataset extends NamedBenchmarkDataset,
	TFixture extends AsyncDisposable,
	TSubject,
> {
	readonly datasets: readonly TDataset[];
	readonly targets: readonly BenchmarkTarget<TFixture>[];
	readonly scenarios: readonly ReadBenchmarkScenario<TSubject, TDataset>[];
	prepare(fixture: TFixture, dataset: TDataset): Promise<void>;
	getSubject(fixture: TFixture): TSubject;
}

interface PreparedReadFixture<TFixture> {
	readonly datasetName: string;
	readonly targetName: string;
	readonly fixture: TFixture;
}

/** Prepares, validates, registers, and disposes one immutable fixture per target and dataset. */
export async function registerReadBenchmarks<
	TDataset extends NamedBenchmarkDataset,
	TFixture extends AsyncDisposable,
	TSubject,
>(options: RegisterReadBenchmarksOptions<TDataset, TFixture, TSubject>): Promise<void> {
	const fixtures: TFixture[] = [];
	const preparedFixtures: PreparedReadFixture<TFixture>[] = [];

	process.once("beforeExit", async () => {
		await Promise.all(fixtures.map((fixture) => fixture[Symbol.asyncDispose]()));
	});

	for (const dataset of options.datasets) {
		for (const target of options.targets) {
			const fixture = await target.createFixture();
			fixtures.push(fixture);
			await options.prepare(fixture, dataset);
			const subject = options.getSubject(fixture);
			for (const scenario of options.scenarios) {
				strictEqual(await scenario.run(subject, dataset), scenario.expectedResult(dataset));
			}
			preparedFixtures.push({ datasetName: dataset.name, targetName: target.name, fixture });
		}
	}

	for (const dataset of options.datasets) {
		for (const scenario of options.scenarios) {
			describe(`${scenario.name} (${dataset.name})`, () => {
				for (const target of options.targets) {
					const prepared = preparedFixtures.find(
						(candidate) => candidate.datasetName === dataset.name && candidate.targetName === target.name,
					);
					if (prepared === undefined) throw new Error("Benchmark fixture was not initialized");
					const subject = options.getSubject(prepared.fixture);

					bench(
						target.name,
						async () => {
							await scenario.run(subject, dataset);
						},
						READ_BENCHMARK_OPTIONS,
					);
				}
			});
		}
	}
}
