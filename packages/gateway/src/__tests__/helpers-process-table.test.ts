// Real processes, put into the states `helpers/process-table.ts` exists to distinguish. Every way of reading `ps`
// wrongly fails OPEN, so each case also shows the naive form answering wrongly about the very same process.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	assertEnvAbsent,
	descendantsOf,
	EnvironmentNotVisibleError,
	envOf,
	groupMembers,
	isProcessAlive,
	isZombie,
	liveGroupMembers,
	PositiveControlMissingError,
	ProcessTableError,
	PS_ROWS_COMMAND,
	psRows,
	reapPgids,
	rowFor,
	uniqueMarker,
	waitForGroupGone,
} from "./helpers/process-table.js";

const pgids = new Set<number>();
const cleanup: string[] = [];
/** Stopped fixtures must be SIGCONTed before they can die. */
const stopped: number[] = [];

const BUN = process.execPath;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

/** `detached: true` gives the child its own session (no controlling terminal) and its own pgid (a reap that cannot
 * reach anything this run did not start). */
function fixture(argv: string[], env: Record<string, string>): Bun.Subprocess {
	const proc = Bun.spawn(argv, { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	pgids.add(proc.pid);
	return proc;
}

async function until<T>(
	probe: () => T | undefined | false | null,
	what: string | (() => string),
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value as T;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
		}
		await Bun.sleep(50);
	}
}

