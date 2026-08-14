import { describe, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import {
	type ConformanceCase,
	createSessionRepoForkBehaviorConformance,
	createSessionRepoForkDestinationReservationConformance,
	createSessionRepoLifecycleConformance,
	createSessionRepoMessageConformance,
} from "../../src/harness/session/testing/index.ts";
import type { ForkOptions } from "../../src/harness/session/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;
const CONFORMANCE_CWD = "/workspace";

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

let jsonlRepo: JsonlSessionRepo;
async function createConformanceRepo() {
	const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
	jsonlRepo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => NOW });
	return {
		create: (options: { id?: string; parentSessionId?: string }) =>
			jsonlRepo.create({ ...options, cwd: CONFORMANCE_CWD }),
		open: (metadata: JsonlSessionMetadata) => jsonlRepo.open(metadata),
		list: () => jsonlRepo.list({ cwd: CONFORMANCE_CWD }),
		delete: (metadata: JsonlSessionMetadata) => jsonlRepo.delete(metadata),
		fork: (source: JsonlSessionMetadata, options: ForkOptions) => jsonlRepo.fork(source, options),
	};
}

registerConformance("JsonlSessionRepo conformance", [
	...createSessionRepoLifecycleConformance<JsonlSessionMetadata>(createConformanceRepo, () => jsonlRepo.close()),
	...createSessionRepoMessageConformance<JsonlSessionMetadata>(createConformanceRepo, () => jsonlRepo.close()),
	...createSessionRepoForkBehaviorConformance<JsonlSessionMetadata>(createConformanceRepo, () => jsonlRepo.close()),
	...createSessionRepoForkDestinationReservationConformance<JsonlSessionMetadata>(createConformanceRepo, () =>
		jsonlRepo.close(),
	),
]);
