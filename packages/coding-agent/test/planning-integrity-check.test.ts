import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const checker = join(root, "scripts/check-draht-customizations.mjs");
const temporaryRepositories: string[] = [];

function repository() {
	const cwd = mkdtempSync(join(tmpdir(), "draht-planning-integrity-"));
	temporaryRepositories.push(cwd);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{
				cwd,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	git("init", "--quiet", "--initial-branch=main");
	mkdirSync(join(cwd, ".planning"));
	writeFileSync(join(cwd, ".planning", "STATE.md"), "Initial planning state\n");
	git("add", ".planning/STATE.md");
	git("commit", "--quiet", "-m", "Initial fixture");
	git("switch", "--quiet", "--create", "feature");
	return { cwd, git };
}

function divergedRepository() {
	const fixture = repository();
	writeFileSync(join(fixture.cwd, "feature.txt"), "Feature change\n");
	fixture.git("add", "feature.txt");
	fixture.git("commit", "--quiet", "-m", "Feature fixture");
	fixture.git("switch", "--quiet", "main");
	writeFileSync(join(fixture.cwd, ".planning", "STATE.md"), "Main advanced independently\n");
	fixture.git("add", ".planning/STATE.md");
	fixture.git("commit", "--quiet", "-m", "Planning update on main");
	fixture.git("switch", "--quiet", "feature");
	return fixture;
}

function checkPlanning(cwd: string) {
	// The complete checker reads real project files; only Git sees the isolated fixture.
	return spawnSync(process.execPath, [checker], {
		cwd: root,
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 2 * 1024 * 1024,
		env: { ...process.env, GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd },
	});
}

afterEach(() => {
	for (const cwd of temporaryRepositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("planning integrity on diverged branches", () => {
	it("does not mistake planning updates on main for edits made by the feature branch", () => {
		const { cwd } = divergedRepository();
		const result = checkPlanning(cwd);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(".planning/ unchanged vs merge-base with main");
	});

	it.each(["working tree", "staged", "committed"])(
		"still rejects branch-local planning changes in the %s",
		(state) => {
			const { cwd, git } = divergedRepository();
			writeFileSync(join(cwd, ".planning", "STATE.md"), "Feature branch changed planning\n");
			if (state !== "working tree") git("add", ".planning/STATE.md");
			if (state === "committed") git("commit", "--quiet", "-m", "Planning change on feature");
			const result = checkPlanning(cwd);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(".planning/ unchanged vs merge-base with main");
		},
	);

	it("preserves the planning-authoring exemption on main", () => {
		const { cwd, git } = divergedRepository();
		git("switch", "--quiet", "main");
		writeFileSync(join(cwd, ".planning", "STATE.md"), "Uncommitted planning work on main\n");
		const result = checkPlanning(cwd);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(".planning/ check skipped (authoring branch)");
	});

	it("preserves the authoring exemption when HEAD and main are identical", () => {
		const { cwd } = repository();
		writeFileSync(join(cwd, ".planning", "STATE.md"), "Uncommitted planning work at main\n");
		const result = checkPlanning(cwd);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(".planning/ check skipped (authoring branch)");
	});

	it("preserves the existing missing-main behavior", () => {
		const { cwd, git } = repository();
		git("branch", "--delete", "main");
		const result = checkPlanning(cwd);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(".planning/ check skipped (no main ref)");
	});
});
