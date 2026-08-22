/**
 * The OS process table, read the only way that survives review.
 *
 * Every class-3 claim in Phase 36 is a claim about processes: that one was
 * started, that one was not, that a whole group died, that a name did not cross
 * into a child's environment. The daemon's own bookkeeping cannot answer any of
 * them — a spawner that forgot a child reports the same thing as a spawner that
 * never made one — so the oracle is `ps`, and the way `ps` is called is itself
 * load-bearing. Four separate ways of getting it wrong were measured on this
 * machine before this module was written, and each one has a countermeasure
 * here:
 *
 *   1. **`-A` IS MANDATORY.** Without it `ps` lists only processes attached to
 *      the caller's controlling terminal. Every process this phase cares about
 *      is spawned `detached: true`, which calls `setsid()` and therefore has NO
 *      controlling terminal — measured: a live `bun` child appeared in
 *      `ps -Awwo …` and was absent from `ps -wwo …`, whose whole listing was
 *      122 rows against 1120. A scan without `-A` reports every detached child
 *      as "no such process", which turns every negative assertion green.
 *
 *   2. **A ZOMBIE IS NOT A LIVE PROCESS, AND `kill(pid, 0)` CANNOT TELL.**
 *      Immediately after `killpg(pgid, SIGKILL)` the group leader stays in the
 *      table as `Z  <defunct>`, keeping its pid, ppid and pgid, until its parent
 *      reaps it. Measured, with a stopped parent so the window is indefinite:
 *      unfiltered the group still had `(36443, 36442, 36443, 'Z', '<defunct>')`
 *      in it; Z-filtered it was empty. So "no row carries this pgid" is FALSE
 *      for a window whose length is the spawner's own reaping schedule — which
 *      is in-process state let back in through the back door — and
 *      `process.kill(pid, 0)` SUCCEEDS on that zombie, so the `alive()` helper
 *      in `session-resume.e2e.test.ts:188` reports a dead process as alive.
 *      {@link isProcessAlive} reads `stat=` instead.
 *
 *   3. **AN ENVIRONMENT YOU CANNOT SEE IS NOT AN ABSENT ENVIRONMENT.** macOS
 *      exposes a child's full environment through `ps -Eww` for ordinary
 *      binaries (`bun`, `node` and Homebrew `python3` all showed a planted
 *      canary) and NOTHING for SIP-protected platform binaries: `/bin/sh`,
 *      `/bin/bash` and `/bin/sleep` return argv and zero environment bytes —
 *      measured, `/bin/sh -c 'while :; do sleep 1; done'` gave 37 bytes, all of
 *      them argv. A canary assertion against a `/bin/sh` grandchild is therefore
 *      VACUOUSLY GREEN FOREVER. {@link envOf} returns a discriminated result
 *      rather than an empty map, and {@link assertEnvAbsent} refuses to conclude
 *      anything without a POSITIVE CONTROL: a name the harness DID declare,
 *      found in the same `ps` output, before any absence is believed.
 *
 *   4. **A REAP MUST NAME ITS TARGETS.** `pkill -f <pattern>` on a shared
 *      machine kills whatever else matched — several agents run draht e2es on
 *      this box concurrently. {@link reapPgids} signals only process groups the
 *      caller recorded, and {@link uniqueMarker} exists so that any scan for a
 *      literal is scoped to one run of one file.
 *
 * ## There is no exec oracle on this machine, and "no process was created"
 *
 * SIP is enabled here (`csrutil status` → enabled) and dtrace refuses to
 * initialise, so nothing can observe an `execve` that happened. A scan of the
 * process table cannot prove a process was never created: a process that execs
 * and exits between the refusal and the sample is invisible to every sample. A
 * machine-wide scan for a literal is worse than useless — it is also a race
 * against sibling agents, which is how a Phase 35 test went flaky.
 *
 * The only race-immune negatives available are therefore:
 *
 *   • a TRIPWIRE FILE the fixture itself writes when it runs (a shim that would
 *     have been resolved off `PATH`, an extension that would have loaded) —
 *     absence of the file is a claim about the whole window, not about a sample;
 *   • a SCOPE the caller holds: {@link descendantsOf} of a pid it spawned, or
 *     {@link liveGroupMembers} of a pgid it recorded. `detached: true` does NOT
 *     reparent on darwin — measured, a detached child had `pgid == pid` and kept
 *     `ppid = spawner` — so the daemon's descendants remain a sound, race-free
 *     scope for "this daemon started nothing else".
 *
 * Nothing in this module imports gateway source. It reads the kernel's view.
 */

import { randomBytes } from "node:crypto";

