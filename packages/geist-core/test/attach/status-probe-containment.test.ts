import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeEnvironment, probeGitStatus } from "../../src/attach/status-probe.ts";

const CANARY_ENV = "DRAHT_STATUS_PROBE_CANARY";
const CANARY_VALUE = "if-you-can-read-this-the-allowlist-failed";

let dir: string;
let evidenceFile: string;
let fsmonitorHook: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "spc-"));
	evidenceFile = join(dir, "evidence.txt");
	fsmonitorHook = join(dir, "fsmonitor.sh");

	const repo = join(dir, "repo");
	mkdirSync(repo);
	spawnSync("git", ["init", "-q"], { cwd: repo });

	// `exit 1` makes git fall back to a full scan, so the probe still returns a real answer.
	writeFileSync(
		fsmonitorHook,
		`#!/bin/sh\necho "RAN canary=\${${CANARY_ENV}:-ABSENT}" >> ${JSON.stringify(evidenceFile)}\nexit 1\n`,
		{ mode: 0o755 },
	);
	chmodSync(fsmonitorHook, 0o755);
	spawnSync("git", ["config", "core.fsmonitor", fsmonitorHook], { cwd: repo });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env[CANARY_ENV];
});

function repoPath(): string {
	return join(dir, "repo");
}

function evidenceLines(): string[] {
	if (!existsSync(evidenceFile)) return [];
	return readFileSync(evidenceFile, "utf8").split("\n").filter(Boolean);
}

describe("the status probe does not run what a repository asks it to", () => {
	test("a repository's core.fsmonitor never executes", async () => {
		process.env[CANARY_ENV] = CANARY_VALUE;

		const result = await probeGitStatus(repoPath(), { deadlineMs: 10_000 });

		expect(result.status).toBe("clean");
		expect(evidenceLines()).toEqual([]);
	}, 20_000);

	test("and if it did run, it would learn nothing — the environment is an allowlist", async () => {
		process.env[CANARY_ENV] = CANARY_VALUE;

		const env = probeEnvironment();
		expect(Object.keys(env).sort()).toEqual(["GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH", "SSH_ASKPASS"]);
		expect(Object.values(env)).not.toContain(CANARY_VALUE);
		expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");

		// git applies the last `-c` for a key, so this overrides the probe's own empty one.
		const direct = spawnSync(
			"git",
			["-c", `core.fsmonitor=${fsmonitorHook}`, "--no-optional-locks", "status", "--porcelain"],
			{
				cwd: repoPath(),
				env,
			},
		);
		expect(direct.error).toBeUndefined();

		const lines = evidenceLines();
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).toBe("RAN canary=ABSENT");
	}, 20_000);

	test("the probe resolves an absolute git, so PATH cannot supply one", async () => {
		const shadowDir = join(dir, "shadow");
		mkdirSync(shadowDir);
		const fake = join(shadowDir, "git");
		writeFileSync(fake, `#!/bin/sh\necho "SHADOW RAN" >> ${JSON.stringify(evidenceFile)}\nexit 0\n`, { mode: 0o755 });
		chmodSync(fake, 0o755);

		const previous = process.env.PATH;
		process.env.PATH = `${shadowDir}:${previous ?? ""}`;
		try {
			const result = await probeGitStatus(repoPath(), { deadlineMs: 10_000 });
			// A shadow that ran would also report `clean`, so only the evidence file discriminates.
			expect(evidenceLines()).toEqual([]);
			expect(result.status).toBe("clean");
		} finally {
			process.env.PATH = previous;
		}
	}, 20_000);
});
