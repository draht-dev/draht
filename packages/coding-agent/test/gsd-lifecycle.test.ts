import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainModel } from "../src/gsd/domain.js";
import { createTempGitRepo } from "./test-utils/git-repo.js";

function buildPhase21WorkspaceFixture(_repoPath: string): string {
	throw new Error("not implemented");
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
