import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetCapacityError, FleetRegistry, MAX_FLEET_SESSIONS, UnknownSessionError } from "../src/fleet-registry.js";
import type { HarnessSession } from "../src/harness-session.js";
import type { Project } from "../src/project.js";

/**
 * Unit tests for `FleetRegistry` (spec §16 M5, §17.7 "caps 4/3/4100"), most
 * importantly that `approve`/`undo`/`stop` are SCOPED to a single session's
 * worktree even when the fleet spans multiple projects and harnesses — never
 * fleet-wide. Sha-ledger operations shell out to real git (see
 * `ledger/sha-ledger.test.ts`), so these tests spin up real temp git repos
 * rather than mocking git away, matching that file's setup style.
 */

/** Runs `git <args>` in `cwd` for test setup/assertions, failing loudly on any non-zero exit. */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** Initializes a real git repo in a fresh temp dir, with local identity config so commits succeed in CI. */
function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-registry-test-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "fleet-registry-test@example.com"]);
	git(dir, ["config", "user.name", "fleet-registry-test"]);
	return dir;
}

/** Writes `file` with `contents` and creates a commit, returning the new commit's sha. */
function commitFile(repo: string, file: string, contents: string, message: string): string {
	writeFileSync(join(repo, file), contents);
	git(repo, ["add", file]);
	git(repo, ["commit", "-m", message]);
	return git(repo, ["rev-parse", "HEAD"]);
}

/** A minimal `Project` fixture. */
function makeProject(slug: string, root: string): Project {
	return { slug, name: slug, root };
}

/**
 * A minimal `HarnessSession`-shaped fake. `dispatch`/`cancel`/`answerPermission`
 * throw if called — they're not exercised by `FleetRegistry` tests — while
 * `stop` is a real spy so `FleetRegistry.stop()` can be proven to call it.
 */
function fakeSession(id: string, harness: string): { session: HarnessSession; stopCallCount: () => number } {
	let stopCalls = 0;
	const notExercised = (): never => {
		throw new Error(`${id}: not exercised by FleetRegistry tests`);
	};

	const session: HarnessSession = {
		id,
		harness,
		capabilities: { images: false, commands: false, modes: false, resume: false },
		status: "running",
		dispatch: notExercised,
		cancel: notExercised,
		answerPermission: notExercised,
		async stop() {
			stopCalls += 1;
		},
	};

	return { session, stopCallCount: () => stopCalls };
}

const tempDirs: string[] = [];

/** Registers a temp dir for cleanup and returns it, so every test's repos are torn down even on failure. */
function trackedRepo(): string {
	const dir = initRepo();
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("FleetRegistry projects", () => {
	test("registerProject makes it discoverable via getProject and listProjects", () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");

		fleet.registerProject(project);

		expect(fleet.getProject("fr3n")).toEqual(project);
		expect(fleet.listProjects()).toEqual([project]);
	});

	test("getProject returns undefined for an unregistered slug", () => {
		const fleet = new FleetRegistry();
		expect(fleet.getProject("nope")).toBeUndefined();
	});
});

