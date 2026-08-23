// R36-SPAWN.7 — the four named deadlines and the stop path, driven against real processes and read back
// through `ps`. Class 2: no daemon, no wire. Every subject process is one THIS spawner started, except the
// two cases whose whole point is a pid it did not.

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_HANDSHAKE_DEADLINE_MS,
	type ResolvedExecutable,
	SessionSpawner,
	SpawnRefusedError,
} from "../session/spawn-primitive.js";
import {
	descendantsOf,
	isProcessAlive,
	liveGroupMembers,
	reapPgids,
	rowFor,
	uniqueMarker,
	waitForGroupGone,
	waitForProcessesGone,
} from "./helpers/process-table.js";

const SPAWN_PRIMITIVE = join(import.meta.dir, "../session/spawn-primitive.ts");

const dirs: string[] = [];
const pgids = new Set<number>();
const strays = new Set<number>();

afterAll(() => {
	reapPgids(pgids);
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Directly under /tmp with a short name: a unix socket path over ~104 bytes fails to bind with EINVAL. */
function tempDir(): string {
	const dir = mkdtempSync("/tmp/sds-");
	dirs.push(dir);
	return dir;
}

interface Harness {
	spawner: SessionSpawner;
	session: { id: string; path: string; cwd: string };
	pidFile: string;
	dir: string;
}

/** A spawner whose executable is `script`. Everything past the injected `resolveExecutable` seam is production code. */
function harness(script: string, options: Partial<ConstructorParameters<typeof SessionSpawner>[0]> = {}): Harness {
	const dir = tempDir();
	const pidFile = join(dir, "pids");
	const scriptPath = join(dir, "child.sh");
	writeFileSync(scriptPath, script.replaceAll("PIDFILE", pidFile).replaceAll("DIR", dir), { mode: 0o755 });
	const resolveExecutable = (): ResolvedExecutable => ({
		executable: "/bin/sh",
		// A marker nothing else on this box carries, so a leaked row is identifiable in `ps`.
		leadingArgs: [scriptPath, uniqueMarker("sds")],
		target: scriptPath,
	});
	const spawner = new SessionSpawner({ socketDir: dir, agentDir: dir, resolveExecutable, ...options });
	return { spawner, session: { id: "sds-session", path: join(dir, "s.jsonl"), cwd: dir }, pidFile, dir };
}

/** The child writes its pids through a rename, so a read never sees half a file. */
async function readPids(pidFile: string, timeoutMs = 20_000): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(pidFile)) {
			const pids = readFileSync(pidFile, "utf8")
				.split("\n")
				.map((line) => Number(line.trim()))
				.filter((value) => Number.isInteger(value) && value > 1);
			if (pids.length > 0) return pids;
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${pidFile}`);
}

/** Reaped, not merely dead: the record keyed by a pid is dropped when the OS is free to reissue it. */
async function waitForReaped(pid: number, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (rowFor(pid) !== undefined) {
		if (Date.now() >= deadline)
			throw new Error(`timed out after ${timeoutMs} ms waiting for pid ${pid} to be reaped`);
		await Bun.sleep(25);
	}
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${path}`);
		await Bun.sleep(25);
	}
}

const FORKS_A_GRANDCHILD = `#!/bin/sh
sleep 3600 &
echo "$$" > PIDFILE.tmp
echo "$!" >> PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
wait
`;

/** Survives TERM for as long as you care to wait, which is the case a stop DEADLINE exists for. */
const TRAPS_TERM = `#!/bin/sh
trap 'echo t >> DIR/terms' TERM
echo "$$" > PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
while true; do sleep 0.2; done
`;

const SILENT_AND_BINDS_NOTHING = `#!/bin/sh
echo "$$" > PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
exec sleep 3600
`;

const SPOKE_ONCE = "draht stub: loading extensions, no socket yet";

const SPEAKS_THEN_GOES_QUIET = `#!/bin/sh
echo "$$" > PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
echo "${SPOKE_ONCE}" >&2
exec sleep 3600
`;

