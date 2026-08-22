/**
 * The process-table oracle, tested against real processes.
 *
 * Seven acceptance suites in this phase decide whether a requirement holds by
 * asking `helpers/process-table.ts` a question. That makes the helper itself a
 * single point of failure of a very specific kind: every way of reading `ps`
 * wrongly fails OPEN. A scan without `-A` reports every detached child as
 * absent; an unfiltered group scan reports a killed group as alive; an
 * environment read against a SIP binary reports every canary as absent. In all
 * three the mistake makes assertions PASS, so nothing downstream would ever
 * notice.
 *
 * So this file does not test the helper against a mock. It spawns real
 * processes, puts them into the exact states the helper exists to distinguish —
 * tty-less, defunct-but-not-reaped, environment-visible, environment-invisible —
 * and asserts BOTH halves each time: that the helper answers correctly AND that
 * the naive form it replaces answers wrongly on the same process. The second
 * half is what stops a later "simplification" from quietly removing the reason
 * these helpers are shaped the way they are.
 *
 * CLASS-3 HYGIENE, which this file is the source of for the rest of the phase:
 * every fixture is spawned `detached: true` so it owns its process group, every
 * group is recorded before it is used, `afterAll` reaps only recorded pgids, and
 * every marker is unique to this run so nothing here can match — or kill — a
 * sibling agent's e2e on the same machine.
 */

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
	psRows,
	reapPgids,
	rowFor,
	uniqueMarker,
	waitForGroupGone,
} from "./helpers/process-table.js";

/** Process groups this run created. `afterAll` reaps exactly these and nothing else. */
const pgids = new Set<number>();
const cleanup: string[] = [];
/** Stopped fixtures must be continued before they can die. */
const stopped: number[] = [];

/** The bun binary running this test, absolute — so no fixture needs a PATH. */
const BUN = process.execPath;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanup.push(dir);
	return dir;
}

/**
 * Spawn a fixture in its OWN process group and record the group.
 *
 * `detached: true` is not a detail here: it is what gives the child its own
 * session (hence no controlling terminal, hence the `-A` case below) and its own
 * pgid (hence a reap that cannot reach anything this run did not start).
 */
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