describe("FleetRegistry.addSession capacity", () => {
	test(`allows up to ${MAX_FLEET_SESSIONS} sessions, then throws FleetCapacityError on the next`, () => {
		const fleet = new FleetRegistry();
		const project = makeProject("solo", "/repos/solo");

		for (let i = 0; i < MAX_FLEET_SESSIONS; i++) {
			const repo = trackedRepo();
			commitFile(repo, "file.txt", "v1", "initial commit");
			const { session } = fakeSession(`session-${i}`, "draht");
			fleet.addSession(session, project, repo);
		}

		expect(fleet.listSessions()).toHaveLength(MAX_FLEET_SESSIONS);

		const overflowRepo = trackedRepo();
		commitFile(overflowRepo, "file.txt", "v1", "initial commit");
		const { session: overflowSession } = fakeSession("overflow", "draht");

		expect(() => fleet.addSession(overflowSession, project, overflowRepo)).toThrow(FleetCapacityError);
	});

	test("the ≤4 cap holds across multiple projects and harnesses, not just within one", () => {
		const fleet = new FleetRegistry();
		const projectA = makeProject("project-a", "/repos/project-a");
		const projectB = makeProject("project-b", "/repos/project-b");
		fleet.registerProject(projectA);
		fleet.registerProject(projectB);

		const mix: Array<{ project: Project; harness: string }> = [
			{ project: projectA, harness: "draht" },
			{ project: projectA, harness: "claude" },
			{ project: projectB, harness: "draht" },
			{ project: projectB, harness: "claude" },
		];

		for (const [i, { project, harness }] of mix.entries()) {
			const repo = trackedRepo();
			commitFile(repo, "file.txt", "v1", "initial commit");
			const { session } = fakeSession(`mix-${i}`, harness);
			fleet.addSession(session, project, repo);
		}

		expect(fleet.listSessions()).toHaveLength(MAX_FLEET_SESSIONS);
		expect(new Set(fleet.listEntries().map((entry) => entry.project.slug))).toEqual(
			new Set(["project-a", "project-b"]),
		);
		expect(new Set(fleet.listSessions().map((session) => session.harness))).toEqual(new Set(["draht", "claude"]));

		const fifthRepo = trackedRepo();
		commitFile(fifthRepo, "file.txt", "v1", "initial commit");
		const { session: fifthSession } = fakeSession("mix-4", "claude");

		expect(() => fleet.addSession(fifthSession, projectB, fifthRepo)).toThrow(FleetCapacityError);
		expect(fleet.listSessions()).toHaveLength(MAX_FLEET_SESSIONS);
	});
});

describe("FleetRegistry session lookup", () => {
	test("addSession links session, project, and worktreePath, retrievable via getEntry/listEntries", () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");
		const repo = trackedRepo();
		commitFile(repo, "file.txt", "v1", "initial commit");
		const { session } = fakeSession("session-1", "draht");

		fleet.addSession(session, project, repo);

		expect(fleet.getSession("session-1")).toBe(session);
		expect(fleet.getEntry("session-1")).toEqual({ session, project, worktreePath: repo });
		expect(fleet.listEntries()).toEqual([{ session, project, worktreePath: repo }]);
	});

	test("getSession/getEntry return undefined for an unregistered id", () => {
		const fleet = new FleetRegistry();
		expect(fleet.getSession("nope")).toBeUndefined();
		expect(fleet.getEntry("nope")).toBeUndefined();
	});

	test("removeSession silently no-ops for an unregistered id (no throw)", () => {
		const fleet = new FleetRegistry();
		expect(() => fleet.removeSession("nope")).not.toThrow();
	});
});