/** One row of `ps -Awwo pid=,ppid=,pgid=,stat=,command=`. */
export interface ProcessRow {
	pid: number;
	/** Parent. Still meaningful for a zombie, which is how a reaping race is seen. */
	ppid: number;
	/** Process GROUP. What `killpg` addresses, and what a teardown must clear. */
	pgid: number;
	/** `ps` state field: `S`, `Ss`, `R+`, `Z`, … A `Z` anywhere means defunct. */
	stat: string;
	/** Full argv as the kernel holds it, `<defunct>` for a zombie. */
	command: string;
	/** The whole row, kept so a failure message can show what was actually seen. */
	raw: string;
}

/**
 * Raised when the process table could not be read or understood at all.
 *
 * Distinct from an empty result, exactly as `ListenerEnumerationError` is in
 * `listening-sockets.ts`: a caller that catches this and continues has turned
 * "the oracle is broken" into "the thing I was looking for is absent", which is
 * the failure mode this whole module exists to prevent.
 */
export class ProcessTableError extends Error {
	override readonly name = "ProcessTableError";
}

/** Raised when an environment was asked for and the platform will not show it. */
export class EnvironmentNotVisibleError extends Error {
	override readonly name = "EnvironmentNotVisibleError";
}

/**
 * Raised when an absence was asserted without a working oracle.
 *
 * The positive control is not a formality. `ps -Eww` on a SIP platform binary
 * returns argv and no environment; without a control, "the canary is not in this
 * output" is true of every SIP binary forever, whatever the child's environment
 * actually contains.
 */
export class PositiveControlMissingError extends Error {
	override readonly name = "PositiveControlMissingError";
}

/** `ps` right-aligns the numeric columns and pads `stat`; the command is the rest of the line. */
const ROW = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s+(?<stat>\S+)\s*(?<command>.*)$/;

/**
 * Every process on this machine, as five parsed fields.
 *
 * `-A` for the reason at the top of this file, `-ww` so a long argv is not
 * truncated (a truncated argv makes `command.includes(marker)` false for exactly
 * the long command lines this phase spawns). One call per sample: helpers below
 * accept the rows so that several assertions can be made against ONE consistent
 * view of the table rather than against three different instants.
 */
export function psRows(): ProcessRow[] {
	const out = Bun.spawnSync(["ps", "-Awwo", "pid=,ppid=,pgid=,stat=,command="]);
	if (!out.success) {
		throw new ProcessTableError(`ps -A exited ${out.exitCode}: ${out.stderr.toString().trim()}`);
	}
	const text = out.stdout.toString();
	const rows: ProcessRow[] = [];
	for (const raw of text.split("\n")) {
		if (raw.trim().length === 0) continue;
		const match = ROW.exec(raw);
		// An unreadable row is a hole in the oracle exactly like a missing binary:
		// silently skipping it is how a process becomes "absent".
		if (!match?.groups) throw new ProcessTableError(`unparseable ps row: ${JSON.stringify(raw)}`);
		rows.push({
			pid: Number(match.groups.pid),
			ppid: Number(match.groups.ppid),
			pgid: Number(match.groups.pgid),
			stat: match.groups.stat,
			command: match.groups.command,
			raw,
		});
	}
	// The table always contains launchd and this process. Zero rows means the
	// call did not do what it says, not that the machine is empty.
	if (rows.length === 0) throw new ProcessTableError("ps -A returned no rows at all");
	return rows;
}

/** The row for `pid`, live or defunct, or `undefined` if the kernel has none. */
export function rowFor(pid: number, rows: ProcessRow[] = psRows()): ProcessRow | undefined {
	return rows.find((row) => row.pid === pid);
}

/** A process that has exited and not yet been reaped: present in the table, not running. */
export function isZombie(row: ProcessRow): boolean {
	return row.stat.includes("Z");
}

/**
 * Every row carrying `pgid`, INCLUDING zombies.
 *
 * Exported for diagnostics and for tests of {@link liveGroupMembers} itself. An
 * assertion about a teardown must use the live form; this one exists so a
 * failure message can say "the group is empty of live members but still holds a
 * defunct leader", which is a different bug from "the kill never happened".
 */
export function groupMembers(pgid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	return rows.filter((row) => row.pgid === pgid);
}

/**
 * Every row carrying `pgid` that is still RUNNING.
 *
 * The `Z` filter is the whole point — see (2) at the top of this file. Without
 * it, "the group is gone" is false for as long as the spawner has not reaped,
 * and a suite that waits for the unfiltered set to empty is waiting on the
 * daemon's libuv, not on the kill.
 */
export function liveGroupMembers(pgid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	return groupMembers(pgid, rows).filter((row) => !isZombie(row));
}