/** The pid a fixture wrote for a child this test cannot get a handle to. */
async function recordedPid(file: string, what: string): Promise<number> {
	const text = await until(() => (existsSync(file) ? readFileSync(file, "utf8").trim() : undefined), what);
	const pid = Number(text);
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${what} recorded ${JSON.stringify(text)}, not a pid`);
	return pid;
}

/** `ps` WITHOUT `-A` — the form every assertion in this phase is forbidden to use. */
function pidsWithoutDashA(): number[] {
	const out = Bun.spawnSync(["ps", "-wwo", "pid="]);
	return out.stdout
		.toString()
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

afterAll(async () => {
	for (const pid of stopped) {
		try {
			process.kill(pid, "SIGCONT");
		} catch {
			// Already gone.
		}
	}
	reapPgids(pgids);
	// A stopped process cannot act on a SIGTERM, and a group whose leader is a
	// zombie is not gone until its parent dies too. Reaped with SIGKILL above,
	// then given a moment so the next file does not start against this one's
	// leftovers.
	await Bun.sleep(100);
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("psRows and the `-A` that must never be dropped", () => {
	test("reads the whole table, and finds a tty-less child that the non-`-A` form misses", async () => {
		const child = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		const row = await until(() => rowFor(child.pid), `the fixture ${child.pid} to appear in ps -A`);

		// The whole machine, not this terminal's corner of it.
		expect(psRows().length).toBeGreaterThan(50);
		expect(rowFor(1)?.pid).toBe(1);
		expect(rowFor(process.pid)).toBeDefined();

		expect(row.pid).toBe(child.pid);
		expect(row.command).toContain("setTimeout");
		// `detached: true` gives it its own session and group but keeps this
		// process as its parent — the property that makes `descendantsOf` a sound
		// scope for a negative on darwin.
		expect(row.pgid).toBe(child.pid);
		expect(row.ppid).toBe(process.pid);
		expect(isZombie(row)).toBe(false);

		// ── AND THE NAIVE FORM IS WRONG ABOUT THE SAME PROCESS ────────────────
		// Not decoration: this is the entire argument for `-A`. Without it the
		// child is invisible, and every "no process was created" assertion in this
		// phase would be satisfied by a process that was, in fact, created.
		expect(pidsWithoutDashA()).not.toContain(child.pid);

		child.kill("SIGKILL");
	}, 60_000);

	test("uniqueMarker cannot collide with a sibling agent, or with this machine's own table", () => {
		const first = uniqueMarker("helper-selftest");
		const second = uniqueMarker("helper-selftest");
		expect(first).not.toBe(second);
		expect(first).toContain(String(process.pid));
		// The property that matters: nothing already running carries it, so a scan
		// for it is a statement about this run rather than about the box.
		expect(psRows().some((row) => row.command.includes(first))).toBe(false);
	});
});

describe("a killed group leaves a zombie, and only the Z filter knows it is dead", () => {
	test("liveGroupMembers is empty while the table still carries a defunct leader", async () => {
		const dir = tempDir("hzt-");
		const pidFile = join(dir, "leader.pid");
		// A parent that CANNOT reap, so the zombie window is indefinite rather than
		// a race: it is SIGSTOPped below, before anything is killed. Under a running
		// bun parent the same row disappears within a poll — which is exactly why a
		// suite that waits for the unfiltered group to empty is waiting on the
		// PARENT'S schedule and not on the kill.
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

		// Freeze the only process that could reap it.
		process.kill(parent.pid, "SIGSTOP");
		stopped.push(parent.pid);

		process.kill(-leaderPid, "SIGKILL");
		const defunct = await until(() => {
			const row = rowFor(leaderPid);
			return row && isZombie(row) ? row : undefined;
		}, `the leader ${leaderPid} to become defunct`);

		// ── THE TRAP, SHOWN ───────────────────────────────────────────────────
		// The group is NOT empty: the leader is still in the table, still carrying
		// its pgid. A test asserting "no row carries this pgid" would fail here,
		// and would keep failing until a process it does not control got round to
		// reaping — in-process state let in through the back door.
		expect(defunct.pgid).toBe(leaderPid);
		expect(defunct.command).toContain("defunct");
		expect(groupMembers(leaderPid).map((row) => row.pid)).toEqual([leaderPid]);

		// ── THE HELPER, CORRECT ───────────────────────────────────────────────
		expect(liveGroupMembers(leaderPid)).toEqual([]);

		// ── AND `kill(pid, 0)` LIES ABOUT THE SAME PROCESS ────────────────────
		// `session-resume.e2e.test.ts:188`'s `alive()` is this call. It reports a
		// process that has already exited as running, so `until(() => !alive(pid))`
		// waits for a reap rather than for a death.
		expect(() => process.kill(leaderPid, 0)).not.toThrow();
		expect(isProcessAlive(leaderPid)).toBe(false);

		process.kill(parent.pid, "SIGCONT");
		parent.kill("SIGKILL");
	}, 90_000);

	test("waitForGroupGone returns once a group stops running, and reapPgids touches nothing else", async () => {
		const doomed = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		const bystander = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], { PATH: "/usr/bin:/bin" });
		await until(() => isProcessAlive(doomed.pid) && isProcessAlive(bystander.pid), "both fixtures to be running");

		// Only the recorded pgid — never a pattern. Several agents run draht e2es
		// on this machine at once and `pkill -f` would reap their sessions.
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

		// assertEnvAbsent must FAIL against a process that really does carry the
		// canary. Without this, "it passed" would say nothing about whether it can
		// see anything at all.
		expect(() =>
			assertEnvAbsent(child.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(/HELPER_CANARY/);

		// And it must refuse to conclude anything when the control is missing,
		// even though the name asked about genuinely is absent from this process.
		expect(() => assertEnvAbsent(child.pid, ["NOT_PRESENT_ANYWHERE"], { name: "NO_SUCH_CONTROL" })).toThrow(
			PositiveControlMissingError,
		);
		// A control that exists with the wrong value is not a control either: it
		// would mean this ps output is describing some other process.
		expect(() =>
			assertEnvAbsent(child.pid, ["NOT_PRESENT_ANYWHERE"], { name: "HELPER_CONTROL", value: "some other value" }),
		).toThrow(PositiveControlMissingError);

		child.kill("SIGKILL");
	}, 60_000);

	test("a canary that arrived under a DIFFERENT name is caught by the value scan, which the name check cannot see", async () => {
		const canaryValue = uniqueMarker("must-not-cross");
		const controlValue = uniqueMarker("was-declared");
		// The leak this test is about: the secret DID cross, but not under the name
		// the harness planted it as. A spawner that renames as it forwards — or a
		// wrapper that re-exports one variable's contents under its own name — moves
		// the exact bytes across the boundary while leaving the ORIGINAL name absent
		// from the child. A name-only check calls that clean.
		const child = fixture([BUN, "-e", "setTimeout(() => {}, 600000)"], {
			PATH: "/usr/bin:/bin",
			HELPER_LEAKED_UNDER_ANOTHER_NAME: canaryValue,
			HELPER_CONTROL: controlValue,
		});
		await until(() => isProcessAlive(child.pid), "the renaming fixture to be running");

		// The precondition, stated rather than assumed: the NAME really is absent,
		// so the name loop passes and only the value scan can reach a verdict.
		const seen = envOf(child.pid);
		if (!seen.visible) throw new Error("unreachable: a bun child's environment is visible");
		expect(seen.env.has("HELPER_CANARY")).toBe(false);
		expect(seen.env.get("HELPER_LEAKED_UNDER_ANOTHER_NAME")).toBe(canaryValue);

		// ── THE RECORD FORM CATCHES IT ────────────────────────────────────────
		// Given values, the VALUES are searched in the raw ps bytes. The message
		// names the canary it was planted as, not the name it arrived under, since
		// the caller only ever knew the former.
		expect(() =>
			assertEnvAbsent(child.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(new RegExp(`contains the value planted as HELPER_CANARY.*${canaryValue}`));

		// ── AND THE NAME-ONLY FORM DOES NOT ───────────────────────────────────
		// This is why every canary task in this phase is told to pass the RECORD
		// form. The array form is not a shorthand for the same assertion: against
		// this very process it returns cleanly, having proved only that one
		// particular spelling is absent.
		expect(() =>
			assertEnvAbsent(child.pid, ["HELPER_CANARY"], { name: "HELPER_CONTROL", value: controlValue }),
		).not.toThrow();

		// The length guard, shown on the same process so it cannot be mistaken for
		// the scan being off: a short value is not searched, because a 1–7 character
		// literal matches somewhere in almost every process's environment and would
		// make this assertion fire on noise. `PATH`'s value is present verbatim.
		expect(() => assertEnvAbsent(child.pid, { HELPER_SHORT: "/bin" }, { name: "HELPER_CONTROL" })).not.toThrow();
		expect(() => assertEnvAbsent(child.pid, { HELPER_LONG: "/usr/bin:/bin" }, { name: "HELPER_CONTROL" })).toThrow(
			/HELPER_LONG/,
		);

		child.kill("SIGKILL");
	}, 60_000);

	test("envOf on /bin/sh reports 'not visible' — it does NOT report an empty environment", async () => {
		const canaryValue = uniqueMarker("sh-canary");
		// The canary IS in this process's environment. macOS will not show it,
		// because /bin/sh is a SIP-protected platform binary — and that is the
		// whole point: a helper that returned an empty map here would let a caller
		// conclude the canary did not cross, about a process it definitely
		// crossed into. A grandchild canary read off a shell is vacuously green
		// forever, which is why R36-SPAWN.4's canary must use a bun/node
		// grandchild.
		const shell = fixture(["/bin/sh", "-c", "while :; do sleep 1; done"], {
			PATH: "/usr/bin:/bin",
			HELPER_CANARY: canaryValue,
			HELPER_CONTROL: uniqueMarker("was-declared"),
		});
		await until(() => isProcessAlive(shell.pid), "the /bin/sh fixture to be running");

		const seen = envOf(shell.pid);
		expect(seen.visible).toBe(false);
		if (seen.visible) throw new Error("unreachable");
		expect(seen.reason).toContain("no environment");
		// argv came through, so the process was found and the read did happen.
		expect(seen.raw).toContain("/bin/sh");
		expect(seen.raw).not.toContain(canaryValue);

		// An absence claim against it is refused rather than granted.
		expect(() => assertEnvAbsent(shell.pid, ["HELPER_CANARY"], { name: "HELPER_CONTROL" })).toThrow(
			EnvironmentNotVisibleError,
		);

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

		// The parent carries the canary. The grandchild is given a BUILT
		// environment that does not — the same shape the spawn primitive uses —
		// so "absent from the grandchild" is a real fact about a real boundary
		// rather than an artifact of the reader.
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
		// Two hops from here, so this is genuinely transitive rather than a child
		// lookup with a longer name.
		expect(descendantsOf(process.pid).map((row) => row.pid)).toContain(grandchildPid);
		// And the scope is a scope: a process this run did not start is not in it.
		expect(descendants.map((row) => row.pid)).not.toContain(1);

		// ── THE PATTERN WAVE 5 USES ───────────────────────────────────────────
		// Absence, with a positive control, against a binary whose environment the
		// platform will actually show.
		const env = assertEnvAbsent(
			grandchildPid,
			{ HELPER_CANARY: canaryValue },
			{ name: "HELPER_CONTROL", value: controlValue },
		);
		expect(env.get("HELPER_CONTROL")).toBe(controlValue);
		expect(env.has("HELPER_CANARY")).toBe(false);
		// The same canary IS visible one process up, so the boundary is what made
		// the difference — not the reader, and not the fact that nothing is ever
		// visible.
		expect(() =>
			assertEnvAbsent(parent.pid, { HELPER_CANARY: canaryValue }, { name: "HELPER_CONTROL", value: controlValue }),
		).toThrow(/HELPER_CANARY/);

		parent.kill("SIGKILL");
	}, 90_000);
});