describe("FleetRegistry scoped approve/undo", () => {
	test("approve/undo/stop throw UnknownSessionError for a sessionId not in the fleet", async () => {
		const fleet = new FleetRegistry();

		expect(() => fleet.approve("ghost")).toThrow(UnknownSessionError);
		expect(() => fleet.undo("ghost")).toThrow(UnknownSessionError);
		await expect(fleet.stop("ghost")).rejects.toThrow(UnknownSessionError);
	});

	test("approve/undo act on ONLY the targeted session's worktree, across different projects and harnesses", () => {
		const fleet = new FleetRegistry();
		const projectA = makeProject("project-a", "/repos/project-a");
		const projectB = makeProject("project-b", "/repos/project-b");

		const repoA = trackedRepo();
		const baseShaA = commitFile(repoA, "file.txt", "a-v1", "project A initial commit");
		const repoB = trackedRepo();
		const baseShaB = commitFile(repoB, "file.txt", "b-v1", "project B initial commit");

		const { session: sessionA } = fakeSession("session-a", "draht");
		const { session: sessionB } = fakeSession("session-b", "claude");
		fleet.addSession(sessionA, projectA, repoA);
		fleet.addSession(sessionB, projectB, repoB);

		// Dirty BOTH worktrees with uncommitted edits.
		writeFileSync(join(repoA, "file.txt"), "a-dirty");
		writeFileSync(join(repoB, "file.txt"), "b-dirty");
		expect(git(repoA, ["status", "--porcelain"])).not.toBe("");
		expect(git(repoB, ["status", "--porcelain"])).not.toBe("");

		// approve() only session A: marks lastApprovedSha, discards nothing.
		fleet.approve("session-a");

		expect(readFileSync(join(repoA, "file.txt"), "utf8")).toBe("a-dirty");
		expect(git(repoA, ["status", "--porcelain"])).not.toBe("");
		expect(git(repoA, ["rev-parse", "HEAD"])).toBe(baseShaA);

		// undo() only session B: resets B's worktree to its ledger fallback (baseSha, never approved).
		fleet.undo("session-b");

		expect(git(repoB, ["rev-parse", "HEAD"])).toBe(baseShaB);
		expect(git(repoB, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(repoB, "file.txt"), "utf8")).toBe("b-v1");

		// A remains completely untouched by B's undo.
		expect(readFileSync(join(repoA, "file.txt"), "utf8")).toBe("a-dirty");
		expect(git(repoA, ["status", "--porcelain"])).not.toBe("");
		expect(git(repoA, ["rev-parse", "HEAD"])).toBe(baseShaA);
	});

	test("undo() falls back to lastApprovedSha (not baseSha) once a session has been approved", () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");
		const repo = trackedRepo();
		commitFile(repo, "file.txt", "v1", "initial commit");
		const { session } = fakeSession("session-1", "draht");
		fleet.addSession(session, project, repo);

		const approvedSha = commitFile(repo, "file.txt", "v2", "second commit");
		fleet.approve("session-1");

		commitFile(repo, "file.txt", "v3", "third commit, never approved");
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v3");

		fleet.undo("session-1");

		expect(git(repo, ["rev-parse", "HEAD"])).toBe(approvedSha);
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v2");
	});
});

describe("FleetRegistry.stop", () => {
	test("stops ONLY the targeted session's harness subprocess and removes it from the fleet", async () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");

		const repoA = trackedRepo();
		commitFile(repoA, "file.txt", "v1", "initial commit");
		const repoB = trackedRepo();
		commitFile(repoB, "file.txt", "v1", "initial commit");

		const { session: sessionA, stopCallCount: stopCallsA } = fakeSession("session-a", "draht");
		const { session: sessionB, stopCallCount: stopCallsB } = fakeSession("session-b", "claude");
		fleet.addSession(sessionA, project, repoA);
		fleet.addSession(sessionB, project, repoB);

		await fleet.stop("session-a");

		expect(stopCallsA()).toBe(1);
		expect(stopCallsB()).toBe(0);
		expect(fleet.getSession("session-a")).toBeUndefined();
		expect(fleet.getSession("session-b")).toBe(sessionB);
		expect(fleet.listSessions()).toEqual([sessionB]);
	});

	test("stopping frees a slot under the ≤4-session cap", async () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");

		for (let i = 0; i < MAX_FLEET_SESSIONS; i++) {
			const repo = trackedRepo();
			commitFile(repo, "file.txt", "v1", "initial commit");
			const { session } = fakeSession(`session-${i}`, "draht");
			fleet.addSession(session, project, repo);
		}

		await fleet.stop("session-0");

		const freshRepo = trackedRepo();
		commitFile(freshRepo, "file.txt", "v1", "initial commit");
		const { session: freshSession } = fakeSession("session-fresh", "claude");

		expect(() => fleet.addSession(freshSession, project, freshRepo)).not.toThrow();
		expect(fleet.listSessions()).toHaveLength(MAX_FLEET_SESSIONS);
	});
});