/**
 * Every transitive child of `pid`, by walking `ppid`.
 *
 * Sound as a SCOPE for a negative because `detached: true` does not reparent on
 * darwin: a detached child gets its own session and `pgid == pid` but keeps
 * `ppid = spawner`. So "the daemon's descendants" is the set of processes the
 * daemon is responsible for, and asking whether one of them matches a marker is
 * a question about this run — unlike scanning a table that already holds ~1100
 * processes belonging to other agents.
 *
 * Zombies are INCLUDED: a defunct child is still something this pid produced,
 * and dropping it would make "nothing was started" true one instant after a
 * child exited.
 */
export function descendantsOf(pid: number, rows: ProcessRow[] = psRows()): ProcessRow[] {
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const siblings = byParent.get(row.ppid);
		if (siblings) siblings.push(row);
		else byParent.set(row.ppid, [row]);
	}
	const found: ProcessRow[] = [];
	const seen = new Set<number>([pid]);
	const queue = [pid];
	while (queue.length > 0) {
		for (const child of byParent.get(queue.shift() as number) ?? []) {
			// pid 0/1 self-parenting and pid reuse could otherwise loop forever.
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			found.push(child);
			queue.push(child.pid);
		}
	}
	return found;
}

/**
 * Whether `pid` names a RUNNING process.
 *
 * Replaces `kill(pid, 0)`, which succeeds on a zombie: a signal may be sent to a
 * process that has already exited and not been reaped, so the classic helper
 * answers "alive" for a process that is dead by every definition a teardown test
 * cares about. This reads `stat=` and treats `Z` as dead.
 *
 * A pid with no row at all is dead too — that is the ordinary end state.
 */
export function isProcessAlive(pid: number, rows: ProcessRow[] = psRows()): boolean {
	const row = rowFor(pid, rows);
	return row !== undefined && !isZombie(row);
}

/** Wait until every pid is gone or defunct. Returns the rows that outlived the wait. */
export async function waitForProcessesGone(pids: readonly number[], timeoutMs = 30_000): Promise<void> {
	await waitForTable(
		(rows) => pids.every((pid) => !isProcessAlive(pid, rows)),
		() => `pids ${pids.join(", ")} to stop running`,
		timeoutMs,
	);
}

/** Wait until no member of `pgid` is still running. Zombies do not count. */
export async function waitForGroupGone(pgid: number, timeoutMs = 30_000): Promise<void> {
	await waitForTable(
		(rows) => liveGroupMembers(pgid, rows).length === 0,
		(rows) => `process group ${pgid} to stop running (still: ${describeRows(liveGroupMembers(pgid, rows))})`,
		timeoutMs,
	);
}

