import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStateMessageSchema } from "@draht/geist-protocol";
import { FleetRegistry } from "../../src/fleet-registry.js";
import type { HarnessCapabilities, HarnessSession, HarnessSessionStatus } from "../../src/harness-session.js";
import type { Project } from "../../src/project.js";
import { buildFleetState } from "../../src/registry/fleet-state-view.js";

/** Runs `git <args>` in `cwd` for test setup, failing loudly on any non-zero exit. */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** Initializes a real git repo (fleet worktrees are real git dirs — `FleetRegistry.addSession` shells out via `ShaLedger.record`). */
function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-state-view-test-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "fleet-state-view-test@example.com"]);
	git(dir, ["config", "user.name", "fleet-state-view-test"]);
	git(dir, ["commit", "--allow-empty", "-m", "initial commit"]);
	return dir;
}

const CAPABILITY_PROFILE_A: HarnessCapabilities = { images: true, commands: true, modes: true, resume: false };
const CAPABILITY_PROFILE_B: HarnessCapabilities = { images: false, commands: true, modes: false, resume: true };

/** A minimal `HarnessSession` fixture — only the fields `buildFleetState` reads are exercised in this test. */
function makeSession(id: string, harness: string, capabilities: HarnessCapabilities): HarnessSession {
	const status: HarnessSessionStatus = "running";
	return {
		id,
		harness,
		capabilities,
		status,
		dispatch: () => Promise.reject(new Error("not implemented in test fixture")),
		cancel: () => Promise.reject(new Error("not implemented in test fixture")),
		answerPermission: () => Promise.reject(new Error("not implemented in test fixture")),
		stop: () => Promise.resolve(),
	};
}

const repos: string[] = [];

function trackedRepo(): string {
	const dir = initRepo();
	repos.push(dir);
	return dir;
}

beforeEach(() => {
	repos.length = 0;
});

afterEach(() => {
	for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

describe("buildFleetState", () => {
	test("an empty fleet produces an empty, schema-valid sessions array", () => {
		const registry = new FleetRegistry();

		const message = buildFleetState(registry, []);

		expect(message).toEqual({
			type: "fleet_state",
			payload: { sessions: [], agents: [] },
		});
		expect(() => FleetStateMessageSchema.parse(message)).not.toThrow();
	});

	test("2+ mixed-harness sessions across 2 fixture repos produce a schema-valid payload with correct per-session harness/capabilities", () => {
		const registry = new FleetRegistry();

		const fr3n: Project = { slug: "fr3n", name: "fr3n", root: "/dev/fr3n" };
		const kintura: Project = { slug: "kintura", name: "Kintura", root: "/dev/kintura" };
		registry.registerProject(fr3n);
		registry.registerProject(kintura);

		const fr3nWorktree = trackedRepo();
		const kinturaWorktree = trackedRepo();

		const drahtSession = makeSession("session-draht", "draht", CAPABILITY_PROFILE_A);
		const claudeSession = makeSession("session-claude", "claude", CAPABILITY_PROFILE_B);
		const secondDrahtSession = makeSession("session-draht-2", "draht", CAPABILITY_PROFILE_A);

		registry.addSession(drahtSession, fr3n, fr3nWorktree);
		registry.addSession(claudeSession, kintura, kinturaWorktree);
		registry.addSession(secondDrahtSession, fr3n, fr3nWorktree);

		const agents = [
			{ name: "draht", authOk: true },
			{ name: "claude", authOk: false },
		];

		const message = buildFleetState(registry, agents);

		expect(() => FleetStateMessageSchema.parse(message)).not.toThrow();
		const parsed = FleetStateMessageSchema.parse(message);

		expect(parsed.payload.sessions).toHaveLength(3);
		expect(parsed.payload.sessions).toEqual([
			{
				id: "session-draht",
				projectSlug: "fr3n",
				harness: "draht",
				capabilities: CAPABILITY_PROFILE_A,
				status: "running",
			},
			{
				id: "session-claude",
				projectSlug: "kintura",
				harness: "claude",
				capabilities: CAPABILITY_PROFILE_B,
				status: "running",
			},
			{
				id: "session-draht-2",
				projectSlug: "fr3n",
				harness: "draht",
				capabilities: CAPABILITY_PROFILE_A,
				status: "running",
			},
		]);
		expect(parsed.payload.agents).toEqual(agents);
	});

	test("agents list is passed through unchanged, independent of fleet session state", () => {
		const registry = new FleetRegistry();
		const agents = [
			{ name: "draht", authOk: true },
			{ name: "claude", authOk: true },
			{ name: "codex", authOk: false },
			{ name: "gemini", authOk: false },
		];

		const message = buildFleetState(registry, agents);

		expect(FleetStateMessageSchema.parse(message).payload.agents).toEqual(agents);
	});
});