async function recordedPid(file: string, what: string): Promise<number> {
	const text = await until(() => (existsSync(file) ? readFileSync(file, "utf8").trim() : undefined), what);
	const pid = Number(text);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${what} recorded ${JSON.stringify(text)}, not a pid`);
	return pid;
}

afterAll(async () => {
	for (const pid of stopped) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {}
	}
	reapPgids(pgids);
	// A moment for the SIGKILLs to land, so the next file does not start against this one's leftovers.
	await Bun.sleep(100);
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("psRows and the `-A` that must never be dropped", () => {
	test("reads the whole table with explicit `-A`, including a tty-less child", async () => {
		const child = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		const row = await until(() => rowFor(child.pid), `the fixture ${child.pid} to appear in ps -A`);

		expect(psRows().length).toBeGreaterThan(2);
		expect(PS_ROWS_COMMAND).toContain("-A");
		expect(rowFor(1)?.pid).toBe(1);
		expect(rowFor(process.pid)).toBeDefined();

		expect(row.pid).toBe(child.pid);
		expect(row.command).toContain("setTimeout");
		expect(row.pgid).toBe(child.pid);
		expect(row.ppid).toBe(process.pid);
		expect(isZombie(row)).toBe(false);

		child.kill("SIGKILL");
	}, 60_000);

	test("uniqueMarker cannot collide with a sibling agent, or with this machine's own table", () => {
		const first = uniqueMarker("helper-selftest");
		const second = uniqueMarker("helper-selftest");
		expect(first).not.toBe(second);
		expect(first).toContain(String(process.pid));
		expect(psRows().some((row) => row.command.includes(first))).toBe(false);
	});
});

describe("a killed group leaves a zombie, and only the Z filter knows it is dead", () => {
	test("liveGroupMembers is empty while the table still carries a defunct leader", async () => {
		const dir = tempDir("hzt-");
		const pidFile = join(dir, "leader.pid");
		// A parent that cannot reap, so the zombie window is indefinite rather than a race: it is SIGSTOPped below,
		// before anything is killed.
		const parent = fixture(
			[
				BUN,
				"-e",
				`const leader = Bun.spawn([process.env.BUN_BIN, "-e", "setTimeout(() => {}, 600000)"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
				 await Bun.write(process.env.PID_FILE, String(leader.pid));
				 await new Promise(() => {});`,
			],
			{ PATH: "/usr/bin:/bin", BUN_BIN: BUN, PID_FILE: pidFile },
		);
		const leaderPid = await recordedPid(pidFile, "the stopped parent's detached leader");
		pgids.add(leaderPid);
		await until(() => isProcessAlive(leaderPid), `the leader ${leaderPid} to be running`);

		process.kill(parent.pid, "SIGSTOP");
		stopped.push(parent.pid);

		process.kill(-leaderPid, "SIGKILL");
		const defunct = await until(() => {
			const row = rowFor(leaderPid);
			return row && isZombie(row) ? row : undefined;
		}, `the leader ${leaderPid} to become defunct`);

		expect(defunct.pgid).toBe(leaderPid);
		expect(defunct.command).toContain("defunct");
		expect(groupMembers(leaderPid).map((row) => row.pid)).toEqual([leaderPid]);

		expect(liveGroupMembers(leaderPid)).toEqual([]);

		expect(() => process.kill(leaderPid, 0)).not.toThrow();
		expect(isProcessAlive(leaderPid)).toBe(false);

		process.kill(parent.pid, "SIGCONT");
		parent.kill("SIGKILL");
	}, 90_000);

	test("waitForGroupGone returns once a group stops running, and reapPgids touches nothing else", async () => {
		const doomed = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		const bystander = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		await until(() => isProcessAlive(doomed.pid) && isProcessAlive(bystander.pid), "both fixtures to be running");

		reapPgids([doomed.pid]);
		await waitForGroupGone(doomed.pid, 20_000);

		expect(liveGroupMembers(doomed.pid)).toEqual([]);
		expect(isProcessAlive(bystander.pid)).toBe(true);
		bystander.kill("SIGKILL");
	}, 60_000);
});

describe("an environment you cannot see is not an absent environment", () => {
	test("envOf reads a bun child's environment; the canary and the positive control are both there", async () => {
		const canaryValue = uniqueMarker("must-not-cross");
		const controlValue = uniqueMarker("was-declared");
		const child = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], {
			PATH: "/usr/bin:/bin",
			HELPER_CANARY: canaryValue,
			HELPER_CONTROL: controlValue,
		});
		await until(() => isProcessAlive(child.pid), "the bun fixture to be running");

		const seen = envOf(child.pid);
		expect(seen.visible).toBe(true);
		if (!seen.visible) throw new Error("unreachable");
		expect(seen.env.get("HELPER_CANARY")).toBe(canaryValue);
		expect(seen.env.get("HELPER_CONTROL")).toBe(controlValue);

		expect(() =>
			assertEnvAbsent(child.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(/HELPER_CANARY/);

		expect(() => assertEnvAbsent(child.pid, ["NOT_PRESENT_ANYWHERE"], { name: "NO_SUCH_CONTROL" })).toThrow(
			PositiveControlMissingError,
		);
		expect(() =>
			assertEnvAbsent(child.pid, ["NOT_PRESENT_ANYWHERE"], { name: "HELPER_CONTROL", value: "some other value" }),
		).toThrow(PositiveControlMissingError);

		child.kill("SIGKILL");
	}, 60_000);

	test("a canary that arrived under a DIFFERENT name is caught by the value scan, which the name check cannot see", async () => {
		const canaryValue = uniqueMarker("must-not-cross");
		const controlValue = uniqueMarker("was-declared");
		const child = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], {
			PATH: "/usr/bin:/bin",
			HELPER_LEAKED_UNDER_ANOTHER_NAME: canaryValue,
			HELPER_CONTROL: controlValue,
		});
		await until(() => isProcessAlive(child.pid), "the renaming fixture to be running");

		const seen = envOf(child.pid);
		if (!seen.visible) throw new Error("unreachable: a bun child's environment is visible");
		expect(seen.env.has("HELPER_CANARY")).toBe(false);
		expect(seen.env.get("HELPER_LEAKED_UNDER_ANOTHER_NAME")).toBe(canaryValue);

		expect(() =>
			assertEnvAbsent(child.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(new RegExp(`contains the value planted as HELPER_CANARY.*${canaryValue}`));

		expect(() =>
			assertEnvAbsent(child.pid, ["HELPER_CANARY"], { name: "HELPER_CONTROL", value: controlValue }),
		).not.toThrow();

		// Both values are present verbatim in this environment; only the one of 8 characters or more is searched.
		expect(() => assertEnvAbsent(child.pid, { HELPER_SHORT: "/bin" }, { name: "HELPER_CONTROL" })).not.toThrow();
		expect(() => assertEnvAbsent(child.pid, { HELPER_LONG: "/usr/bin:/bin" }, { name: "HELPER_CONTROL" })).toThrow(
			/HELPER_LONG/,
		);

		child.kill("SIGKILL");
	}, 60_000);

	test("envOf reports /bin/sh visibility honestly on this platform", async () => {
		const canaryValue = uniqueMarker("sh-canary");
		const shell = fixture(["/bin/sh", "-c", "while :; do sleep 1; done"], {
			PATH: "/usr/bin:/bin",
			HELPER_CANARY: canaryValue,
			HELPER_CONTROL: uniqueMarker("was-declared"),
		});
		await until(() => isProcessAlive(shell.pid), "the /bin/sh fixture to be running");

		const seen = envOf(shell.pid);
		if (process.platform === "linux") {
			expect(seen.visible).toBe(true);
			if (!seen.visible) throw new Error("Linux procfs did not expose the shell environment");
			expect(seen.env.get("HELPER_CANARY")).toBe(canaryValue);
			expect(() => assertEnvAbsent(shell.pid, ["HELPER_CANARY"], { name: "HELPER_CONTROL" })).toThrow(
				/HELPER_CANARY/,
			);
		} else {
			expect(seen.visible).toBe(false);
			if (seen.visible) throw new Error("a protected shell unexpectedly exposed its environment");
			expect(seen.reason).toContain("no environment");
			expect(seen.raw).toContain("/bin/sh");
			expect(seen.raw).not.toContain(canaryValue);
			expect(() => assertEnvAbsent(shell.pid, ["HELPER_CANARY"], { name: "HELPER_CONTROL" })).toThrow(
				EnvironmentNotVisibleError,
			);
		}

		shell.kill("SIGKILL");
	}, 60_000);

	test("envOf on a pid the kernel does not know throws instead of reporting a clean environment", async () => {
		const gone = fixture([BUN, "-e", ""], { PATH: "/usr/bin:/bin" });
		await gone.exited;
		await until(() => rowFor(gone.pid) === undefined, `pid ${gone.pid} to leave the table`);
		expect(() => envOf(gone.pid)).toThrow(ProcessTableError);
	}, 60_000);
});

describe("descendantsOf, and a grandchild whose environment can actually be read", () => {
	test("finds a transitive child, and the canary absence is provable there because it is a bun process", async () => {
		const dir = tempDir("hgc-");
		const pidFile = join(dir, "grandchild.pid");
		const marker = uniqueMarker("helper-grandchild");
		const canaryValue = uniqueMarker("must-not-reach-the-grandchild");
		const controlValue = uniqueMarker("declared-for-the-grandchild");

		const parent = fixture(
			[
				BUN,
				"-e",
				`const child = Bun.spawn([process.env.BUN_BIN, "-e", "setTimeout(() => {}, 600000)", process.env.MARKER], {
					env: { PATH: "/usr/bin:/bin", HELPER_CONTROL: process.env.HELPER_CONTROL },
					stdin: "ignore", stdout: "ignore", stderr: "ignore",
				 });
				 await Bun.write(process.env.PID_FILE, String(child.pid));
				 await new Promise(() => {});`,
			],
			{
				PATH: "/usr/bin:/bin",
				BUN_BIN: BUN,
				PID_FILE: pidFile,
				MARKER: marker,
				HELPER_CANARY: canaryValue,
				HELPER_CONTROL: controlValue,
			},
		);
		const grandchildPid = await recordedPid(pidFile, "the fixture's grandchild");
		await until(() => isProcessAlive(grandchildPid), `the grandchild ${grandchildPid} to be running`);

		const descendants = descendantsOf(parent.pid);
		expect(descendants.map((row) => row.pid)).toContain(grandchildPid);
		expect(descendants.find((row) => row.pid === grandchildPid)?.command).toContain(marker);
		expect(descendantsOf(process.pid).map((row) => row.pid)).toContain(grandchildPid);
		expect(descendants.map((row) => row.pid)).not.toContain(1);

		const env = assertEnvAbsent(
			grandchildPid,
			{ HELPER_CANARY: canaryValue },
			{ name: "HELPER_CONTROL", value: controlValue },
		);
		expect(env.get("HELPER_CONTROL")).toBe(controlValue);
		expect(env.has("HELPER_CANARY")).toBe(false);
		expect(() =>
			assertEnvAbsent(parent.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(/HELPER_CANARY/);

		parent.kill("SIGKILL");
	}, 90_000);
});
