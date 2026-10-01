/**
 * R36-SPAWN.5 — the spawn argv, and what two of its flags actually do to the emitted binary.
 *
 * EVIDENCE CLASS 2, NOT THE ACCEPTANCE. The behavioural half drives the POSTURE SUBSET of
 * the argv, not the frozen array: `--mode rpc`/`--attachable` need a socket and a driver,
 * and proving a real phone spawn passes these flags is wave 5's class-3 job.
 *
 * The fixture's trust.json records this project as trusted — exactly the state the daemon's
 * pre-spawn `projectExplicitlyUntrusted` veto lets through, and the state the control run
 * below shows loading the project's own SYSTEM.md and executing its extension.
 *
 * SIP is enabled here, so dtrace gives no exec oracle: the tripwire is a FILE the extension's
 * module body writes, which is the only race-immune negative available.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSpawnArgv } from "../session/spawn-argv.js";
import { SpawnRefusedError } from "../session/spawn-primitive.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");

const PARENT_CANARY = "canary-above-the-root-8f21";
const IN_ROOT_CANARY = "canary-inside-the-root-4c07";
const SYSTEM_MD_CANARY = "canary-project-system-md-b93e";

const cleanup: string[] = [];

/** A unix socket path over ~104 bytes fails to bind with EINVAL, so temp dirs go directly under /tmp. */
function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
	cleanup.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildSpawnArgv", () => {
	const leading = ["/usr/local/bin/node", "/opt/draht/cli.js"];

	test("returns exactly the frozen array", () => {
		expect(
			buildSpawnArgv({
				sessionId: "11111111-2222-4333-8444-555555555555",
				projectRoot: "/srv/projects/alpha",
				leadingArgs: leading,
			}),
		).toEqual([
			"/usr/local/bin/node",
			"/opt/draht/cli.js",
			"--session-id",
			"11111111-2222-4333-8444-555555555555",
			"--attachable",
			"--mode",
			"rpc",
			"--no-approve",
			"--context-root",
			"/srv/projects/alpha",
		]);
	});

	test("refuses a relative project root", () => {
		expect(() =>
			buildSpawnArgv({ sessionId: "abc123", projectRoot: "projects/alpha", leadingArgs: leading }),
		).toThrow(/not absolute/);
	});

	test.each([
		["a slash", "a/b"],
		["a leading traversal", "../../etc/passwd"],
		["a space", "abc 123"],
		["a leading dash", "--no-approve"],
		["a trailing newline", "abc123\n"],
		["emptiness", ""],
		["a dot", "abc.123"],
		["over 128 characters", "a".repeat(129)],
	])("refuses a session id containing %s", (_label, sessionId) => {
		expect(() => buildSpawnArgv({ sessionId, projectRoot: "/srv/alpha", leadingArgs: leading })).toThrow(
			/not id-shaped/,
		);
	});

	// The code, not just the message: W4 maps a refusal onto the wire's spawn codes.
	test("both refusals carry the wire's refusal code", () => {
		for (const input of [
			{ sessionId: "a b", projectRoot: "/srv/alpha", leadingArgs: leading },
			{ sessionId: "abc123", projectRoot: "srv/alpha", leadingArgs: leading },
		]) {
			let thrown: unknown;
			try {
				buildSpawnArgv(input);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(SpawnRefusedError);
			expect((thrown as SpawnRefusedError).code).toBe("refused");
		}
	});
});

interface Fixture {
	root: string;
	tripwire: string;
	agentDir: string;
	home: string;
	tmp: string;
}

