import {
	SESSION_REPO_CATALOG_BENCHMARK_DATASETS,
	SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS,
	seedSessionRepoCatalogBenchmark,
} from "../../src/harness/session/testing/index.ts";
import { registerReadBenchmarks } from "./benchmark.ts";
import { sessionRepoBenchmarkTargets } from "./session-repo-targets.ts";

await registerReadBenchmarks({
	datasets: SESSION_REPO_CATALOG_BENCHMARK_DATASETS,
	targets: sessionRepoBenchmarkTargets,
	scenarios: SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS,
	async prepare(fixture, dataset) {
		await seedSessionRepoCatalogBenchmark(fixture.repo, dataset);
	},
	getSubject(fixture) {
		return fixture.repo;
	},
});
