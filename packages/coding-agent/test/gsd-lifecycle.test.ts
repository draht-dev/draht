import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainModel } from "../src/gsd/domain.js";
import { createTempGitRepo } from "./test-utils/git-repo.js";

function buildPhase21WorkspaceFixture(repoPath: string): string {
	const planningDir = join(repoPath, ".planning");
	const phaseDir = join(planningDir, "phases", "21-full-lifecycle-integration-test");

	mkdirSync(phaseDir, { recursive: true });
	writeFileSync(
		join(planningDir, "PROJECT.md"),
		"# Project: Phase 21 Fixture\n\n## Vision\nExercise the full GSD lifecycle in an isolated repository.\n",
		"utf-8",
	);
	writeFileSync(
		join(planningDir, "ROADMAP.md"),
		"## Phase 21: Full Lifecycle Integration Test — `pending`\n",
		"utf-8",
	);
	writeFileSync(join(planningDir, "STATE.md"), "# State\n\n## Last Activity: 2026-03-12 19:30:28\n", "utf-8");

	return phaseDir;
}

describe("gsd lifecycle", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("boots a writable Phase 21 planning workspace in an isolated temp repo", () => {
		const repo = createTempGitRepo();
		cleanups.push(repo.cleanup);

		const phaseDir = buildPhase21WorkspaceFixture(repo.repoPath);
		const domainModelPath = createDomainModel(repo.repoPath);
		const markerPath = join(phaseDir, "fixture-marker.txt");

		writeFileSync(markerPath, "phase-21 fixture\n", "utf-8");

		expect(existsSync(domainModelPath)).toBe(true);
		expect(existsSync(markerPath)).toBe(true);
		expect(phaseDir).toContain("21-full-lifecycle-integration-test");
		expect(readFileSync(markerPath, "utf-8")).toBe("phase-21 fixture\n");
	});
});