/** A run of the emitted binary; returns the systemPrompt the stub provider recorded. */
function runDraht(fixture: Fixture, extraArgs: string[], recordPath: string): string {
	const result = Bun.spawnSync(
		[
			"node",
			DRAHT_CLI,
			"-p",
			"hi",
			"--provider",
			"draht-stub",
			"--model",
			"stub-1",
			// Without this the print-mode run never returns; the argv the daemon builds
			// carries `--mode rpc` instead, which this half deliberately does not drive.
			"--no-session",
			...extraArgs,
		],
		{
			cwd: fixture.root,
			env: {
				...process.env,
				// This repo's shell exports `auto`; an inherited auto-approving mode would
				// make the tripwire prove nothing.
				DRAHT_PERMISSION_MODE: undefined,
				HOME: fixture.home,
				TMPDIR: fixture.tmp,
				DRAHT_CODING_AGENT_DIR: fixture.agentDir,
				DRAHT_STUB_PROVIDER: "1",
				DRAHT_STUB_RECORD_CONTEXT: recordPath,
			},
			stdin: "ignore",
		},
	);
	const detail = `exit=${result.exitCode}\n${result.stdout.toString()}\n${result.stderr.toString()}`;
	expect(result.exitCode, detail).toBe(0);
	expect(existsSync(recordPath), `the stub recorded nothing; ${detail}`).toBe(true);
	return readFileSync(recordPath, "utf-8");
}

describe("the posture flags against the emitted binary, over a standing trust grant", () => {
	let fixture: Fixture;

	beforeAll(() => {
		// Built unconditionally: a stale dist/cli.js from an older checkout says nothing
		// about this source tree, and the flags under test live in it.
		const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
		if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
		if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);

		const base = tempDir("gsa-");
		const parent = join(base, "parent");
		const root = join(parent, "proj");
		const agentDir = join(base, "ad");
		const home = join(base, "home");
		const tmp = join(base, "tmp");
		mkdirSync(join(root, ".draht", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(home, { recursive: true });
		mkdirSync(tmp, { recursive: true });

		writeFileSync(join(parent, "AGENTS.md"), `${PARENT_CANARY}\n`);
		writeFileSync(join(root, "AGENTS.md"), `${IN_ROOT_CANARY}\n`);
		writeFileSync(join(root, ".draht", "SYSTEM.md"), `${SYSTEM_MD_CANARY}\n`);

		const tripwire = join(base, "tripwire.txt");
		writeFileSync(
			join(root, ".draht", "extensions", "tripwire.ts"),
			`import { writeFileSync } from "node:fs";\n` +
				`writeFileSync(${JSON.stringify(tripwire)}, "loaded", "utf-8");\n` +
				`export default function (pi) {\n\tpi.registerCommand("tripwire", { handler: async () => {} });\n}\n`,
		);
		writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [root]: true }, null, 2)}\n`);

		fixture = { root, tripwire, agentDir, home, tmp };
	}, 300_000);

	// The positive control, verified empirically before the negatives were written: without
	// the flags, the standing grant really does load all three project resources. Without
	// this run, every absence asserted below would also hold for a fixture that never worked.
	test("unflagged, the standing grant loads the project's own context and runs its extension", () => {
		rmSync(fixture.tripwire, { force: true });
		const recorded = runDraht(fixture, [], join(fixture.agentDir, "control.txt"));

		expect(recorded).toContain(IN_ROOT_CANARY);
		expect(recorded).toContain(PARENT_CANARY);
		expect(recorded).toContain(SYSTEM_MD_CANARY);
		expect(existsSync(fixture.tripwire)).toBe(true);
	}, 120_000);

	test("the posture subset strips the project's context and never loads its extension", () => {
		rmSync(fixture.tripwire, { force: true });
		const recorded = runDraht(
			fixture,
			["--session-id", "11111111-2222-4333-8444-555555555555", "--no-approve", "--context-root", fixture.root],
			join(fixture.agentDir, "posture.txt"),
		);

		expect(recorded).toContain(IN_ROOT_CANARY);
		expect(recorded).not.toContain(PARENT_CANARY);
		expect(recorded).not.toContain(SYSTEM_MD_CANARY);
		expect(existsSync(fixture.tripwire)).toBe(false);
	}, 120_000);
});