const FLOODS_STDOUT = `#!/bin/sh
echo "$$" > PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
dd if=/dev/zero bs=1048576 count=128 2>/dev/null
: > DIR/flooded
exec sleep 3600
`;

/** Publishes the lock and socket `resume` waits for, then exits leaving its group behind it. */
const BINDS_THEN_EXITS = `#!/bin/sh
sleep 3600 &
echo "$$" > PIDFILE.tmp
echo "$!" >> PIDFILE.tmp
mv PIDFILE.tmp PIDFILE
echo "$$" > DIR/sds-session.lock
: > DIR/sds-session.sock
exit 0
`;

/**
 * Run in a process of its OWN, because the mistake it guards against is `kill(0, …)`, which signals the
 * CALLER's process group — in-process that is this test runner and everything sharing its group.
 */
const GROUP_GUARD_PROBE = `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { SessionSpawner } from "SPAWN_PRIMITIVE";

const [mode, siblingPidFile, tripwire] = process.argv.slice(2);
process.on("SIGTERM", () => {});
spawn("/bin/sh", ["-c", 'echo $$ > "$SIB".tmp; mv "$SIB".tmp "$SIB"; exec sleep 120'], {
	stdio: "ignore",
	env: { ...process.env, SIB: siblingPidFile },
});
while (!existsSync(siblingPidFile)) await new Promise((done) => setTimeout(done, 25));

let outcome = "resolved";
if (mode === "control") process.kill(0, "SIGTERM");
else {
	try {
		await new SessionSpawner({ socketDir: "/tmp", agentDir: "/tmp", stopDeadlineMs: 100 }).stop(0);
	} catch (error) {
		outcome = (error as Error).name;
	}
}
writeFileSync(tripwire, outcome);
`;

async function groupGuardProbe(mode: "guarded" | "control"): Promise<{ sibling: number; outcome: string }> {
	const dir = tempDir();
	const scriptPath = join(dir, "probe.ts");
	writeFileSync(scriptPath, GROUP_GUARD_PROBE.replace("SPAWN_PRIMITIVE", SPAWN_PRIMITIVE));
	const siblingPidFile = join(dir, "sibling");
	const tripwire = join(dir, "outcome");
	const probe = spawn(process.execPath, [scriptPath, mode, siblingPidFile, tripwire], {
		detached: true,
		stdio: "ignore",
	});
	if (probe.pid !== undefined) pgids.add(probe.pid);
	const [sibling] = (await readPids(siblingPidFile)) as [number];
	await waitForFile(tripwire, 30_000);
	return { sibling, outcome: readFileSync(tripwire, "utf8") };
}

async function refusalOf(pending: Promise<unknown>): Promise<SpawnRefusedError> {
	try {
		await pending;
	} catch (error) {
		if (error instanceof SpawnRefusedError) return error;
		throw error;
	}
	throw new Error("expected a SpawnRefusedError, and the call resolved");
}

test("stop() reaches the whole group of a detached child, grandchild included", async () => {
	const { spawner, session, pidFile } = harness(FORKS_A_GRANDCHILD);
	// `resume` runs unawaited — it is what records the pid as group-signallable, and it is still polling for a
	// socket that never appears while `stop` runs. Its rejection handler is attached NOW: a rejection arriving
	// while this test awaits something else is an unhandled rejection, which bun blames on whatever ran next.
	const refused = refusalOf(spawner.resume(session));
	const [leader, grandchild] = (await readPids(pidFile)) as [number, number];
	pgids.add(leader);

	expect(rowFor(leader)?.pgid).toBe(leader);
	expect(descendantsOf(leader).map((row) => row.pid)).toContain(grandchild);
	expect(isProcessAlive(grandchild)).toBe(true);

	await spawner.stop(leader);
	await waitForGroupGone(leader);
	expect(liveGroupMembers(leader)).toEqual([]);
	expect(isProcessAlive(grandchild)).toBe(false);

	expect((await refused).code).toBe("spawn_failed");
}, 120_000);

