import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetRegistry } from "../../src/fleet-registry.js";
import type { HarnessSession } from "../../src/harness-session.js";
import type { Project } from "../../src/project.js";
import {
	EmptyVariantSetError,
	NotAVariantError,
	VariantSet,
	VariantSetResolvedError,
} from "../../src/variants/variant-set.js";

/**
 * Unit tests for `VariantSet.pickWinner` (spec §16 M6 "winner kept, siblings
 * reset+pruned"; DOMAIN.md `VariantWinnerPicked`). Like `fleet-registry.test.ts`
 * — whose fixture style these mirror — the sha-ledger operations shell out to
 * real git, so each variant member is a real registered fleet session over its
 * own real temp git repo rather than a mock.
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
	const dir = mkdtempSync(join(tmpdir(), "variant-set-test-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "variant-set-test@example.com"]);
	git(dir, ["config", "user.name", "variant-set-test"]);
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
 * throw if called; `stop` is a real spy so a pruned sibling can be proven to
 * have had its subprocess stopped.
 */
function fakeSession(id: string, harness: string): { session: HarnessSession; stopCallCount: () => number } {
	let stopCalls = 0;
	const notExercised = (): never => {
		throw new Error(`${id}: not exercised by VariantSet tests`);
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

describe("VariantSet construction", () => {
	test("throws EmptyVariantSetError when constructed with no members", () => {
		const fleet = new FleetRegistry();
		expect(() => new VariantSet(fleet, [])).toThrow(EmptyVariantSetError);
	});

	test("throws UnknownSessionError for a member id not registered in the fleet", () => {
		const fleet = new FleetRegistry();
		expect(() => new VariantSet(fleet, ["ghost"])).toThrow("no session registered in the fleet with id: ghost");
	});

	test("listVariants reports each member's harness and a `pending` status before a winner is picked", () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");
		const repoA = trackedRepo();
		commitFile(repoA, "file.txt", "v1", "initial commit");
		const repoB = trackedRepo();
		commitFile(repoB, "file.txt", "v1", "initial commit");
		const { session: sessionA } = fakeSession("var-a", "claude");
		const { session: sessionB } = fakeSession("var-b", "codex");
		fleet.addSession(sessionA, project, repoA);
		fleet.addSession(sessionB, project, repoB);

		const set = new VariantSet(fleet, ["var-a", "var-b"]);

		expect(set.isResolved).toBe(false);
		expect(set.winnerId).toBeUndefined();
		expect(set.listVariants()).toEqual([
			{ sessionId: "var-a", harness: "claude", status: "pending" },
			{ sessionId: "var-b", harness: "codex", status: "pending" },
		]);
	});
});

describe("VariantSet.pickWinner", () => {
	test("keeps the winner untouched (approved, still dirty) and resets+prunes every sibling", async () => {
		const fleet = new FleetRegistry();
		const project = makeProject("shoot-out", "/repos/shoot-out");

		// --- Winner: a real registered session, advanced past its base AND left dirty. ---
		const winnerRepo = trackedRepo();
		const winnerBaseSha = commitFile(winnerRepo, "file.txt", "w-v1", "winner initial commit");
		const { session: winnerSession, stopCallCount: winnerStops } = fakeSession("winner", "claude");
		fleet.addSession(winnerSession, project, winnerRepo);
		const winnerApprovedSha = commitFile(winnerRepo, "file.txt", "w-v2", "winner second commit");
		writeFileSync(join(winnerRepo, "file.txt"), "w-v2-dirty"); // uncommitted edit on top
		expect(winnerApprovedSha).not.toBe(winnerBaseSha);
		expect(git(winnerRepo, ["status", "--porcelain"])).not.toBe("");

		// --- Sibling A: dirty via an uncommitted edit only (HEAD == base). ---
		const siblingARepo = trackedRepo();
		const siblingABaseSha = commitFile(siblingARepo, "file.txt", "a-v1", "sibling A initial commit");
		const { session: siblingASession, stopCallCount: siblingAStops } = fakeSession("sibling-a", "codex");
		fleet.addSession(siblingASession, project, siblingARepo);
		writeFileSync(join(siblingARepo, "file.txt"), "a-dirty");

		// --- Sibling B: dirty differently — a new commit ahead of base PLUS an uncommitted edit. ---
		const siblingBRepo = trackedRepo();
		const siblingBBaseSha = commitFile(siblingBRepo, "file.txt", "b-v1", "sibling B initial commit");
		const { session: siblingBSession, stopCallCount: siblingBStops } = fakeSession("sibling-b", "draht");
		fleet.addSession(siblingBSession, project, siblingBRepo);
		commitFile(siblingBRepo, "file.txt", "b-v2", "sibling B advance (never approved)");
		writeFileSync(join(siblingBRepo, "file.txt"), "b-v2-dirty");

		const set = new VariantSet(fleet, ["winner", "sibling-a", "sibling-b"]);

		await set.pickWinner("winner");

		// Winner KEPT: worktree completely unchanged — still dirty exactly as before, HEAD unmoved,
		// still in the fleet, its subprocess never stopped.
		expect(readFileSync(join(winnerRepo, "file.txt"), "utf8")).toBe("w-v2-dirty");
		expect(git(winnerRepo, ["status", "--porcelain"])).not.toBe("");
		expect(git(winnerRepo, ["rev-parse", "HEAD"])).toBe(winnerApprovedSha);
		expect(fleet.getEntry("winner")).toBeDefined();
		expect(winnerStops()).toBe(0);

		// Siblings RESET + PRUNED: each hard-reset back to its base state, subprocess stopped,
		// removed from the fleet.
		expect(git(siblingARepo, ["rev-parse", "HEAD"])).toBe(siblingABaseSha);
		expect(git(siblingARepo, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(siblingARepo, "file.txt"), "utf8")).toBe("a-v1");
		expect(fleet.getEntry("sibling-a")).toBeUndefined();
		expect(siblingAStops()).toBe(1);

		expect(git(siblingBRepo, ["rev-parse", "HEAD"])).toBe(siblingBBaseSha);
		expect(git(siblingBRepo, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(siblingBRepo, "file.txt"), "utf8")).toBe("b-v1");
		expect(fleet.getEntry("sibling-b")).toBeUndefined();
		expect(siblingBStops()).toBe(1);

		// Set state reflects the resolution.
		expect(set.isResolved).toBe(true);
		expect(set.winnerId).toBe("winner");
		expect(set.listVariants()).toEqual([
			{ sessionId: "winner", harness: "claude", status: "winner" },
			{ sessionId: "sibling-a", harness: "codex", status: "pruned" },
			{ sessionId: "sibling-b", harness: "draht", status: "pruned" },
		]);

		// Prove the winner was APPROVED (not merely left alone): its `lastApprovedSha` is now the
		// advanced commit, so a subsequent undo falls back to THAT sha, not to `baseSha`. Without the
		// approve, undo would reset to `winnerBaseSha` and the file would read "w-v1".
		fleet.undo("winner");
		expect(git(winnerRepo, ["rev-parse", "HEAD"])).toBe(winnerApprovedSha);
		expect(readFileSync(join(winnerRepo, "file.txt"), "utf8")).toBe("w-v2");
	});

	test("throws VariantSetResolvedError when a winner has already been picked", async () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");
		const winnerRepo = trackedRepo();
		commitFile(winnerRepo, "file.txt", "v1", "initial commit");
		const siblingRepo = trackedRepo();
		commitFile(siblingRepo, "file.txt", "v1", "initial commit");
		const { session: winnerSession } = fakeSession("winner", "claude");
		const { session: siblingSession, stopCallCount: siblingStops } = fakeSession("sibling", "codex");
		fleet.addSession(winnerSession, project, winnerRepo);
		fleet.addSession(siblingSession, project, siblingRepo);

		const set = new VariantSet(fleet, ["winner", "sibling"]);
		await set.pickWinner("winner");

		expect(siblingStops()).toBe(1);
		await expect(set.pickWinner("winner")).rejects.toThrow(VariantSetResolvedError);
		// The second call is refused before touching anything: the sibling isn't stopped again.
		expect(siblingStops()).toBe(1);
	});

	test("throws NotAVariantError for a session id that is not a member, leaving the set unresolved", async () => {
		const fleet = new FleetRegistry();
		const project = makeProject("fr3n", "/repos/fr3n");
		const winnerRepo = trackedRepo();
		commitFile(winnerRepo, "file.txt", "v1", "initial commit");
		const siblingRepo = trackedRepo();
		commitFile(siblingRepo, "file.txt", "v1", "initial commit");
		const { session: winnerSession } = fakeSession("winner", "claude");
		const { session: siblingSession, stopCallCount: siblingStops } = fakeSession("sibling", "codex");
		fleet.addSession(winnerSession, project, winnerRepo);
		fleet.addSession(siblingSession, project, siblingRepo);

		const set = new VariantSet(fleet, ["winner", "sibling"]);

		await expect(set.pickWinner("not-a-member")).rejects.toThrow(NotAVariantError);
		// Nothing was mutated: the set is still open and a real winner can still be picked.
		expect(set.isResolved).toBe(false);
		expect(siblingStops()).toBe(0);

		await set.pickWinner("winner");
		expect(set.winnerId).toBe("winner");
		expect(siblingStops()).toBe(1);
	});
});