async function waitForTable(
	done: (rows: ProcessRow[]) => boolean,
	what: (rows: ProcessRow[]) => string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let rows = psRows();
	for (;;) {
		if (done(rows)) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what(rows)}`);
		await Bun.sleep(50);
		rows = psRows();
	}
}

/** A one-line rendering for failure messages. */
export function describeRows(rows: readonly ProcessRow[]): string {
	if (rows.length === 0) return "(none)";
	return rows.map((row) => `${row.pid} [${row.stat}] ${row.command}`).join(" | ");
}

/**
 * What `ps -Eww` could see of a process's environment — or an explicit statement
 * that it could see none.
 *
 * There is deliberately no third answer, and in particular no empty map: an
 * empty map is indistinguishable from "this binary is SIP-protected and the
 * platform will never show you its environment", and a caller reading absence
 * out of that has proved nothing at all.
 */
export type ProcessEnvironment =
	| { visible: true; env: Map<string, string>; raw: string }
	| { visible: false; reason: string; raw: string };

/** `NAME=` at the start of a token: the only shape a variable can take. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The environment `ps -Eww -o command= -p <pid>` attributes to `pid`.
 *
 * macOS appends the environment to the argv with no delimiter between them, so
 * the split is a heuristic and is stated here rather than hidden: a token is the
 * start of a variable when it matches `NAME=`, and any token that does not is a
 * continuation of the previous variable's value (values legitimately contain
 * spaces — `DRAHT_STUB_TOOL_CALLS` is a JSON document). Tokens before the first
 * assignment are argv. The one input that would fool it is an argv element that
 * itself looks like `NAME=value`; no argv this phase builds has one, and a
 * caller that adds one gets a variable it can see and ignore, not a missed
 * absence.
 *
 * Throws when the pid has no row: "the process is gone" must never be readable
 * as "the process has a clean environment".
 */
export function envOf(pid: number): ProcessEnvironment {
	const out = Bun.spawnSync(["ps", "-Eww", "-o", "command=", "-p", String(pid)]);
	const raw = out.stdout.toString();
	if (!out.success || raw.trim().length === 0) {
		throw new ProcessTableError(
			`ps -E found no process ${pid} (exit ${out.exitCode}): ${out.stderr.toString().trim()}`,
		);
	}

	const env = new Map<string, string>();
	let current: string | undefined;
	for (const token of raw.trim().split(/\s+/)) {
		if (ASSIGNMENT.test(token)) {
			const split = token.indexOf("=");
			current = token.slice(0, split);
			env.set(current, token.slice(split + 1));
		} else if (current !== undefined) {
			env.set(current, `${env.get(current)} ${token}`);
		}
	}

	if (env.size === 0) {
		return {
			visible: false,
			// Both halves are said, because the caller must not pick one: a SIP
			// platform binary and a process with no environment at all produce
			// byte-identical output here.
			reason:
				`ps -E showed no environment for pid ${pid}. On this platform that means either a SIP-protected ` +
				"platform binary (/bin/sh, /bin/bash, /bin/sleep — argv only, zero environment bytes) or a process " +
				"with a genuinely empty environment. These are indistinguishable from outside, so no absence may be " +
				"concluded from this result",
			raw,
		};
	}
	return { visible: true, env, raw };
}

/** A name the harness DID declare, used to prove the oracle can see anything at all. */
export interface PositiveControl {
	name: string;
	/** Optional: also require this exact value, so a same-named empty variable does not pass. */
	value?: string;
}

/**
 * Assert that none of `canaries` reached `pid`'s environment — but only after
 * proving the environment can be read at all.
 *
 * `positiveControl` names something the spawner DECLARED. If it is not visible
 * in the same `ps` output, this throws instead of reporting an absence: an
 * oracle that cannot see a variable that IS there cannot testify that another
 * one is not. That rule is what stops the grandchild-environment canary from
 * passing forever while proving nothing.
 *
 * `canaries` may be names or a `name → value` table. Given values, the VALUES
 * are also searched in the raw bytes, which catches a leak that arrived under a
 * different name — the case a name-only check cannot see.
 *
 * Returns the visible environment so the caller can go on to make positive
 * assertions about it.
 */
export function assertEnvAbsent(
	pid: number,
	canaries: readonly string[] | Record<string, string>,
	positiveControl: PositiveControl,
): Map<string, string> {
	const seen = envOf(pid);
	if (!seen.visible) throw new EnvironmentNotVisibleError(seen.reason);

	const control = seen.env.get(positiveControl.name);
	if (control === undefined) {
		throw new PositiveControlMissingError(
			`the positive control ${positiveControl.name} is not visible in pid ${pid}'s environment, so nothing ` +
				`can be concluded about what is absent from it. Saw: ${[...seen.env.keys()].sort().join(", ")}`,
		);
	}
	if (positiveControl.value !== undefined && control !== positiveControl.value) {
		throw new PositiveControlMissingError(
			`the positive control ${positiveControl.name} reads ${JSON.stringify(control)} in pid ${pid}, not ` +
				`${JSON.stringify(positiveControl.value)}, so this ps output is not describing the process under test`,
		);
	}

	const names = Array.isArray(canaries) ? canaries : Object.keys(canaries);
	for (const name of names) {
		if (seen.env.has(name)) {
			throw new Error(`pid ${pid} carries ${name}=${JSON.stringify(seen.env.get(name))}, which never crossed`);
		}
	}
	if (!Array.isArray(canaries)) {
		for (const [name, value] of Object.entries(canaries as Record<string, string>)) {
			// Length-guarded: an empty or one-character canary value would match
			// every process on the machine and make this assertion noise.
			if (value.length >= 8 && seen.raw.includes(value)) {
				throw new Error(`pid ${pid}'s environment contains the value planted as ${name}: ${JSON.stringify(value)}`);
			}
		}
	}
	return seen.env;
}

/**
 * SIGKILL whole process GROUPS this run recorded, for `afterAll`.
 *
 * Groups, because a spawned session's grandchildren are its tools and signalling
 * the one pid a handle names leaves them running. Recorded pgids ONLY — never
 * `pkill -f` on a pattern: several agents run draht e2es on this machine at once
 * and a generic pattern reaps their sessions along with this run's.
 *
 * Every failure is swallowed on purpose: by teardown the usual outcome is ESRCH
 * because the group already died, and a teardown that throws hides the assertion
 * failure that brought it there.
 */
export function reapPgids(pgids: Iterable<number>): void {
	for (const pgid of pgids) {
		if (!Number.isInteger(pgid) || pgid <= 1) continue;
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Already gone, or never existed.
		}
	}
}

/**
 * A string no other process on this machine can be carrying.
 *
 * Any scan for a literal — a grandchild's argv, a tripwire's contents — is a
 * scan of a table shared with every other agent on this box, and a marker like
 * `trap-grandchild` matches a sibling agent's leftovers as readily as this run's
 * child. pid + wall clock + 48 random bits makes a collision impossible in
 * practice and makes a stale match from a previous run of the SAME file
 * impossible by construction.
 */
export function uniqueMarker(label: string): string {
	return `${label}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}