test("stop() signals the bare pid of a child spawned undetached, sparing the group it shares", async () => {
	const { spawner, session, pidFile } = harness(FORKS_A_GRANDCHILD, { detached: false, stopDeadlineMs: 500 });
	const refused = refusalOf(spawner.resume(session));
	const [leader, grandchild] = (await readPids(pidFile)) as [number, number];
	strays.add(grandchild);

	// Undetached, the child is in the DAEMON'S group — here, this test runner's. That is what makes a
	// `-pid` signal for such a child wrong, and it is the state `groupSignallable` is read at spawn to record.
	expect(rowFor(leader)?.pgid).toBe(rowFor(process.pid)?.pgid);
	expect(descendantsOf(leader).map((row) => row.pid)).toContain(grandchild);

	await spawner.stop(leader);
	await waitForProcessesGone([leader]);
	expect(isProcessAlive(leader)).toBe(false);
	expect(isProcessAlive(grandchild)).toBe(true);

	expect((await refused).code).toBe("spawn_failed");
	process.kill(grandchild, "SIGKILL");
}, 120_000);

test("stop() signals only the bare pid of a process it did NOT start, leaving that group alone", async () => {
	const dir = tempDir();
	const pidFile = join(dir, "pids");
	const scriptPath = join(dir, "stranger.sh");
	writeFileSync(scriptPath, FORKS_A_GRANDCHILD.replaceAll("PIDFILE", pidFile), { mode: 0o755 });
	const stranger = Bun.spawn(["/bin/sh", scriptPath], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const [leader, grandchild] = (await readPids(pidFile)) as [number, number];
	strays.add(grandchild);

	expect(rowFor(leader)?.pgid).toBe(rowFor(process.pid)?.pgid);
	expect(descendantsOf(leader).map((row) => row.pid)).toContain(grandchild);

	const { spawner } = harness(SILENT_AND_BINDS_NOTHING, { stopDeadlineMs: 500 });
	await spawner.stop(leader);

	expect(isProcessAlive(leader)).toBe(false);
	expect(isProcessAlive(grandchild)).toBe(true);
	process.kill(grandchild, "SIGKILL");
	stranger.kill("SIGKILL");
}, 120_000);

test("stop(0) signals nothing, where an unguarded one would signal the caller's own group", async () => {
	const control = await groupGuardProbe("control");
	await waitForProcessesGone([control.sibling], 10_000);
	expect(isProcessAlive(control.sibling)).toBe(false);

	const guarded = await groupGuardProbe("guarded");
	expect(guarded.outcome).toBe("RangeError");
	expect(isProcessAlive(guarded.sibling)).toBe(true);
}, 120_000);

test("stop() refuses a pid that names no process", async () => {
	const { spawner } = harness(SILENT_AND_BINDS_NOTHING);
	// 0 and -1 are deliberately not passed IN-PROCESS: unguarded they signal this runner's own group and
	// every process this uid owns. The 0 case has its own test above, in a process of its own.
	for (const pid of [1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await expect(spawner.stop(pid)).rejects.toThrow(RangeError);
	}
});

test("a child that traps TERM is alive before the stop deadline and dead soon after it", async () => {
	const stopDeadlineMs = 3_000;
	const { spawner, session, pidFile } = harness(TRAPS_TERM, { stopDeadlineMs });
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const started = Date.now();
	const stopping = spawner.stop(leader);
	await Bun.sleep(stopDeadlineMs / 2);
	expect(isProcessAlive(leader)).toBe(true);

	await stopping;
	await waitForGroupGone(leader);
	const elapsed = Date.now() - started;
	expect(isProcessAlive(leader)).toBe(false);
	expect(elapsed).toBeGreaterThanOrEqual(stopDeadlineMs - 50);
	expect(elapsed).toBeLessThan(stopDeadlineMs * 2 - 400);

	await refused;
}, 120_000);

test("two overlapping stops send one TERM, and a stop after the child is gone returns without waiting", async () => {
	const stopDeadlineMs = 2_000;
	const { spawner, session, pidFile, dir } = harness(TRAPS_TERM, { stopDeadlineMs });
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const first = spawner.stop(leader);
	await Bun.sleep(400);
	await Promise.all([first, spawner.stop(leader)]);
	await waitForGroupGone(leader);
	expect(readFileSync(join(dir, "terms"), "utf8").trim().split("\n")).toEqual(["t"]);

	// The resume's own teardown joins the same record, so it is no second TERM either.
	await refused;
	expect(existsSync(join(dir, "terms"))).toBe(true);
	expect(readFileSync(join(dir, "terms"), "utf8").trim().split("\n")).toEqual(["t"]);

	const startedRepeat = Date.now();
	await spawner.stop(leader);
	expect(Date.now() - startedRepeat).toBeLessThan(stopDeadlineMs / 2);
}, 120_000);

test("a tiny handshake deadline refuses timeout, says the child was silent, and leaves nothing alive", async () => {
	const handshakeDeadlineMs = 1_200;
	const { spawner, session, pidFile } = harness(SILENT_AND_BINDS_NOTHING, {
		handshakeDeadlineMs,
		stopDeadlineMs: 300,
	});
	const started = Date.now();
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const refusal = await refused;
	const elapsed = Date.now() - started;
	expect(refusal.code).toBe("timeout");
	// The first-output deadline was left at its 30 s default while this child said nothing for 1.2 s, so what
	// ended the wait was the handshake deadline. That is the whole of "off by default".
	expect(refusal.message).toContain(`did not publish its socket within ${handshakeDeadlineMs} ms`);
	expect(refusal.message).toContain("and never said a word");
	expect(elapsed).toBeGreaterThanOrEqual(handshakeDeadlineMs);
	expect(elapsed).toBeLessThan(20_000);

	await waitForGroupGone(leader);
	expect(liveGroupMembers(leader)).toEqual([]);
}, 120_000);

test("a first-output deadline set below the handshake deadline ends a silent child's wait", async () => {
	const firstOutputDeadlineMs = 600;
	const { spawner, session, pidFile } = harness(SILENT_AND_BINDS_NOTHING, {
		firstOutputDeadlineMs,
		handshakeDeadlineMs: 60_000,
		stopDeadlineMs: 300,
	});
	const started = Date.now();
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const refusal = await refused;
	expect(refusal.code).toBe("timeout");
	expect(refusal.message).toContain(`published no socket and never said a word within ${firstOutputDeadlineMs} ms`);
	expect(Date.now() - started).toBeLessThan(10_000);

	await waitForGroupGone(leader);
}, 120_000);

test("a child that writes one line to stderr outlives a first-output deadline it beat", async () => {
	const handshakeDeadlineMs = 4_000;
	const { spawner, session, pidFile } = harness(SPEAKS_THEN_GOES_QUIET, {
		firstOutputDeadlineMs: 1_500,
		handshakeDeadlineMs,
		stopDeadlineMs: 300,
	});
	const started = Date.now();
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const refusal = await refused;
	const elapsed = Date.now() - started;
	expect(refusal.code).toBe("timeout");
	expect(refusal.message).toContain(`did not publish its socket within ${handshakeDeadlineMs} ms`);
	expect(refusal.message).toContain(`after printing: ${SPOKE_ONCE}`);
	expect(refusal.message).not.toContain("never said a word");
	expect(elapsed).toBeGreaterThanOrEqual(handshakeDeadlineMs);

	await waitForGroupGone(leader);
	expect(liveGroupMembers(leader)).toEqual([]);
}, 120_000);

test("the deadlineMs and teardownGraceMs aliases still reach the handshake and stop deadlines", async () => {
	const deadlineMs = 1_200;
	const teardownGraceMs = 3_000;
	const { spawner, session, pidFile } = harness(TRAPS_TERM, { deadlineMs, teardownGraceMs });
	const started = Date.now();
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);

	const refusal = await refused;
	const elapsed = Date.now() - started;
	expect(refusal.code).toBe("timeout");
	expect(refusal.message).toContain(`did not publish its socket within ${deadlineMs} ms`);
	// The child traps TERM, so the teardown cannot finish before the grace window it was given has run:
	// an alias that stopped reaching the stop deadline shows up here as ~3 s too fast.
	expect(elapsed).toBeGreaterThanOrEqual(deadlineMs + teardownGraceMs - 200);
	expect(elapsed).toBeLessThan(deadlineMs + teardownGraceMs * 2 - 400);

	await waitForGroupGone(leader);
	expect(isProcessAlive(leader)).toBe(false);
}, 120_000);

test("a spawn that yields no pid is refused with what the failed spawn reported", async () => {
	const dir = tempDir();
	const missing = join(dir, "not-a-binary");
	const spawner = new SessionSpawner({
		socketDir: dir,
		agentDir: dir,
		spawnDeadlineMs: 5_000,
		resolveExecutable: () => ({ executable: missing, leadingArgs: [], target: missing }),
	});

	const started = Date.now();
	const refusal = await refusalOf(spawner.resume({ id: "sds-session", path: join(dir, "s.jsonl"), cwd: dir }));
	const elapsed = Date.now() - started;
	expect(refusal.code).toBe("spawn_failed");
	expect(refusal.message).toContain("within 5000 ms");
	// The wait loop is what lets the asynchronous `error` event land before the message is built; without it
	// the refusal quotes an empty stderr, and the deadline it names is one nothing ever waits for.
	expect(refusal.message).toContain("ENOENT");
	expect(elapsed).toBeLessThan(3_000);
}, 120_000);

test("the daemon holds none of a child's stdout, which it would if that stream were piped", async () => {
	const { spawner, session, pidFile, dir } = harness(FLOODS_STDOUT, {
		handshakeDeadlineMs: 8_000,
		stopDeadlineMs: 300,
	});
	const before = process.memoryUsage().rss;
	const refused = refusalOf(spawner.resume(session));
	const [leader] = (await readPids(pidFile)) as [number];
	pgids.add(leader);
	await waitForFile(join(dir, "flooded"), 30_000);
	const ignoredMB = (process.memoryUsage().rss - before) / 1e6;

	// POSITIVE CONTROL: the same 128 MB through a pipe nobody reads. Bun BUFFERS such a pipe rather than
	// letting it fill and block the child, so what piping stdout costs is this process's memory — and the
	// measurement above can see that cost, which is the only reason its smallness means anything.
	const controlBefore = process.memoryUsage().rss;
	const piped = spawn("/bin/sh", ["-c", "dd if=/dev/zero bs=1048576 count=128 2>/dev/null"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise((done) => piped.once("exit", done));
	const pipedMB = (process.memoryUsage().rss - controlBefore) / 1e6;

	expect(pipedMB).toBeGreaterThan(50);
	expect(ignoredMB).toBeLessThan(30);
	expect(ignoredMB).toBeLessThan(pipedMB / 4);

	expect((await refused).code).toBe("timeout");
	await waitForGroupGone(leader);
}, 120_000);

test("a stop after the child was reaped signals the bare pid, not a group that pid may no longer lead", async () => {
	const { spawner, session, pidFile } = harness(BINDS_THEN_EXITS, { stopDeadlineMs: 300 });
	const outcome = await spawner.resume(session);
	const [leader, grandchild] = (await readPids(pidFile)) as [number, number];
	strays.add(grandchild);
	expect(outcome.pid).toBe(leader);

	await waitForReaped(leader);
	// POSITIVE CONTROL: the group outlived its leader and a `-pid` signal would still reach into it.
	expect(isProcessAlive(grandchild)).toBe(true);
	expect(rowFor(grandchild)?.pgid).toBe(leader);

	await spawner.stop(leader);
	await Bun.sleep(500);
	expect(isProcessAlive(grandchild)).toBe(true);
	process.kill(grandchild, "SIGKILL");
}, 120_000);

test("the handshake deadline still defaults to the 30 s session-resume.e2e is budgeted for", () => {
	expect(DEFAULT_HANDSHAKE_DEADLINE_MS).toBe(30_000);
});
