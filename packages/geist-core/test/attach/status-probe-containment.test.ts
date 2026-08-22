/*
 * The status probe runs `git` in every cwd the daemon knows about, on every
 * fleet refresh. That makes it the daemon's widest contact surface with content
 * it does not own, and `git status` is not a passive reader: it RUNS PROGRAMS
 * THE REPOSITORY CHOOSES. `core.fsmonitor` is a path git executes on every
 * status, and `.git/config` belongs to whoever wrote the repository.
 *
 * This was live. Before the fix the probe spawned `git` by bare name (a PATH
 * lookup) with `{...process.env}` — the daemon's whole environment — so any
 * repository the operator had ever opened a session in could run a program of
 * its choosing and read whatever credentials the daemon was started with, twice
 * per status, on every refresh. It was demonstrated with a fixture repo, not
 * argued from the docs.
 *
 * Two independent layers close it, and this file proves EACH ONE ALONE, because
 * defence in depth that has only ever been tested together is one layer with a
 * spare:
 *
 *   1. `-c core.fsmonitor=` on the argv, which outranks any repository config.
 *   2. An allowlisted environment, so a program that does run learns nothing.
 *
 * The second is tested by neutering the first inside the fixture — the only way
 * to observe that the allowlist carries its own weight.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeEnvironment, probeGitStatus } from "../../src/attach/status-probe.ts";

/** A secret name no real tool reads, so its presence can only come from inheritance. */
const CANARY_ENV = "DRAHT_STATUS_PROBE_CANARY";
const CANARY_VALUE = "if-you-can-read-this-the-allowlist-failed";

let dir: string;
let evidence: string;
let hook: string;

beforeEach(() => {
	// Directly under /tmp with a short name: a long path is its own class of
	// failure elsewhere in this repo and there is no reason to invite it here.
	dir = mkdtempSync(join(tmpdir(), "spc-"));
	evidence = join(dir, "evidence.txt");
	hook = join(dir, "fsmonitor.sh");

	const repo = join(dir, "repo");
	mkdirSync(repo);
	spawnSync("git", ["init", "-q"], { cwd: repo });

	// The hook records whether it ran AND what it could see. Exiting non-zero
	// makes git fall back to a normal scan, so the probe still returns a real
	// answer and the test is not measuring a broken repository.
	writeFileSync(
		hook,
		`#!/bin/sh\necho "RAN canary=\${${CANARY_ENV}:-ABSENT}" >> ${JSON.stringify(evidence)}\nexit 1\n`,
		{ mode: 0o755 },
	);
	chmodSync(hook, 0o755);
	spawnSync("git", ["config", "core.fsmonitor", hook], { cwd: repo });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env[CANARY_ENV];
});

function repoPath(): string {
	return join(dir, "repo");
}

function ranLines(): string[] {
	if (!existsSync(evidence)) return [];
	return readFileSync(evidence, "utf8").split("\n").filter(Boolean);
}

describe("the status probe does not run what a repository asks it to", () => {
	test("a repository's core.fsmonitor never executes", async () => {
		process.env[CANARY_ENV] = CANARY_VALUE;

		const result = await probeGitStatus(repoPath(), { deadlineMs: 10_000 });

		// The probe still did its job — this is not passing because it failed.
		expect(result.status).toBe("clean");

		// LAYER 1. Nothing ran at all.
		expect(ranLines()).toEqual([]);
	}, 20_000);

	test("and if it did run, it would learn nothing — the environment is an allowlist", async () => {
		process.env[CANARY_ENV] = CANARY_VALUE;

		// Assert what the SOURCE builds, not what this test can build. The first
		// version of this test spawned git with its own hardcoded allowlist, and
		// measured: with the source reverted to `{...process.env}` it still passed.
		// It proved an allowlist works, never that this module uses one.
		const env = probeEnvironment();
		expect(Object.keys(env).sort()).toEqual(["GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH", "SSH_ASKPASS"]);
		expect(Object.values(env)).not.toContain(CANARY_VALUE);
		expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");

		// And end to end: neuter LAYER 1 in the FIXTURE (git applies the last `-c`
		// for a key, so this overrides the probe's own empty one) while handing the
		// child the source's real environment. The hook runs, and sees nothing.
		const direct = spawnSync(
			"git",
			["-c", `core.fsmonitor=${hook}`, "--no-optional-locks", "status", "--porcelain"],
			{
				cwd: repoPath(),
				env,
			},
		);
		expect(direct.error).toBeUndefined();

		const lines = ranLines();
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).toBe("RAN canary=ABSENT");
	}, 20_000);

	test("the probe resolves an absolute git, so PATH cannot supply one", async () => {
		// A shadowing `git` earlier in PATH would be executed by a bare-name spawn.
		// The probe resolves an absolute system path instead, so this fake is never
		// reached — and the probe returns a real answer rather than this one.
		const shadowDir = join(dir, "shadow");
		mkdirSync(shadowDir);
		const fake = join(shadowDir, "git");
		writeFileSync(fake, `#!/bin/sh\necho "SHADOW RAN" >> ${JSON.stringify(evidence)}\nexit 0\n`, { mode: 0o755 });
		chmodSync(fake, 0o755);

		const previous = process.env.PATH;
		process.env.PATH = `${shadowDir}:${previous ?? ""}`;
		try {
			const result = await probeGitStatus(repoPath(), { deadlineMs: 10_000 });
			// A shadow that ran would exit 0 with empty stdout, which reads as `clean`
			// too — so the shadow's own evidence file is the discriminator, not the
			// status.
			expect(ranLines()).toEqual([]);
			expect(result.status).toBe("clean");
		} finally {
			process.env.PATH = previous;
		}
	}, 20_000);
});
