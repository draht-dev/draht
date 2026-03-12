import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainModel } from "../src/gsd/domain.js";
import { commitTask } from "../src/gsd/git.js";
import { createPlan } from "../src/gsd/planning.js";
import { createTempGitRepo } from "./test-utils/git-repo.js";

interface LifecycleCommitFlowResult {
	changedFilePath: string;
	commitHash: string;
	commitSubject: string;
	planPath: string;
}

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

function runPhase21LifecycleCommitFlow(repoPath: string): LifecycleCommitFlowResult {
	buildPhase21WorkspaceFixture(repoPath);
	createDomainModel(repoPath);

	const planPath = createPlan(repoPath, 21, 2, "Full lifecycle integration test");
	const changedFilePath = join(repoPath, "src", "phase-21-lifecycle.ts");

	mkdirSync(join(repoPath, "src"), { recursive: true });
	writeFileSync(changedFilePath, "export const lifecycleStatus = 'integration-ready';\n", "utf-8");

	const commitResult = commitTask(repoPath, 21, 2, "green: implement lifecycle integration");
	if (!commitResult.hash) {
		throw new Error("Expected commitTask() to create a real commit");
	}

	const commitSubject = execSync("git log --format=%s -1", {
		cwd: repoPath,
		encoding: "utf-8",
	}).trim();

	return {
		changedFilePath,
		commitHash: commitResult.hash,
		commitSubject,
		planPath,
	};
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

	it("creates a Phase 21 domain model, plan, and scoped task commit in one real repo", () => {
		const repo = createTempGitRepo();
		cleanups.push(repo.cleanup);

		const result = runPhase21LifecycleCommitFlow(repo.repoPath);

		expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
		expect(result.planPath).toContain("21-02-PLAN.md");
		expect(result.planPath).toContain("21-full-lifecycle-integration-test");
		expect(result.commitSubject).toBe("feat(21-02): green: implement lifecycle integration");
		expect(readFileSync(result.changedFilePath, "utf-8")).toContain("integration-ready");
	});
});
